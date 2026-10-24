import { trpcServer } from "@hono/trpc-server";
import { createAuth } from "@repo/auth/auth";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import type { WithDb } from "../db";
import { createStaffContext, staffRouter, type AuthConfig } from "../trpc";
import { hostScope, requestId, requireHostKind, type AppEnv } from "./middleware";

export interface AppDeps {
  /** `duely.app` in production, `localhost` locally. */
  platformDomain: string;
  withDb: WithDb;
  auth: AuthConfig;
}

export function createApp(deps: AppDeps) {
  // Middleware order (SPEC 6.4): request id, host scope, then route-level guards.
  const app = new Hono<AppEnv>()
    .basePath("/api")
    .use(requestId)
    .use(hostScope(deps.platformDomain, deps.withDb));

  app.get("/health", async (c) => {
    const rows = await deps.withDb((db) => db.execute<{ ok: number }>(sql`select 1 as ok`));
    return c.json({ ok: rows[0]?.ok === 1 });
  });

  // Staff auth lives on the app host only; the cookie is host-only there (D9, D20).
  app.on(["GET", "POST"], "/auth/*", requireHostKind("app"), (c) =>
    deps.withDb((db) => createAuth({ db, ...deps.auth }).handler(c.req.raw)),
  );

  app.use(
    "/trpc/staff/*",
    requireHostKind("app"),
    trpcServer({
      router: staffRouter,
      endpoint: "/api/trpc/staff",
      createContext: (_opts, c) => ({
        ...createStaffContext(deps, {
          headers: c.req.raw.headers,
          host: c.get("host"),
          requestId: c.get("requestId"),
        }),
      }),
    }),
  );

  app.onError((error, c) => {
    // No stack or message to the client; the id lets support find the log line.
    console.error(`[${c.var.requestId}]`, error);
    return c.json({ error: "internal", requestId: c.var.requestId }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
