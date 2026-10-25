import { formatUsd } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { Page, RiskBadge, StatusBadge } from "#/components/ui-bits.tsx";

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

export const Route = createFileRoute("/_staff/app/invoices/")({
  validateSearch: z.object({ status: z.enum(STATUSES).optional() }),
  component: Invoices,
});

function Invoices() {
  const { trpc } = Route.useRouteContext();
  const { status } = Route.useSearch();
  const { data: invoices } = useSuspenseQuery(
    trpc.invoices.list.queryOptions(status ? { status } : undefined),
  );

  return (
    <Page
      title="Invoices"
      actions={
        <>
          <Button
            render={<Link to="/app/invoices/import" />}
            nativeButton={false}
            variant="outline"
          >
            Import from file
          </Button>
          <Button render={<Link to="/app/invoices/new" />} nativeButton={false}>
            New invoice
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-1 text-sm" role="group" aria-label="Filter by status">
        <Link
          to="/app/invoices"
          className="rounded-full border px-3 py-1"
          activeOptions={{ includeSearch: true }}
          activeProps={{ className: "rounded-full border px-3 py-1 bg-muted font-medium" }}
        >
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            to="/app/invoices"
            search={{ status: s }}
            className="rounded-full border px-3 py-1"
            activeOptions={{ includeSearch: true }}
            activeProps={{ className: "rounded-full border px-3 py-1 bg-muted font-medium" }}
          >
            {s}
          </Link>
        ))}
      </div>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invoices here yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Payment outlook</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    <Link
                      to="/app/invoices/$invoiceId"
                      params={{ invoiceId: i.id }}
                      className="underline underline-offset-4"
                    >
                      {i.number ?? "Draft"}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{i.clientName}</td>
                  <td className="px-3 py-2">{i.dueDate ?? "-"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={i.effectiveStatus} />
                  </td>
                  <td className="px-3 py-2">
                    <RiskBadge level={i.riskLevel} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(i.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
