import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import type { PortalTrpc } from "#/lib/trpc/portal.ts";

/** For portal pages that need a signed-in contact. Sends everyone else to the login page. */
export async function requirePortalContact(context: {
  queryClient: QueryClient;
  portalTrpc: PortalTrpc;
}) {
  const me = await context.queryClient.query(context.portalTrpc.auth.me.queryOptions());
  if (!me.contact) throw redirect({ to: "/portal/login" });
  return me.contact;
}
