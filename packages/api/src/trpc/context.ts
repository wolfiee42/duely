import { createAuth } from "@repo/auth/auth";

import type { WithDb } from "../db";
import type { HostContext } from "../host/host";
import type { AppConfig, Services } from "../services";

export interface AuthConfig {
  baseURL: string;
  secret: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface StaffContext {
  requestId: string;
  host: HostContext;
  withDb: WithDb;
  /** `duely_system`. Only the demo controls use it, to run the scheduler on demand. */
  withSystemDb: WithDb;
  services: Services;
  config: AppConfig;
  /** Resolved at most once per request. `null` when there is no valid staff session. */
  getSession(): Promise<SessionUser | null>;
}

export interface StaffContextDeps {
  withDb: WithDb;
  withSystemDb: WithDb;
  auth: AuthConfig;
  services: Services;
  config: AppConfig;
}

export interface StaffContextInput {
  /** Carries the session cookie. */
  headers: Headers;
  host: HostContext;
  requestId: string;
}

/** Shared by the Hono transport and the in-process SSR caller (D21), so both behave identically. */
export function createStaffContext(
  { withDb, withSystemDb, auth, services, config }: StaffContextDeps,
  { headers, host, requestId }: StaffContextInput,
): StaffContext {
  let session: Promise<SessionUser | null> | undefined;
  return {
    requestId,
    host,
    withDb,
    withSystemDb,
    services,
    config,
    getSession() {
      session ??= withDb(async (db) => {
        const result = await createAuth({ db, ...auth }).api.getSession({ headers });
        return result
          ? { id: result.user.id, email: result.user.email, name: result.user.name }
          : null;
      });
      return session;
    },
  };
}
