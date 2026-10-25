import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Card, Page } from "#/components/ui-bits.tsx";

export const Route = createFileRoute("/_staff/app/")({
  component: Dashboard,
});

const BUCKETS = [
  ["current", "Not yet due"],
  ["1-30", "1 to 30 days late"],
  ["31-60", "31 to 60 days late"],
  ["61+", "Over 60 days late"],
] as const;

function Dashboard() {
  const { trpc, host } = Route.useRouteContext();
  const { data: firm } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const { data: d } = useSuspenseQuery(trpc.dashboard.get.queryOptions());
  const portalHost = `${firm.firm.platformSlug}.${host.rootHost}`;
  const widest = Math.max(1, ...BUCKETS.map(([k]) => d.aging[k].amountMinor));

  return (
    <Page title={`Welcome to ${firm.firm.displayName}`}>
      {!firm.firm.stripeChargesEnabled && (
        <Card title="Connect payments to start sending invoices">
          <p className="mb-3 text-sm text-muted-foreground">
            Clients pay online once your payout account is connected.
          </p>
          <Link to="/app/settings" className="text-sm underline underline-offset-4">
            Go to settings
          </Link>
        </Card>
      )}
      {d.waitingForReview > 0 && (
        <Card title="Waiting for you">
          <p className="mb-3 text-sm text-muted-foreground">
            {d.waitingForReview === 1 ? "1 item needs" : `${d.waitingForReview} items need`} your
            attention.
          </p>
          <Link to="/app/review" className="text-sm underline underline-offset-4">
            Open review
          </Link>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card title="Outstanding">
          <p className="text-2xl font-semibold" data-testid="outstanding">
            {formatUsd(d.outstandingMinor)}
          </p>
          <p className="text-xs text-muted-foreground">{d.openCount} open invoices</p>
        </Card>
        <Card title="Overdue">
          <p className="text-2xl font-semibold" data-testid="overdue">
            {formatUsd(d.overdueMinor)}
          </p>
          <p className="text-xs text-muted-foreground">
            {d.overdueCount} invoices
            {d.highRiskCount > 0 && ` · ${d.highRiskCount} likely to pay late`}
          </p>
        </Card>
        <Card title="Client portal">
          <p className="font-mono text-sm break-all">{portalHost}</p>
        </Card>
      </div>

      <Card title="Who owes you, by how late">
        <ul className="grid gap-2" data-testid="aging">
          {BUCKETS.map(([key, label]) => {
            const b = d.aging[key];
            return (
              <li key={key} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 text-sm">
                <span>{label}</span>
                <span className="h-3 rounded-full bg-muted" role="presentation">
                  <span
                    className={`block h-3 rounded-full ${key === "current" ? "bg-blue-500" : key === "1-30" ? "bg-amber-500" : "bg-red-500"}`}
                    style={{ width: `${(b.amountMinor / widest) * 100}%` }}
                  />
                </span>
                <span className="tabular-nums" data-testid={`aging-${key}`}>
                  {formatUsd(b.amountMinor)}{" "}
                  <span className="text-xs text-muted-foreground">({b.count})</span>
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="Promises due this week">
          {d.promisesDue.length === 0 ? (
            <p className="text-sm text-muted-foreground">No promised payments this week.</p>
          ) : (
            <ul className="divide-y text-sm" data-testid="promises-due">
              {d.promisesDue.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5">
                  <Link
                    to="/app/invoices/$invoiceId"
                    params={{ invoiceId: p.invoiceId }}
                    className="underline underline-offset-4"
                  >
                    {p.clientName} · {p.number}
                  </Link>
                  <span className="text-muted-foreground tabular-nums">
                    {formatUsd(p.amountMinor)} by {p.promisedDate}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent payments">
          {d.recentPayments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <ul className="divide-y text-sm" data-testid="recent-payments">
              {d.recentPayments.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5">
                  <Link
                    to="/app/invoices/$invoiceId"
                    params={{ invoiceId: p.invoiceId }}
                    className="underline underline-offset-4"
                  >
                    {p.clientName} · {p.number}
                  </Link>
                  <span className="tabular-nums">{formatUsd(p.amountMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
