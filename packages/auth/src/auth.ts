import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Db } from "@repo/db";
import * as schema from "@repo/db/schema";
import { betterAuth } from "better-auth/minimal";

export interface AuthConfig {
  /** A per-request client (SPEC 9.1); never keep the returned instance at module scope. */
  db: Db;
  /** Public origin of the app host. Cookies are host-only on it and never sent to tenant hosts (D20). */
  baseURL: string;
  secret: string;
}

export function createAuth({ db, baseURL, secret }: AuthConfig) {
  return betterAuth({
    baseURL,
    secret,
    telemetry: {
      enabled: false,
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),

    // https://better-auth.com/docs/concepts/session-management#session-caching
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },

    // D9: email and password only for v1.
    // https://better-auth.com/docs/authentication/email-password
    emailAndPassword: {
      enabled: true,
    },

    advanced: {
      database: {
        // https://better-auth.com/docs/adapters/drizzle#joins
        joins: true,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
