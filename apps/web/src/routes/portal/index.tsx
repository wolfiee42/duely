import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { StatusBadge } from "#/components/ui-bits.tsx";
import { requirePortalContact } from "#/lib/portal.ts";

export const Route = createFileRoute("/portal/")({
  beforeLoad: ({ context }) => requirePortalContact(context),
  component: PortalHome,
});

function PortalHome() {
  const { portalTrpc } = Route.useRouteContext();
  const { data: invoices } = useSuspenseQuery(portalTrpc.invoices.list.queryOptions());

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold tracking-tight">Your invoices</h1>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {invoices.map((i) => (
            <li key={i.id}>
              <Link
                to="/portal/invoices/$invoiceId"
                params={{ invoiceId: i.id }}
                className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-muted"
              >
                <span>
                  <span className="font-medium">{i.number}</span>
                  <span className="ml-2 text-sm text-muted-foreground">due {i.dueDate}</span>
                </span>
                <span className="flex items-center gap-3">
                  <StatusBadge status={i.effectiveStatus} />
                  <span className="tabular-nums">{formatUsd(i.totalMinor)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
