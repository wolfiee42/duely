import type { WithDb } from "../db";
import type { HostContext } from "../host/host";
import type { AppConfig, Services } from "../services";
import { loadSession, type PortalIdentity } from "../usecases/portal-auth";

export const PORTAL_COOKIE = "duely_portal";

export interface PortalContext {
  requestId: string;
  host: HostContext;
  withDb: WithDb;
  services: Services;
  config: AppConfig;
  /** For per-IP rate limits. Taken from the platform's connecting-IP header, never from the client body. */
  ip: string;
  /** Resolved at most once per request. `null` without a valid portal session for THIS host's tenant. */
  getIdentity(): Promise<PortalIdentity | null>;
  /** The raw session cookie value, for logout. */
  sessionToken: string | null;
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function createPortalContext(
  deps: { withDb: WithDb; services: Services; config: AppConfig },
  input: { headers: Headers; host: HostContext; requestId: string },
): PortalContext {
  const sessionToken = readCookie(input.headers.get("cookie"), PORTAL_COOKIE);
  let identity: Promise<PortalIdentity | null> | undefined;
  return {
    requestId: input.requestId,
    host: input.host,
    withDb: deps.withDb,
    services: deps.services,
    config: deps.config,
    ip: input.headers.get("cf-connecting-ip") ?? "unknown",
    sessionToken,
    getIdentity() {
      // The tenant comes from the host, and the session is looked up inside it: a session issued by
      // another firm's host cannot match (SPEC 6.3).
      identity ??=
        sessionToken && input.host.tenantId
          ? deps.withDb((db) => loadSession(db, input.host.tenantId!, sessionToken))
          : Promise.resolve(null);
      return identity;
    },
  };
}
