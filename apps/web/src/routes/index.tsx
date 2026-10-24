import { Button } from "@repo/ui/components/button";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

// One route owns "/" and branches on host kind (SPEC 1.4): the marketing page, the app host's
// entry point, or nothing yet on portal hosts (their pages arrive in Phase 2).
export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (context.host.hostKind === "app") throw redirect({ to: "/app" });
    if (context.host.hostKind === "portal") throw notFound();
  },
  component: HomePage,
});

function HomePage() {
  // The staff app lives on its own host, so this is a plain link, not a router link.
  const { host } = Route.useRouteContext();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Duely</h1>
      <p className="max-w-md text-muted-foreground">
        Send invoices, get paid, and stop chasing clients.
      </p>
      <Button
        render={<a href={host.appOrigin} aria-label="Sign in" />}
        nativeButton={false}
        size="lg"
      >
        Sign in
      </Button>
    </main>
  );
}
