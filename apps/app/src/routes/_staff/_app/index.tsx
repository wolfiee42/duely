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
} from "lucide-react";
import { useEffect, useState } from "react";

import { DecisionDeck } from "#/components/decision-deck.tsx";
import { Card, EmptyState, Page, StatTile } from "#/components/ui-bits.tsx";

export const Route = createFileRoute("/_staff/_app/")({
  component: Dashboard,
});

const BUCKETS = [
  ["current", "Not yet due", "bg-chart-3", "stroke-chart-3"],
  ["1-30", "1 to 30 days late", "bg-amber-500", "stroke-amber-500"],
  ["31-60", "31 to 60 days late", "bg-orange-500", "stroke-orange-500"],
  ["61+", "Over 60 days late", "bg-red-500", "stroke-red-500"],
] as const;

// Donut geometry: radius 70 in a 200 box, with a small gap between slices.
const RADIUS = 70;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SLICE_GAP = 3;

// Tiles rise in one after another; motion-reduce users get them instantly.
const tile =
  "animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both motion-reduce:animate-none";
const DELAYS = ["delay-100", "delay-150", "delay-200", "delay-300"];

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
  to: "/settings";
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

function AgingDonut({
  aging,
  total,
  size,
}: {
  aging: Record<(typeof BUCKETS)[number][0], { amountMinor: number; count: number }>;
  total: number;
  size: string;
}) {
  const [active, setActive] = useState<(typeof BUCKETS)[number][0] | null>(null);
  // Slices grow from nothing on first paint.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const current = active ? BUCKETS.find(([key]) => key === active) : null;
  const currentAmount = active ? aging[active].amountMinor : total;
  let offset = 0;

  return (
    <div className="flex w-full flex-wrap items-center gap-8">
      <svg
        viewBox="0 0 200 200"
        className={`${size} shrink-0`}
        role="img"
        aria-label="Receivables by how late they are"
      >
        <g transform="rotate(-90 100 100)">
          <circle
            cx="100"
            cy="100"
            r={RADIUS}
            fill="none"
            strokeWidth={26}
            className="stroke-muted"
          />
          {total > 0 &&
            BUCKETS.map(([key, , , stroke]) => {
              const amount = aging[key].amountMinor;
              if (amount === 0) return null;
              const length = drawn ? Math.max(0, (amount / total) * CIRCUMFERENCE - SLICE_GAP) : 0;
              const start = offset;
              offset += (amount / total) * CIRCUMFERENCE;
              return (
                <circle
                  key={key}
                  cx="100"
                  cy="100"
                  r={RADIUS}
                  fill="none"
                  strokeWidth={active === key ? 32 : 26}
                  strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                  strokeDashoffset={-start}
                  opacity={active && active !== key ? 0.4 : 1}
                  className={`${stroke} cursor-pointer transition-[stroke-dasharray,stroke-width,opacity] duration-700 motion-reduce:transition-none`}
                  onMouseEnter={() => setActive(key)}
                  onMouseLeave={() => setActive(null)}
                />
              );
            })}
        </g>
        <text x="100" y="94" textAnchor="middle" className="fill-muted-foreground text-[10px]">
          {current ? current[1] : "Outstanding"}
        </text>
        <text
          x="100"
          y="116"
          textAnchor="middle"
          className="fill-foreground text-[17px] font-semibold"
        >
          {formatUsd(currentAmount)}
        </text>
        <text x="100" y="132" textAnchor="middle" className="fill-muted-foreground text-[10px]">
          {current && total > 0 ? `${Math.round((currentAmount / total) * 100)}% of total` : ""}
        </text>
      </svg>

      <ul className="grid min-w-60 flex-1 gap-1" data-testid="aging">
        {BUCKETS.map(([key, label, color]) => {
          const b = aging[key];
          return (
            <li key={key}>
              <button
                type="button"
                onMouseEnter={() => setActive(key)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(key)}
                onBlur={() => setActive(null)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 ${active === key ? "bg-muted" : ""}`}
              >
                <span aria-hidden className={`size-2.5 rounded-full ${color}`} />
                <span className="flex-1">{label}</span>
                <span className="font-medium tabular-nums" data-testid={`aging-${key}`}>
                  {formatUsd(b.amountMinor)}{" "}
                  <span className="text-xs font-normal text-muted-foreground">({b.count})</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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

  const stats = [
    <StatTile
      key="outstanding"
      compact
      label="Outstanding"
      value={formatUsd(d.outstandingMinor)}
      hint={`${d.openCount} open invoices`}
      icon={<CircleDollarSignIcon />}
      tone="info"
      testId="outstanding"
    />,
    <StatTile
      key="overdue"
      compact
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
    />,
    <StatTile
      key="promised"
      compact
      label="Promised this week"
      value={formatUsd(promisedMinor)}
      hint={`${d.promisesDue.length} ${d.promisesDue.length === 1 ? "promise" : "promises"} due`}
      icon={<CalendarCheckIcon />}
      tone="warning"
    />,
    <StatTile
      key="collected"
      compact
      label="Recently collected"
      value={formatUsd(collectedMinor)}
      hint={`${d.recentPayments.length} latest payments`}
      icon={<BanknoteIcon />}
      tone="success"
    />,
  ];

  const aging = (
    <section
      className={`${tile} flex flex-col rounded-2xl border bg-card p-5 text-card-foreground shadow-card delay-75`}
    >
      <h2 className="text-sm font-medium text-muted-foreground">Who owes you, by how late</h2>
      <div className="flex flex-1 items-center">
        <AgingDonut aging={d.aging} total={total} size="size-48" />
      </div>
    </section>
  );

  const promises = (
    <div className={`${tile} delay-300`}>
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
    </div>
  );

  const payments = (
    <div className={`${tile} delay-300`}>
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
  );

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

      <div className="grid gap-4 lg:grid-cols-12 lg:grid-rows-[16.5rem_16.5rem_auto]">
        <DecisionDeck className={`${tile} lg:col-span-4 lg:row-span-2`} />
        <div className="flex flex-col lg:col-span-8 lg:row-start-1 [&>section]:flex-1">{aging}</div>
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-8 lg:row-start-2">
          {stats.map((stat, n) => (
            <div key={stat.key} className={`${tile} ${DELAYS[n]}`}>
              {stat}
            </div>
          ))}
        </div>
        <div className="lg:col-span-6 lg:row-start-3">{promises}</div>
        <div className="lg:col-span-6 lg:row-start-3">{payments}</div>
      </div>
    </Page>
  );
}
