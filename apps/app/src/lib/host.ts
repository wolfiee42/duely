import { resolveHostContext, type HostKind } from "@repo/api";
import { notFound } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { platformDomain, withDb } from "#/lib/server/runtime.ts";

/** Classifies the host and resolves the tenant for portal hosts. Unknown hosts get a bare 404. */
export const hostMiddleware = createMiddleware().server(async ({ next, request }) => {
  const host = await resolveHostContext(new URL(request.url).host, platformDomain, withDb);
  if (!host) return new Response("Not Found", { status: 404 });
  return next({ context: { host } });
});

/** What routes know about the host. Read once through the root route (see `__root.tsx`). */
export const $getHostContext = createServerFn()
  .middleware([hostMiddleware])
  .handler(({ context }) => {
    const url = new URL(getRequest().url);
    const rootHost = url.port ? `${platformDomain}:${url.port}` : platformDomain;
    return {
      ...context.host,
      /** The platform root with the port, e.g. `duely.app` or `localhost:3000`. */
      rootHost,
      appOrigin: `${url.protocol}//app.${rootHost}`,
    };
  });

export type HostInfo = Awaited<ReturnType<typeof $getHostContext>>;

/**
 * Route-group guard for `beforeLoad`. 404, never a redirect, so a wrong-kind host learns nothing.
 * The host comes from the server (route context), because `beforeLoad` also runs in the browser.
 */
export function requireHostKind(host: { hostKind: HostKind }, kind: HostKind) {
  if (host.hostKind !== kind) throw notFound();
}
