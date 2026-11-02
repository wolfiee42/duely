import { Button } from "@repo/ui/components/button";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";

import { requireHostKind } from "#/lib/host.ts";

// Everything under /portal belongs to a client portal host (SPEC 1.4); any other host gets a 404.
export const Route = createFileRoute("/portal")({
  beforeLoad: ({ context }) => requireHostKind(context.host, "portal"),
  loader: ({ context }) =>
    context.queryClient.query({
      ...context.portalTrpc.auth.me.queryOptions(),
      staleTime: "static",
    }),
  component: PortalLayout,
});

function PortalLayout() {
  const { portalTrpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useSuspenseQuery(portalTrpc.auth.me.queryOptions());
  const logout = useMutation(
    portalTrpc.auth.logout.mutationOptions({
      onSuccess: async () => {
        queryClient.clear();
        await navigate({ to: "/portal/login" });
      },
    }),
  );

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 px-4 py-6">
      {/* First stop for keyboard and screen-reader users: skip the header and go to the page. */}
      <a
        href="#main-content"
        className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <header
        className="flex items-center justify-between gap-2 border-b pb-4"
        style={{ borderColor: me.firm?.brandPrimary }}
      >
        <Link to="/portal" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          {me.firm?.hasLogo && <img src="/api/logo" alt="" className="h-8 w-auto" />}
          {me.firm?.displayName}
        </Link>
        {me.contact && (
          <nav aria-label="Portal" className="flex items-center gap-2 text-sm">
            <Link to="/portal/receipts" className="underline underline-offset-4">
              Receipts
            </Link>
            <Button variant="outline" size="sm" onClick={() => logout.mutate()}>
              Sign out
            </Button>
          </nav>
        )}
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none">
        <Outlet />
      </main>
    </div>
  );
}
