import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { authQueryOptions } from "#/lib/auth/queries.ts";
import { requireHostKind } from "#/lib/host.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

/**
 * The _staff layout protects every child route (e.g. _staff/_app/*): the app host, a signed-in
 * user, and a firm. The firm check is `firm.get`, which also warms the query the pages read.
 */
export const Route = createFileRoute("/_staff")({
  component: Outlet,
  beforeLoad: async ({ context }) => {
    requireHostKind(context.host, "app");

    /**
     * beforeLoad runs on every navigation and prefetch, so we use TanStack Query for client-side
     * caching. This is NOT a server-side security guarantee: every tRPC procedure checks the
     * session and membership itself (see `packages/api/src/trpc/init.ts`).
     */
    const user = await context.queryClient.query({ ...authQueryOptions(), staleTime: "static" });
    void context.queryClient.query(authQueryOptions());
    if (!user) throw redirect({ to: "/login" });

    try {
      await context.queryClient.query(context.trpc.firm.get.queryOptions());
    } catch (error) {
      // Signed in but no firm yet: finish signing up.
      if (trpcErrorInfo(error).domainCode === "member.no_firm")
        throw redirect({ to: "/onboarding" });
      throw error;
    }
  },
});
