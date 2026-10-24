import { trpcServer } from "@hono/trpc-server";
import { createAuth } from "@repo/auth/auth";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import type { WithDb } from "../db";
import type { AppConfig, Services } from "../services";
import { createStaffContext, staffRouter, type AuthConfig } from "../trpc";
import { createPortalContext } from "../trpc/portal-context";
import { portalRouter } from "../trpc/routers/portal";
import { fileRoutes } from "./files";
import { hostScope, requestId, requireHostKind, type AppEnv } from "./middleware";
import { portalRoutes } from "./portal";
import { webhookRoutes } from "./webhooks";

export interface AppDeps {
  withDb: WithDb;
  /** `duely_system`: webhook ingress only (D4). Never used for a request that has a tenant context. */
  withSystemDb: WithDb;
  auth: AuthConfig;
  services: Services;
  config: AppConfig;
}

export function createApp(deps: AppDeps) {
  // Middleware order (SPEC 6.4): request id, host scope, then route-level guards.
  const app = new Hono<AppEnv>()
    .basePath("/api")
    .use(requestId)
    .use(hostScope(deps.config.platformDomain, deps.withDb));

  app.get("/health", async (c) => {
    const rows = await deps.withDb((db) => db.execute<{ ok: number }>(sql`select 1 as ok`));
    return c.json({ ok: rows[0]?.ok === 1 });
  });

  // Staff auth lives on the app host only; the cookie is host-only there (D9, D20).
  app.on(["GET", "POST"], "/auth/*", requireHostKind("app"), (c) =>
    deps.withDb((db) => createAuth({ db, ...deps.auth }).handler(c.req.raw)),
  );

  app.route("/", fileRoutes({ withDb: deps.withDb, files: deps.services.files, auth: deps.auth }));

  app.route(
    "/",
    webhookRoutes({
      withSystemDb: deps.withSystemDb,
      queue: deps.services.queue,
      config: deps.config,
    }),
  );
  app.route("/", portalRoutes({ withDb: deps.withDb }));

  app.use(
    "/trpc/portal/*",
    requireHostKind("portal"),
    trpcServer({
      router: portalRouter,
      endpoint: "/api/trpc/portal",
      createContext: (_opts, c) => ({
        ...createPortalContext(deps, {
          headers: c.req.raw.headers,
          host: c.get("host"),
          requestId: c.get("requestId"),
        }),
      }),
    }),
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
