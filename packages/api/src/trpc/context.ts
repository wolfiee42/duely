import { createAuth } from "@repo/auth/auth";

import type { WithDb } from "../db";
import type { HostContext } from "../host/host";

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
  /** Resolved at most once per request. `null` when there is no valid staff session. */
  getSession(): Promise<SessionUser | null>;
}

export interface StaffContextDeps {
  withDb: WithDb;
  auth: AuthConfig;
}

export interface StaffContextInput {
  /** Carries the session cookie. */
  headers: Headers;
  host: HostContext;
  requestId: string;
}

/** Shared by the Hono transport and the in-process SSR caller (D21), so both behave identically. */
export function createStaffContext(
  { withDb, auth }: StaffContextDeps,
  { headers, host, requestId }: StaffContextInput,
): StaffContext {
  let session: Promise<SessionUser | null> | undefined;
  return {
    requestId,
    host,
    withDb,
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
