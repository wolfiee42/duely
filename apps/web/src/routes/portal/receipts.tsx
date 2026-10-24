import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { requirePortalContact } from "#/lib/portal.ts";

export const Route = createFileRoute("/portal/receipts")({
  beforeLoad: ({ context }) => requirePortalContact(context),
  component: Receipts,
});

function Receipts() {
  const { portalTrpc } = Route.useRouteContext();
  const { data: receipts } = useSuspenseQuery(portalTrpc.invoices.receipts.queryOptions());

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold tracking-tight">Receipts</h1>
      {receipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {receipts.map((r) => (
            <li key={r.paymentId} className="flex items-center justify-between px-4 py-3 text-sm">
              <Link
                to="/portal/invoices/$invoiceId"
                params={{ invoiceId: r.invoiceId }}
                className="underline underline-offset-4"
              >
                {r.invoiceNumber}
              </Link>
              <span className="text-muted-foreground">
                {r.paidAt ? new Date(r.paidAt).toLocaleDateString() : ""} ·{" "}
                {r.method === "ach" ? "Bank transfer" : "Card"}
              </span>
              <span className="tabular-nums">{formatUsd(r.amountMinor)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
