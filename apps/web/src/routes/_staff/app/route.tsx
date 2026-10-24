import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { SignOutButton } from "#/components/sign-out-button.tsx";
import { ThemeToggle } from "#/components/theme-toggle.tsx";

export const Route = createFileRoute("/_staff/app")({
  component: AppLayout,
});

function AppLayout() {
  const { trpc } = Route.useRouteContext();
  const { data } = useSuspenseQuery(trpc.firm.get.queryOptions());

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">{data.firm.displayName}</span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
