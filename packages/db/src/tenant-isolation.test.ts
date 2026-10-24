import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  createDb,
  firmSlugExists,
  resolveMembership,
  resolveTenantByHost,
  withTenant,
  type Db,
} from "./index";
import { auditLog, firmDomains, firms, idempotencyKeys, members, user } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT_TABLES = [
  "firms",
  "members",
  "firm_domains",
  "audit_log",
  "idempotency_keys",
  "member_invites",
];

let testDb: TestDatabase;
let app: Db;
let system: Db;
const closers: Array<() => Promise<unknown>> = [];

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function pgError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { message: string; cause?: { message: string } };
    return e.cause?.message ?? e.message;
  }
  return null;
}

const count = async (db: Db, table: string) =>
  (await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))[0]!.n;

async function seedFirm(id: string, slug: string) {
  const userId = `user-${slug}`;
  await app.insert(user).values({ id: userId, name: slug, email: `${slug}@example.com` });
  await withTenant(app, id, async (tx) => {
    await tx
      .insert(firms)
      .values({ id, platformSlug: slug, legalName: `${slug} LLC`, displayName: slug });
    await tx
      .insert(members)
      .values({ tenantId: id, userId, email: `${slug}@example.com`, role: "owner" });
    await tx.insert(auditLog).values({
      tenantId: id,
      actorType: "system",
      action: "firm.created",
      entityType: "firm",
      entityId: id,
    });
    await tx
      .insert(idempotencyKeys)
      .values({ tenantId: id, key: crypto.randomUUID(), procedure: "x" });
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const a = createDb(testDb.appUrl, { max: 10 });
  const s = createDb(testDb.systemUrl);
  app = a.db;
  system = s.db;
  closers.push(a.close, s.close);
  await seedFirm(A, "acme");
  await seedFirm(B, "globex");
}, 60_000);

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await testDb?.drop();
});

describe("fail closed", () => {
  it("returns nothing from any tenant table when no tenant is set", async () => {
    for (const table of TENANT_TABLES) expect(await count(app, table)).toBe(0);
  });

  it("applies to the table owner too (FORCE ROW LEVEL SECURITY)", async () => {
    const { db: owner, close } = createDb(testDb.ownerUrl);
    try {
      for (const table of TENANT_TABLES) expect(await count(owner, table)).toBe(0);
    } finally {
      await close();
    }
  });

  it("treats an empty tenant setting as no tenant", async () => {
    const rows = await app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
      return tx.select().from(firms);
    });
    expect(rows).toEqual([]);
  });

  it("rejects a tenant id that is not a uuid", () => {
    expect(() => withTenant(app, "x'; drop table firms; --", async () => 1)).toThrow(/uuid/);
  });
});

describe("cross-tenant access", () => {
  it("only reads the current tenant's rows", async () => {
    const seen = await withTenant(app, A, async (tx) => ({
      firms: await tx.select({ id: firms.id }).from(firms),
      members: await tx.select({ tenantId: members.tenantId }).from(members),
      audit: await tx.select({ tenantId: auditLog.tenantId }).from(auditLog),
    }));
    expect(seen.firms.map((f) => f.id)).toEqual([A]);
    expect(seen.members.map((m) => m.tenantId)).toEqual([A]);
    expect(seen.audit.map((a) => a.tenantId)).toEqual([A]);
  });

  it("cannot fetch another tenant's row by crafted id", async () => {
    const rows = await withTenant(app, A, (tx) =>
      tx.execute(sql`select * from firms where id = ${B}`),
    );
    expect(rows.length).toBe(0);
  });

  it("cannot insert a row for another tenant (WITH CHECK)", async () => {
    const message = await pgError(
      withTenant(app, A, (tx) =>
        tx
          .insert(members)
          .values({ tenantId: B, userId: "user-acme", email: "x@example.com", role: "member" }),
      ),
    );
    expect(message).toMatch(/row-level security/);
  });

  it("cannot move a row to another tenant", async () => {
    const message = await pgError(
      withTenant(app, A, (tx) => tx.execute(sql`update members set tenant_id = ${B}`)),
    );
    expect(message).toMatch(/row-level security/);
  });

  it("updates and deletes affect zero rows of another tenant", async () => {
    const result = await withTenant(app, A, async (tx) => {
      const updated = await tx.execute(
        sql`update firms set display_name = 'hacked' where id = ${B} returning id`,
      );
      const deleted = await tx.execute(
        sql`delete from members where tenant_id = ${B} returning id`,
      );
      return { updated: updated.length, deleted: deleted.length };
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
    const still = await withTenant(app, B, (tx) =>
      tx.select({ name: firms.displayName }).from(firms),
    );
    expect(still).toEqual([{ name: "globex" }]);
  });
});

describe("tenant context does not leak", () => {
  it("is gone after the transaction, on a reused pooled connection", async () => {
    await withTenant(app, A, (tx) => tx.select().from(firms));
    // Many plain queries so every pooled connection is exercised.
    const counts = await Promise.all(Array.from({ length: 30 }, () => count(app, "firms")));
    expect(counts.every((n) => n === 0)).toBe(true);
  });

  it("is gone after a transaction that throws", async () => {
    await withTenant(app, A, async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    const counts = await Promise.all(Array.from({ length: 30 }, () => count(app, "firms")));
    expect(counts.every((n) => n === 0)).toBe(true);
  });

  it("keeps concurrent requests for different tenants apart", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const tenant = i % 2 === 0 ? A : B;
        return withTenant(app, tenant, async (tx) => {
          await tx.execute(sql`select pg_sleep(0.05)`);
          const rows = await tx.select({ tenantId: members.tenantId }).from(members);
          return { tenant, tenants: new Set(rows.map((r) => r.tenantId)) };
        });
      }),
    );
    for (const { tenant, tenants } of results) expect([...tenants]).toEqual([tenant]);
  });
});

describe("roles", () => {
  it("audit_log is append-only for the app role", async () => {
    const update = await pgError(
      withTenant(app, A, (tx) => tx.execute(sql`update audit_log set action = 'x'`)),
    );
    const del = await pgError(withTenant(app, A, (tx) => tx.execute(sql`delete from audit_log`)));
    expect(update).toMatch(/permission denied/);
    expect(del).toMatch(/permission denied/);
  });

  it("the app role cannot assume the system role", async () => {
    expect(await pgError(app.execute(sql`set role duely_system`))).toMatch(/permission denied/);
  });

  it("the system role bypasses RLS, then drops into one tenant (D4)", async () => {
    expect(await count(system, "firms")).toBe(2);
    const scoped = await system.transaction(async (tx) => {
      await tx.execute(sql`set local role duely_app`);
      await tx.execute(sql`select set_config('app.tenant_id', ${B}, true)`);
      return tx.select({ id: firms.id }).from(firms);
    });
    expect(scoped.map((f) => f.id)).toEqual([B]);
  });

  it("only demo firms may carry a clock offset (FR-14.7)", async () => {
    const message = await pgError(
      withTenant(app, A, (tx) => tx.execute(sql`update firms set clock_offset_seconds = 60`)),
    );
    expect(message).toMatch(/firms_clock_offset_demo_only/);
  });
});

describe("pre-tenant resolvers", () => {
  beforeAll(async () => {
    await withTenant(app, A, (tx) =>
      tx.insert(firmDomains).values([
        { tenantId: A, hostname: "Billing.Acme.test", status: "active" },
        { tenantId: A, hostname: "pending.acme.test", status: "pending" },
      ]),
    );
  });

  it("resolves a platform subdomain", async () => {
    expect(await resolveTenantByHost(app, "acme.duely.app", "duely.app")).toEqual({
      tenantId: A,
      source: "platform",
    });
    expect(await resolveTenantByHost(app, "globex.localhost", "localhost")).toEqual({
      tenantId: B,
      source: "platform",
    });
  });

  it("does not resolve an unknown slug or the wrong root", async () => {
    expect(await resolveTenantByHost(app, "nobody.duely.app", "duely.app")).toBeNull();
    expect(await resolveTenantByHost(app, "acme.duely.app", "localhost")).toBeNull();
    expect(await resolveTenantByHost(app, "duely.app", "duely.app")).toBeNull();
  });

  it("resolves an active custom domain case-insensitively, but not a pending one", async () => {
    expect(await resolveTenantByHost(app, "billing.acme.test", "duely.app")).toEqual({
      tenantId: A,
      source: "custom",
    });
    expect(await resolveTenantByHost(app, "pending.acme.test", "duely.app")).toBeNull();
  });

  it("finds a user's membership and nothing for a stranger", async () => {
    const m = await resolveMembership(app, "user-globex");
    expect(m).toMatchObject({ tenantId: B, role: "owner" });
    expect(await resolveMembership(app, "user-nobody")).toBeNull();
  });

  it("reports whether a slug is taken", async () => {
    expect(await firmSlugExists(app, "acme")).toBe(true);
    expect(await firmSlugExists(app, "free-slug")).toBe(false);
  });
});
