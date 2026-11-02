import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  BanknoteIcon,
  CalendarCheckIcon,
  CircleDollarSignIcon,
  ClockAlertIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  InboxIcon,
} from "lucide-react";

import { Card, EmptyState, Page, StatTile } from "#/components/ui-bits.tsx";

export const Route = createFileRoute("/_staff/_app/")({
  component: Dashboard,
});

const BUCKETS = [
  ["current", "Not yet due", "bg-chart-3"],
  ["1-30", "1 to 30 days late", "bg-amber-500"],
  ["31-60", "31 to 60 days late", "bg-orange-500"],
  ["61+", "Over 60 days late", "bg-red-500"],
] as const;

function Banner({
  icon,
  title,
  text,
  to,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  to: "/settings" | "/review";
  cta: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-warning/20 bg-warning-soft p-4 text-warning">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background/60 [&_svg]:size-5">
        {icon}
      </span>
      <div className="min-w-48 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm opacity-80">{text}</p>
      </div>
      <Link
        to={to}
        className="inline-flex items-center gap-1.5 rounded-lg bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-card hover:bg-muted"
      >
        {cta} <ArrowRightIcon className="size-4" />
      </Link>
    </div>
  );
}

function Dashboard() {
  const { trpc, host } = Route.useRouteContext();
  const { data: firm } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const { data: d } = useSuspenseQuery(trpc.dashboard.get.queryOptions());
  const portalHost = `${firm.firm.platformSlug}.${host.rootHost}`;
  const total =
    d.aging.current.amountMinor +
    d.aging["1-30"].amountMinor +
    d.aging["31-60"].amountMinor +
    d.aging["61+"].amountMinor;
  const promisedMinor = d.promisesDue.reduce((sum, p) => sum + p.amountMinor, 0);
  const collectedMinor = d.recentPayments.reduce((sum, p) => sum + p.amountMinor, 0);

  return (
    <Page
      title={`Welcome to ${firm.firm.displayName}`}
      description="Where your receivables stand today."
      actions={
        <span className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground shadow-card">
          <ExternalLinkIcon className="size-3.5" />
          {portalHost}
        </span>
      }
    >
      {!firm.firm.stripeChargesEnabled && (
        <Banner
          icon={<CreditCardIcon />}
          title="Connect payments to start sending invoices"
          text="Clients pay online once your payout account is connected."
          to="/settings"
          cta="Go to settings"
        />
      )}
      {d.waitingForReview > 0 && (
        <Banner
          icon={<InboxIcon />}
          title={
            d.waitingForReview === 1 ? "1 item needs you" : `${d.waitingForReview} items need you`
          }
          text="Drafts and replies are waiting for your decision."
          to="/review"
          cta="Open review"
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Outstanding"
          value={formatUsd(d.outstandingMinor)}
          hint={`${d.openCount} open invoices`}
          icon={<CircleDollarSignIcon />}
          tone="info"
          testId="outstanding"
        />
        <StatTile
          label="Overdue"
          value={formatUsd(d.overdueMinor)}
          hint={
            <>
              {d.overdueCount} invoices
              {d.highRiskCount > 0 && ` · ${d.highRiskCount} likely to pay late`}
            </>
          }
          icon={<ClockAlertIcon />}
          tone="danger"
          testId="overdue"
        />
        <StatTile
          label="Promised this week"
          value={formatUsd(promisedMinor)}
          hint={`${d.promisesDue.length} ${d.promisesDue.length === 1 ? "promise" : "promises"} due`}
          icon={<CalendarCheckIcon />}
          tone="warning"
        />
        <StatTile
          label="Recently collected"
          value={formatUsd(collectedMinor)}
          hint={`${d.recentPayments.length} latest payments`}
          icon={<BanknoteIcon />}
          tone="success"
        />
      </div>

      <Card title="Who owes you, by how late">
        {total > 0 && (
          <div className="mb-5 flex h-3 overflow-hidden rounded-full bg-muted" role="presentation">
            {BUCKETS.map(([key, , color]) => {
              const amount = d.aging[key].amountMinor;
              return amount > 0 ? (
                <span
                  key={key}
                  className={`${color} first:rounded-l-full last:rounded-r-full`}
                  style={{ width: `${(amount / total) * 100}%` }}
                />
              ) : null;
            })}
          </div>
        )}
        <ul className="grid gap-3" data-testid="aging">
          {BUCKETS.map(([key, label, color]) => {
            const b = d.aging[key];
            return (
              <li key={key} className="flex items-center gap-3 text-sm">
                <span aria-hidden className={`size-2.5 rounded-full ${color}`} />
                <span className="flex-1">{label}</span>
                <span className="font-medium tabular-nums" data-testid={`aging-${key}`}>
                  {formatUsd(b.amountMinor)}{" "}
                  <span className="text-xs font-normal text-muted-foreground">({b.count})</span>
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Promises due this week">
          {d.promisesDue.length === 0 ? (
            <EmptyState icon={<CalendarCheckIcon />}>No promised payments this week.</EmptyState>
          ) : (
            <ul className="-my-2 divide-y text-sm" data-testid="promises-due">
              {d.promisesDue.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                  <Link
                    to="/invoices/$invoiceId"
                    params={{ invoiceId: p.invoiceId }}
                    className="min-w-0 hover:underline"
                  >
                    <span className="block truncate font-medium">{p.clientName}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.number} · by {p.promisedDate}
                    </span>
                  </Link>
                  <span className="font-medium tabular-nums">{formatUsd(p.amountMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent payments">
          {d.recentPayments.length === 0 ? (
            <EmptyState icon={<AlertCircleIcon />}>No payments yet.</EmptyState>
          ) : (
            <ul className="-my-2 divide-y text-sm" data-testid="recent-payments">
              {d.recentPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                  <Link
                    to="/invoices/$invoiceId"
                    params={{ invoiceId: p.invoiceId }}
                    className="min-w-0 hover:underline"
                  >
                    <span className="block truncate font-medium">{p.clientName}</span>
                    <span className="text-xs text-muted-foreground">{p.number}</span>
                  </Link>
                  <span className="font-medium text-success tabular-nums">
                    +{formatUsd(p.amountMinor)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
