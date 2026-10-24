import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { GalleryVerticalEndIcon } from "lucide-react";

import { authQueryOptions } from "#/lib/auth/queries.ts";
import { requireHostKind } from "#/lib/host.ts";

export const Route = createFileRoute("/_guest")({
  component: RouteComponent,
  beforeLoad: async ({ context }) => {
    requireHostKind(context.host, "app");

    // Redirect path when user is already present,
    // or after successful login/signup
    const REDIRECT_URL = "/app";

    const user = await context.queryClient.query({
      ...authQueryOptions(),
      staleTime: "static",
    });
    void context.queryClient.query(authQueryOptions());

    if (user) {
      throw redirect({
        to: REDIRECT_URL,
      });
    }

    return {
      redirectUrl: REDIRECT_URL,
    };
  },
});

function RouteComponent() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="mx-auto flex items-center gap-2 font-semibold tracking-tight">
          <GalleryVerticalEndIcon className="size-6" aria-hidden="true" />
          Duely
        </div>
        <Outlet />
      </div>
    </div>
  );
}
