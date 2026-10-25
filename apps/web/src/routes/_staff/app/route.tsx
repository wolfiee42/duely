import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { SignOutButton } from "#/components/sign-out-button.tsx";
import { ThemeToggle } from "#/components/theme-toggle.tsx";

export const Route = createFileRoute("/_staff/app")({
  component: AppLayout,
});

const DEMO_NAV = { to: "/app/demo", label: "Demo tools" } as const;
const NAV = [
  { to: "/app", label: "Home", exact: true },
  { to: "/app/invoices", label: "Invoices" },
  { to: "/app/clients", label: "Clients" },
  { to: "/app/review", label: "Review" },
  { to: "/app/imports", label: "Import" },
  { to: "/app/policies", label: "Follow-ups" },
  { to: "/app/settings", label: "Settings" },
] as const;

function AppLayout() {
  const { trpc } = Route.useRouteContext();
  const { data } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const { data: waiting } = useSuspenseQuery(trpc.review.count.queryOptions());

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-lg font-semibold tracking-tight">{data.firm.displayName}</span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>
      <nav aria-label="Main" className="flex gap-1 border-b pb-2 text-sm">
        {(data.firm.isDemo ? [...NAV, DEMO_NAV] : NAV).map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: "exact" in item }}
            className="rounded-md px-3 py-1.5 hover:bg-muted"
            activeProps={{ className: "rounded-md px-3 py-1.5 bg-muted font-medium" }}
          >
            {item.label}
            {item.to === "/app/review" && waiting > 0 && (
              <span
                className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground"
                data-testid="review-count"
              >
                {waiting}
              </span>
            )}
          </Link>
        ))}
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
