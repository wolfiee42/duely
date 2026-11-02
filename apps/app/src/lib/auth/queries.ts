import { queryOptions } from "@tanstack/react-query";

import { $getUser } from "./functions.ts";

/**
 * Shared by the route guards (_guest, _staff, onboarding) so the signed-in user is fetched once
 * and cached by TanStack Query.
 */
export const authQueryOptions = () =>
  queryOptions({
    queryKey: ["auth"],
    queryFn: ({ signal }) => $getUser({ signal }),
  });
