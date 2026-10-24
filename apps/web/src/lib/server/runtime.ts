import { createWithDb } from "@repo/api";
import { createApp } from "@repo/api/hono";
import { env, waitUntil } from "cloudflare:workers";
import { ENV } from "varlock/env";

// The only module that touches Worker bindings. Import it from server code only.

/** A fresh database client per call, from the Hyperdrive binding (SPEC 9.1). */
export const withDb = createWithDb(() => env.HYPERDRIVE_APP.connectionString, waitUntil);

export const platformDomain = ENV.PLATFORM_DOMAIN;

/** Cookies are host-only on the app host (D20). */
export const authConfig = { baseURL: ENV.VITE_BASE_URL, secret: ENV.BETTER_AUTH_SECRET };

export const app = createApp({ platformDomain, withDb, auth: authConfig });

// Start handlers only receive `{ request }`, so build the ExecutionContext Hono needs (ADR P0-04).
export const executionContext = {
  waitUntil,
  passThroughOnException() {},
} as unknown as ExecutionContext;
export { env };
