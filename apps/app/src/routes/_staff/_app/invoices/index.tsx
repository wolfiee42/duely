import { formatUsd } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FileTextIcon, PlusIcon, SearchIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { Avatar, EmptyState, Page, RiskBadge, StatusBadge } from "#/components/ui-bits.tsx";

const STATUSES = [
  "draft",
  "sent",
  "viewed",
  "overdue",
  "promised",
  "disputed",
  "paid",
  "void",
] as const;

export const Route = createFileRoute("/_staff/_app/invoices/")({
  validateSearch: z.object({ status: z.enum(STATUSES).optional() }),
  component: Invoices,
});

const CHIP = "rounded-full border px-3 py-1 text-sm capitalize transition-colors hover:bg-muted";
const CHIP_ACTIVE =
  "rounded-full border border-primary/30 bg-accent px-3 py-1 text-sm font-medium text-accent-foreground capitalize";

function Invoices() {
  const { trpc } = Route.useRouteContext();
  const { status } = Route.useSearch();
  const { data: invoices } = useSuspenseQuery(
    trpc.invoices.list.queryOptions(status ? { status } : undefined),
  );
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? invoices.filter(
        (i) =>
          (i.number ?? "draft").toLowerCase().includes(needle) ||
          i.clientName.toLowerCase().includes(needle),
      )
    : invoices;

  return (
    <Page
      title="Invoices"
      description="Everything you've billed, and where each invoice stands."
      actions={
        <>
          <Button render={<Link to="/invoices/import" />} nativeButton={false} variant="outline">
            <UploadIcon /> Import from file
          </Button>
          <Button render={<Link to="/invoices/new" />} nativeButton={false}>
            <PlusIcon /> New invoice
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          <Link
            to="/invoices"
            className={CHIP}
            activeOptions={{ includeSearch: true }}
            activeProps={{ className: CHIP_ACTIVE }}
          >
            All
          </Link>
          {STATUSES.map((s) => (
            <Link
              key={s}
              to="/invoices"
              search={{ status: s }}
              className={CHIP}
              activeOptions={{ includeSearch: true }}
              activeProps={{ className: CHIP_ACTIVE }}
            >
              {s}
            </Link>
          ))}
        </div>
        <label className="relative w-full sm:w-60">
          <span className="sr-only">Search invoices</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search number or client"
            className="w-full rounded-lg border bg-card py-2 pr-3 pl-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </label>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={<FileTextIcon />}>
          {needle ? "No invoices match that search." : "No invoices here yet."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3">Number</th>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Payment outlook</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((i) => (
                <tr key={i.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link
                      to="/invoices/$invoiceId"
                      params={{ invoiceId: i.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {i.number ?? "Draft"}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={i.clientName} />
                      {i.clientName}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">
                    {i.dueDate ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={i.effectiveStatus} />
                  </td>
                  <td className="px-4 py-3">
                    <RiskBadge level={i.riskLevel} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatUsd(i.totalMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
