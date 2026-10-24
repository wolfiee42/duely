import { formatUsd } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PayPanel } from "#/components/pay-panel.tsx";
import { Card, StatusBadge } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { requirePortalContact } from "#/lib/portal.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/portal/invoices/$invoiceId")({
  beforeLoad: ({ context }) => requirePortalContact(context),
  component: PortalInvoice,
});

function PortalInvoice() {
  const { invoiceId } = Route.useParams();
  const { portalTrpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { data: invoice } = useSuspenseQuery(portalTrpc.invoices.get.queryOptions({ invoiceId }));

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: portalTrpc.invoices.get.queryKey({ invoiceId }) });
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        trpcErrorInfo(error).domainCode === "promise.date_too_far"
          ? "Choose a date within 90 days."
          : "We couldn't save that. Please try again.",
    });
  const promise = useMutation(
    portalTrpc.promises.create.mutationOptions({ onSuccess: refresh, onError }),
  );
  const dispute = useMutation(
    portalTrpc.disputes.open.mutationOptions({ onSuccess: refresh, onError }),
  );

  const open = ["sent", "viewed", "overdue", "promised"].includes(invoice.status);
  const balance = invoice.totalMinor - invoice.paidMinor;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Invoice {invoice.number}</h1>
        <StatusBadge status={invoice.effectiveStatus} />
      </div>

      <Card>
        <p className="text-sm text-muted-foreground">
          From {invoice.firm.legalName} · issued {invoice.issueDate} · due {invoice.dueDate}
        </p>
        <table className="mt-3 w-full text-sm">
          <tbody className="divide-y">
            {invoice.items.map((i, n) => (
              <tr key={n}>
                <td className="py-2">{i.description}</td>
                <td className="py-2 text-right text-muted-foreground">
                  {Number(i.quantity)} × {formatUsd(i.unitAmountMinor)}
                </td>
                <td className="py-2 text-right tabular-nums">{formatUsd(i.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex justify-between border-t pt-3 text-lg font-semibold">
          <span>{invoice.status === "paid" ? "Paid" : "Amount due"}</span>
          <span className="tabular-nums" data-testid="amount-due">
            {formatUsd(invoice.status === "paid" ? invoice.paidMinor : balance)}
          </span>
        </div>
        {invoice.notes && (
          <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">{invoice.notes}</p>
        )}
        <a
          href={`/api/invoices/${invoiceId}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-sm underline underline-offset-4"
        >
          Download PDF
        </a>
      </Card>

      {invoice.status === "paid" && (
        <Card>
          <p className="text-sm">
            Thank you, this invoice is paid.{" "}
            <Link to="/portal/receipts" className="underline underline-offset-4">
              View receipts
            </Link>
          </p>
        </Card>
      )}

      {invoice.paymentProcessing && (
        <Card>
          <p className="text-sm">
            Your bank payment is on its way. We'll email you a receipt when it clears.
          </p>
        </Card>
      )}

      {open && invoice.canPay && !invoice.paymentProcessing && (
        <Card title="Pay this invoice">
          <PayPanel invoiceId={invoiceId} trpc={portalTrpc} onPaid={refresh} />
        </Card>
      )}

      {invoice.activePromise && (
        <Card>
          <p className="text-sm">
            You told us you'd pay on <strong>{invoice.activePromise.promisedDate}</strong>.
          </p>
        </Card>
      )}
      {invoice.hasOpenDispute && (
        <Card>
          <p className="text-sm">
            We've received your question about this invoice and will be in touch.
          </p>
        </Card>
      )}

      {open && !invoice.paymentProcessing && (
        <div className="grid gap-4 sm:grid-cols-2">
          {!invoice.activePromise && !invoice.hasOpenDispute && (
            <Card title="Need more time?">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  promise.mutate({
                    invoiceId,
                    promisedDate: field(new FormData(e.currentTarget), "date"),
                  });
                }}
              >
                <Label htmlFor="promise-date">I'll pay by</Label>
                <Input id="promise-date" name="date" type="date" required />
                <Button type="submit" variant="outline" disabled={promise.isPending}>
                  Let them know
                </Button>
              </form>
            </Card>
          )}
          {!invoice.hasOpenDispute && (
            <Card title="Something wrong?">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  dispute.mutate({
                    invoiceId,
                    reason: field(f, "reason"),
                    detail: field(f, "detail") || null,
                  });
                }}
              >
                <Label htmlFor="dispute-reason">What's the issue?</Label>
                <Input id="dispute-reason" name="reason" required />
                <textarea
                  name="detail"
                  rows={2}
                  aria-label="More detail"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
                <Button type="submit" variant="outline" disabled={dispute.isPending}>
                  Report a problem
                </Button>
              </form>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}
