import { createAuth } from "@repo/auth/auth";
import { resolveMembership } from "@repo/db";
import type { MiddlewareHandler } from "hono";

import type { WithDb } from "../db";
import { resolveHostContext, type HostContext, type HostKind } from "../host/host";

export interface StaffIdentity {
  userId: string;
  tenantId: string;
  memberId: string;
  role: "owner" | "member";
}

export interface AppVariables {
  requestId: string;
  host: HostContext;
  staff: StaffIdentity;
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

type StaffDeps = { withDb: WithDb; auth: { baseURL: string; secret: string } };

/** Session -> membership. The tenant is always the member's, never anything in the request. */
export async function authenticateStaff(deps: StaffDeps, headers: Headers) {
  return deps.withDb(async (db) => {
    const session = await createAuth({ db, ...deps.auth }).api.getSession({ headers });
    if (!session) return "unauthenticated" as const;
    const membership = await resolveMembership(db, session.user.id);
    if (!membership) return "no_firm" as const;
    return { userId: session.user.id, ...membership } satisfies StaffIdentity;
  });
}

/** For plain Hono routes (uploads, downloads): a signed-in staff member of a firm, else 401/403. */
export const requireStaff =
  (deps: StaffDeps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const identity = await authenticateStaff(deps, c.req.raw.headers);
    if (identity === "unauthenticated") return c.json({ error: "unauthenticated" }, 401);
    if (identity === "no_firm") return c.json({ error: "no_firm" }, 403);
    c.set("staff", identity);
    await next();
  };
