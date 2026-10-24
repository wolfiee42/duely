import { resolveHostContext } from "@repo/api";
import { createPortalContext, portalRouter, type PortalRouter } from "@repo/api/trpc";
import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { config, platformDomain, services, withDb } from "#/lib/server/runtime.ts";

// Same shape as the staff client (D21): in-process on the server, batched HTTP in the browser.
// The portal router only answers on portal hosts, so using this on the app host fails with 403.
export const createPortalTrpc = createIsomorphicFn()
  .server((queryClient: QueryClient) =>
    createTRPCOptionsProxy<PortalRouter>({
      router: portalRouter,
      queryClient,
      ctx: async () => {
        const request = getRequest();
        const host = await resolveHostContext(new URL(request.url).host, platformDomain, withDb);
        return {
          ...createPortalContext(
            { withDb, services, config },
            { headers: request.headers, host: host!, requestId: crypto.randomUUID() },
          ),
        };
      },
    }),
  )
  .client((queryClient: QueryClient) =>
    createTRPCOptionsProxy<PortalRouter>({
      client: createTRPCClient<PortalRouter>({
        links: [httpBatchLink({ url: "/api/trpc/portal" })],
      }),
      queryClient,
    }),
  );

export type PortalTrpc = ReturnType<typeof createPortalTrpc>;
