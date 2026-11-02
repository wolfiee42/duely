import { resolveHostContext } from "@repo/api";
import { createStaffContext, staffRouter, type StaffRouter } from "@repo/api/trpc";
import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import {
  authConfig,
  config,
  platformDomain,
  services,
  withDb,
  withSystemDb,
} from "#/lib/server/runtime.ts";

// D21: on the server the router runs in-process (no self-HTTP on Workers); in the browser it is
// batched HTTP to Hono. Both build the same context, so behavior matches.
export const createStaffTrpc = createIsomorphicFn()
  .server((queryClient: QueryClient) =>
    createTRPCOptionsProxy<StaffRouter>({
      router: staffRouter,
      queryClient,
      ctx: async () => {
        const request = getRequest();
        const host = await resolveHostContext(new URL(request.url).host, platformDomain, withDb);
        return {
          ...createStaffContext(
            { withDb, withSystemDb, auth: authConfig, services, config },
            // Start's host middleware already 404s unknown hosts, so `host` is set here.
            { headers: request.headers, host: host!, requestId: crypto.randomUUID() },
          ),
        };
      },
    }),
  )
  .client((queryClient: QueryClient) =>
    createTRPCOptionsProxy<StaffRouter>({
      client: createTRPCClient<StaffRouter>({
        links: [httpBatchLink({ url: "/api/trpc/staff" })],
      }),
      queryClient,
    }),
  );

export type StaffTrpc = ReturnType<typeof createStaffTrpc>;
