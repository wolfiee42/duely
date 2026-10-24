import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_staff/app/")({
  component: Dashboard,
});

function Dashboard() {
  const { trpc, host } = Route.useRouteContext();
  const { data } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const portalHost = `${data.firm.platformSlug}.${host.rootHost}`;

  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-bold tracking-tight">Welcome to {data.firm.displayName}</h1>
      <p className="text-sm text-muted-foreground">
        Your clients will pay at <span className="font-mono">{portalHost}</span>.
      </p>
    </section>
  );
}
