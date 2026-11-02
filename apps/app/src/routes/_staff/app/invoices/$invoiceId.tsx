import { formatUsd } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { InvoiceEditor } from "#/components/invoice-editor.tsx";
import { Timeline } from "#/components/timeline.tsx";
import { Card, Page, RiskBadge, StatusBadge } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/app/invoices/$invoiceId")({
  component: InvoicePage,
});

const MESSAGES: Record<string, string> = {
  "invoice.charges_not_enabled": "Connect payments in Settings before sending.",
  "invoice.no_items": "Add at least one line item.",
  "invoice.zero_total": "The total must be more than zero.",
  "invoice.no_contact": "The client needs a contact who receives invoices.",
  "invoice.invalid_transition": "This invoice has already changed. Refresh and try again.",
  "invoice.dispute_exists": "A dispute is already open.",
  "promise.date_in_past": "Choose a date from today onwards.",
};

function InvoicePage() {
  const { invoiceId } = Route.useParams();
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: invoice } = useSuspenseQuery(trpc.invoices.get.queryOptions({ invoiceId }));
  const { data: clients } = useSuspenseQuery(trpc.clients.list.queryOptions());
  const { data: timeline } = useSuspenseQuery(trpc.invoices.timeline.queryOptions({ invoiceId }));
  const [voidReason, setVoidReason] = useState("");

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.invoices.get.queryKey({ invoiceId }) });
    await queryClient.invalidateQueries({
      queryKey: trpc.invoices.timeline.queryKey({ invoiceId }),
    });
    await queryClient.invalidateQueries({ queryKey: trpc.invoices.list.queryKey() });
  };
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });

  const save = useMutation(
    trpc.invoices.updateDraft.mutationOptions({ onSuccess: refresh, onError }),
  );
  const send = useMutation(trpc.invoices.send.mutationOptions({ onSuccess: refresh, onError }));
  const voidIt = useMutation(trpc.invoices.void.mutationOptions({ onSuccess: refresh, onError }));
  const remove = useMutation(
    trpc.invoices.deleteDraft.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.invoices.list.queryKey() });
        await navigate({ to: "/app/invoices" });
      },
      onError,
    }),
  );
  const addPromise = useMutation(
    trpc.promises.create.mutationOptions({ onSuccess: refresh, onError }),
  );
  const cancelPromise = useMutation(
    trpc.promises.cancel.mutationOptions({ onSuccess: refresh, onError }),
  );
  const openDispute = useMutation(
    trpc.disputes.open.mutationOptions({ onSuccess: refresh, onError }),
  );
  const resolveDispute = useMutation(
    trpc.disputes.resolve.mutationOptions({ onSuccess: refresh, onError }),
  );

  const closed = invoice.status === "paid" || invoice.status === "void";

  // Recompute the payment outlook and its explanation when an open invoice is opened.
  const explain = useMutation(
    trpc.invoices.explainRisk.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.invoices.list.queryKey() }),
    }),
  );
  const asked = explain.mutate;
  useEffect(() => {
    if (invoice.status !== "draft" && !closed) asked({ invoiceId });
  }, [invoiceId, invoice.status, closed, asked]);

  if (invoice.status === "draft") {
    return (
      <Page
        title="Draft invoice"
        actions={
          <>
            <Button
              render={
                <a
                  href={`/api/invoices/${invoiceId}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open PDF"
                />
              }
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Preview PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => remove.mutate({ invoiceId })}>
              Delete
            </Button>
            <Button
              size="sm"
              disabled={send.isPending}
              onClick={() => send.mutate({ invoiceId, idempotencyKey: crypto.randomUUID() })}
            >
              {send.isPending ? "Sending..." : "Send invoice"}
            </Button>
          </>
        }
      >
        <InvoiceEditor
          clients={clients}
          initial={{
            clientId: invoice.clientId,
            dueDate: invoice.dueDate ?? "",
            notes: invoice.notes ?? "",
            items: invoice.items.map((i) => ({
              description: i.description,
              quantity: String(Number(i.quantity)),
              price: (i.unitAmountMinor / 100).toFixed(2),
            })),
          }}
          submitLabel="Save changes"
          pending={save.isPending}
          onSubmit={(value) => save.mutate({ invoiceId, ...value })}
        />
      </Page>
    );
  }

  return (
    <Page
      title={`Invoice ${invoice.number ?? ""}`}
      actions={
        <>
          <StatusBadge status={invoice.effectiveStatus} />
          <Button
            render={
              <a
                href={`/api/invoices/${invoiceId}/pdf`}
                target="_blank"
                rel="noreferrer"
                aria-label="Open PDF"
              />
            }
            nativeButton={false}
            variant="outline"
            size="sm"
          >
            PDF
          </Button>
        </>
      }
    >
      <Card>
        <div className="grid gap-1 text-sm sm:grid-cols-3">
          <div>
            <span className="text-muted-foreground">Client </span>
            <Link
              to="/app/clients/$clientId"
              params={{ clientId: invoice.client.id }}
              className="underline underline-offset-4"
            >
              {invoice.client.name}
            </Link>
          </div>
          <div>
            <span className="text-muted-foreground">Issued </span>
            {invoice.issueDate}
          </div>
          <div>
            <span className="text-muted-foreground">Due </span>
            {invoice.dueDate}
          </div>
        </div>
        <table className="mt-3 w-full text-sm">
          <tbody className="divide-y">
            {invoice.items.map((i) => (
              <tr key={i.id}>
                <td className="py-2">{i.description}</td>
                <td className="py-2 text-right text-muted-foreground">
                  {Number(i.quantity)} × {formatUsd(i.unitAmountMinor)}
                </td>
                <td className="py-2 text-right tabular-nums">{formatUsd(i.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex justify-between border-t pt-3 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatUsd(invoice.totalMinor)}</span>
        </div>
        {invoice.paidMinor > 0 && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Paid</span>
            <span className="tabular-nums">{formatUsd(invoice.paidMinor)}</span>
          </div>
        )}
        {invoice.refundedMinor > 0 && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Refunded</span>
            <span className="tabular-nums">{formatUsd(invoice.refundedMinor)}</span>
          </div>
        )}
      </Card>

      {!closed && explain.data?.level && (
        <Card title="Payment outlook">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge level={explain.data.level} />
            <span className="text-sm text-muted-foreground" data-testid="risk-explanation">
              {explain.data.explanation}
            </span>
          </div>
        </Card>
      )}

      {invoice.activePromise && (
        <Card title="Promise to pay">
          <p className="text-sm">
            Client promised to pay on <strong>{invoice.activePromise.promisedDate}</strong> (
            {invoice.activePromise.source}).
          </p>
          <Button
            className="mt-2"
            variant="outline"
            size="sm"
            onClick={() => cancelPromise.mutate({ promiseId: invoice.activePromise!.id })}
          >
            Cancel promise
          </Button>
        </Card>
      )}

      {invoice.openDispute && (
        <Card title="Open dispute">
          <p className="text-sm">
            <strong>{invoice.openDispute.reason}</strong>
            {invoice.openDispute.detail ? `: ${invoice.openDispute.detail}` : ""}
          </p>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              resolveDispute.mutate({
                disputeId: invoice.openDispute!.id,
                outcome: "resolved",
                note: field(new FormData(e.currentTarget), "note"),
              });
            }}
          >
            <Input
              name="note"
              placeholder="Resolution note"
              aria-label="Resolution note"
              required
            />
            <Button type="submit" size="sm">
              Resolve
            </Button>
          </form>
        </Card>
      )}

      {!closed && (
        <Card title="Actions">
          <div className="flex flex-wrap items-end gap-4">
            {!invoice.activePromise && !invoice.openDispute && (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addPromise.mutate({
                    invoiceId,
                    promisedDate: field(new FormData(e.currentTarget), "date"),
                  });
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="promise-date">Client promised to pay by</Label>
                  <Input id="promise-date" name="date" type="date" required />
                </div>
                <Button type="submit" variant="outline" size="sm">
                  Record promise
                </Button>
              </form>
            )}
            {!invoice.openDispute && (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  openDispute.mutate({
                    invoiceId,
                    reason: field(new FormData(e.currentTarget), "reason"),
                  });
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="dispute-reason">Client disputes this invoice</Label>
                  <Input id="dispute-reason" name="reason" placeholder="Reason" required />
                </div>
                <Button type="submit" variant="outline" size="sm">
                  Record dispute
                </Button>
              </form>
            )}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                voidIt.mutate({ invoiceId, reason: voidReason });
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="void-reason">Void this invoice</Label>
                <Input
                  id="void-reason"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Reason"
                  required
                />
              </div>
              <Button type="submit" variant="destructive" size="sm">
                Void
              </Button>
            </form>
          </div>
        </Card>
      )}

      {invoice.payments.length > 0 && (
        <Card title="Payments">
          <ul className="divide-y text-sm">
            {invoice.payments.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <span>
                  {p.method === "ach" ? "Bank transfer" : "Card"} · {p.status}
                  {p.failureReason ? ` (${p.failureReason})` : ""}
                </span>
                <span className="tabular-nums">{formatUsd(p.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Timeline">
        <Timeline entries={timeline.entries} />
      </Card>
    </Page>
  );
}
