import { formatUsd } from "@repo/api/money";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";

import { EmptyState, StatusBadge } from "#/components/ui-bits.tsx";
import { requirePortalContact } from "#/lib/portal.ts";

export const Route = createFileRoute("/portal/")({
  beforeLoad: ({ context }) => requirePortalContact(context),
  head: () => ({ meta: [{ title: "Your invoices" }] }),
  component: PortalHome,
});

function PortalHome() {
  const { portalTrpc } = Route.useRouteContext();
  const { data: invoices } = useSuspenseQuery(portalTrpc.invoices.list.queryOptions());

  const dueMinor = invoices
    .filter((i) =>
      ["sent", "viewed", "overdue", "promised", "disputed"].includes(i.effectiveStatus),
    )
    .reduce((sum, i) => sum + i.totalMinor, 0);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your invoices</h1>
        {dueMinor > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            You have <strong className="text-foreground tabular-nums">{formatUsd(dueMinor)}</strong>{" "}
            outstanding.
          </p>
        )}
      </div>
      {invoices.length === 0 ? (
        <EmptyState icon={<FileTextIcon />}>Nothing here yet.</EmptyState>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {invoices.map((i) => (
            <li key={i.id}>
              <Link
                to="/portal/invoices/$invoiceId"
                params={{ invoiceId: i.id }}
                className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
              >
                <span>
                  <span className="block font-medium">{i.number}</span>
                  <span className="text-sm text-muted-foreground">due {i.dueDate}</span>
                </span>
                <span className="flex items-center gap-4">
                  <StatusBadge status={i.effectiveStatus} />
                  <span className="font-semibold tabular-nums">{formatUsd(i.totalMinor)}</span>
                  <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
