import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { DefaultCatchBoundary } from "#/components/default-catch-boundary.tsx";
import { DefaultNotFound } from "#/components/default-not-found.tsx";
import { PageSkeleton } from "#/components/ui-bits.tsx";

import { createPortalTrpc } from "./lib/trpc/portal.ts";
import { createStaffTrpc } from "./lib/trpc/staff.ts";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 1000 * 60 * 2, // 2 minutes
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: {
      queryClient,
      trpc: createStaffTrpc(queryClient),
      portalTrpc: createPortalTrpc(queryClient),
    },
    defaultPreload: "intent",
    // react-query will handle data fetching & caching
    // https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#passing-all-loader-events-to-an-external-cache
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PageSkeleton,
    defaultPendingMs: 300,
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: DefaultNotFound,
    scrollRestoration: true,
    defaultStructuralSharing: true,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    handleRedirects: true,
    wrapQueryClient: true,
  });

  return router;
}
