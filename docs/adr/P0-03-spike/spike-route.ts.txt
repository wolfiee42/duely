// P0-03 spike only. Not part of the app; archived under docs/adr/P0-03-spike/.
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const labelsOf = (rows: { tenant_id: string; label: string }[]) => ({
  count: rows.length,
  tenants: [...new Set(rows.map((r) => r.tenant_id))],
});

export const Route = createFileRoute("/api/spike")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode") ?? "tenant";
        const tenant = url.searchParams.get("tenant") ?? "";
        const delay = Number(url.searchParams.get("delay") ?? 0);

        // Per request, never at module scope (SPEC 9.1).
        const binding = mode === "system" ? env.HYPERDRIVE_SYSTEM : env.HYPERDRIVE_APP;
        const client = postgres(binding.connectionString, { max: 1, fetch_types: false });
        const db = drizzle({ client });
        const select = sql`select tenant_id, label from invoices`;

        try {
          if (mode === "notenant") {
            // No withTenant: must fail closed.
            const rows = await db.execute<{ tenant_id: string; label: string }>(select);
            return Response.json(labelsOf(rows));
          }

          if (mode === "leak") {
            // Same connection: tx for `tenant`, then a plain query outside any tx.
            const inTx = await db.transaction(async (tx) => {
              await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
              return tx.execute<{ tenant_id: string; label: string }>(select);
            });
            const after = await db.execute<{ tenant_id: string; label: string }>(select);
            const [setting] = await db.execute<{ v: string | null }>(
              sql`select current_setting('app.tenant_id', true) as v`,
            );
            return Response.json({
              inTx: labelsOf(inTx),
              after: labelsOf(after),
              setting: setting?.v,
            });
          }

          if (mode === "rollback") {
            // A failing tx must not leave context behind on the connection.
            await db
              .transaction(async (tx) => {
                await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
                throw new Error("boom");
              })
              .catch(() => undefined);
            const after = await db.execute<{ tenant_id: string; label: string }>(select);
            return Response.json({ after: labelsOf(after) });
          }

          if (mode === "system") {
            // D4: BYPASSRLS role sees everything until it assumes the app role inside a tx.
            const unscoped = await db.execute<{ tenant_id: string; label: string }>(select);
            const scoped = await db.transaction(async (tx) => {
              await tx.execute(sql`set local role duely_app`);
              await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
              return tx.execute<{ tenant_id: string; label: string }>(select);
            });
            const [who] = await db.execute<{ u: string }>(sql`select current_user as u`);
            return Response.json({
              unscoped: labelsOf(unscoped),
              scoped: labelsOf(scoped),
              user: who?.u,
            });
          }

          if (mode === "cross") {
            // WITH CHECK: writing a row for another tenant must be rejected.
            const other = url.searchParams.get("other") ?? "";
            const result = await db
              .transaction(async (tx) => {
                await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
                await tx.execute(
                  sql`insert into invoices (tenant_id, label) values (${other}, 'cross-tenant')`,
                );
                return "inserted";
              })
              .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
            return Response.json({ result });
          }

          // Default: withTenant(tenant, ...) with an optional in-tx delay to force overlap.
          const rows = await db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
            if (delay > 0) await tx.execute(sql`select pg_sleep(${delay / 1000})`);
            return tx.execute<{ tenant_id: string; label: string }>(select);
          });
          return Response.json(labelsOf(rows));
        } finally {
          await client.end();
        }
      },
    },
  },
});
