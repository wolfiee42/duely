import { createAuth } from "@repo/auth/auth";
import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";

import { hostMiddleware } from "#/lib/host.ts";
import { authConfig, withDb } from "#/lib/server/runtime.ts";

/**
 * Meant to be called via authQueryOptions() in queries.ts, which the _guest, _staff and onboarding
 * routes use as their guard. It is a UX guard only; tRPC procedures enforce auth themselves.
 */
export const $getUser = createServerFn({ method: "GET" })
  .middleware([hostMiddleware])
  .handler(({ context }) => {
    // A staff session is never accepted off the app host (FR-1.7).
    if (context.host.hostKind !== "app") return null;
    const { headers } = getRequest();
    return withDb(async (db) => {
      const session = await createAuth({ db, ...authConfig }).api.getSession({
        headers,
        returnHeaders: true,
      });
      // Forward any Set-Cookie headers to the client, e.g. for session/cache refresh
      const cookies = session.headers?.getSetCookie();
      if (cookies?.length) appendResponseHeader("Set-Cookie", cookies);
      return session.response?.user ?? null;
    });
  });
