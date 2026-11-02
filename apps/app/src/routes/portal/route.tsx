import { Button } from "@repo/ui/components/button";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";

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
    // The firm's brand colour drives buttons and accents for everything inside the portal.
    <div
      className="min-h-svh bg-background"
      style={
        me.firm?.brandPrimary
          ? ({ "--primary": me.firm.brandPrimary } as React.CSSProperties)
          : undefined
      }
    >
      {/* First stop for keyboard and screen-reader users: skip the header and go to the page. */}
      <a
        href="#main-content"
        className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 py-4">
          <Link
            to="/portal"
            className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"
          >
            {me.firm?.hasLogo ? (
              <img src="/api/logo" alt="" className="h-8 w-auto" />
            ) : (
              <span
                aria-hidden
                className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
              >
                {me.firm?.displayName.slice(0, 1).toUpperCase()}
              </span>
            )}
            {me.firm?.displayName}
          </Link>
          {me.contact && (
            <nav aria-label="Portal" className="flex items-center gap-2 text-sm">
              <Link
                to="/portal/receipts"
                className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Receipts
              </Link>
              <Button variant="outline" size="sm" onClick={() => logout.mutate()}>
                Sign out
              </Button>
            </nav>
          )}
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl px-4 py-8 outline-none sm:py-10"
      >
        <Outlet />
      </main>
      <footer className="mx-auto flex max-w-3xl items-center justify-center gap-1.5 px-4 pb-10 text-xs text-muted-foreground">
        <LockIcon className="size-3" aria-hidden /> Secure payments · Powered by Duely
      </footer>
    </div>
  );
}
