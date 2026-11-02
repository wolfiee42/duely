import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ReceiptIcon } from "lucide-react";

import { EmptyState } from "#/components/ui-bits.tsx";
import { requirePortalContact } from "#/lib/portal.ts";

export const Route = createFileRoute("/portal/receipts")({
  beforeLoad: ({ context }) => requirePortalContact(context),
  head: () => ({ meta: [{ title: "Receipts" }] }),
  component: Receipts,
});

function Receipts() {
  const { portalTrpc } = Route.useRouteContext();
  const { data: receipts } = useSuspenseQuery(portalTrpc.invoices.receipts.queryOptions());

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Receipts</h1>
      {receipts.length === 0 ? (
        <EmptyState icon={<ReceiptIcon />}>No payments yet.</EmptyState>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {receipts.map((r) => (
            <li
              key={r.paymentId}
              className="flex items-center justify-between gap-3 px-5 py-4 text-sm"
            >
              <Link
                to="/portal/invoices/$invoiceId"
                params={{ invoiceId: r.invoiceId }}
                className="font-medium text-primary hover:underline"
              >
                {r.invoiceNumber}
              </Link>
              <span className="text-muted-foreground">
                {r.paidAt ? new Date(r.paidAt).toLocaleDateString() : ""} ·{" "}
                {r.method === "ach" ? "Bank transfer" : "Card"}
              </span>
              <span className="font-semibold tabular-nums">{formatUsd(r.amountMinor)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
