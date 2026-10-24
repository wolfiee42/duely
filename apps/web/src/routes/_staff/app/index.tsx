import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Card, Page } from "#/components/ui-bits.tsx";

export const Route = createFileRoute("/_staff/app/")({
  component: Dashboard,
});

function Dashboard() {
  const { trpc, host } = Route.useRouteContext();
  const { data } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const { data: invoices } = useSuspenseQuery(trpc.invoices.list.queryOptions());
  const portalHost = `${data.firm.platformSlug}.${host.rootHost}`;

  const open = invoices.filter((i) =>
    ["sent", "viewed", "overdue", "promised", "disputed"].includes(i.effectiveStatus),
  );
  const overdue = invoices.filter((i) => i.effectiveStatus === "overdue");
  const sum = (rows: typeof invoices) =>
    rows.reduce((total, i) => total + i.totalMinor - i.paidMinor, 0);

  return (
    <Page title={`Welcome to ${data.firm.displayName}`}>
      {!data.firm.stripeChargesEnabled && (
        <Card title="Connect payments to start sending invoices">
          <p className="mb-3 text-sm text-muted-foreground">
            Clients pay online once your payout account is connected.
          </p>
          <Link to="/app/settings" className="text-sm underline underline-offset-4">
            Go to settings
          </Link>
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card title="Outstanding">
          <p className="text-2xl font-semibold">{formatUsd(sum(open))}</p>
          <p className="text-xs text-muted-foreground">{open.length} open invoices</p>
        </Card>
        <Card title="Overdue">
          <p className="text-2xl font-semibold">{formatUsd(sum(overdue))}</p>
          <p className="text-xs text-muted-foreground">{overdue.length} invoices</p>
        </Card>
        <Card title="Client portal">
          <p className="font-mono text-sm break-all">{portalHost}</p>
        </Card>
      </div>
    </Page>
  );
}
