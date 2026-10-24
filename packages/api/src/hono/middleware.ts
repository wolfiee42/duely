import type { MiddlewareHandler } from "hono";

import type { WithDb } from "../db";
import { resolveHostContext, type HostContext, type HostKind } from "../host/host";

export interface AppVariables {
  requestId: string;
  host: HostContext;
}

export type AppEnv = { Variables: AppVariables };

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("x-request-id", id);
};

/** Classifies the request host and resolves the tenant for portal hosts. Unknown hosts get a bare 404. */
export const hostScope =
  (platformDomain: string, withDb: WithDb): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const host = await resolveHostContext(new URL(c.req.url).host, platformDomain, withDb);
    if (!host) return c.text("Not Found", 404);
    c.set("host", host);
    await next();
  };

/** 404, not 403: a wrong-kind host must not reveal that the route exists (SPEC 1.4). */
export const requireHostKind =
  (kind: HostKind): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (c.var.host.hostKind !== kind) return c.text("Not Found", 404);
    await next();
  };
