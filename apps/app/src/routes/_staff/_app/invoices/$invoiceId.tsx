import { formatUsd } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { InvoiceEditor } from "#/components/invoice-editor.tsx";
import { Timeline } from "#/components/timeline.tsx";
import { AiMark, Avatar, Card, Page, RiskBadge, StatusBadge } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/invoices/$invoiceId")({
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
        await navigate({ to: "/invoices" });
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

  const balance = invoice.totalMinor - invoice.paidMinor + invoice.refundedMinor;

  return (
    <Page
      title={`Invoice ${invoice.number ?? ""}`}
      description={`${invoice.client.name} · issued ${invoice.issueDate}`}
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
            <DownloadIcon /> PDF
          </Button>
        </>
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Line items">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {invoice.items.map((i) => (
                  <tr key={i.id}>
                    <td className="py-3 font-medium">{i.description}</td>
                    <td className="py-3 text-right text-muted-foreground">
                      {Number(i.quantity)} × {formatUsd(i.unitAmountMinor)}
                    </td>
                    <td className="py-3 text-right tabular-nums">{formatUsd(i.amountMinor)}</td>
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

          {invoice.payments.length > 0 && (
            <Card title="Payments">
              <ul className="-my-2 divide-y text-sm">
                {invoice.payments.map((p) => (
                  <li key={p.id} className="flex justify-between py-3">
                    <span>
                      {p.method === "ach" ? "Bank transfer" : "Card"} · {p.status}
                      {p.failureReason ? ` (${p.failureReason})` : ""}
                    </span>
                    <span className="font-medium tabular-nums">{formatUsd(p.amountMinor)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Timeline">
            <Timeline entries={timeline.entries} />
          </Card>
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-6">
          <Card>
            <p className="text-sm text-muted-foreground">
              {invoice.status === "paid" ? "Paid in full" : "Balance due"}
            </p>
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
              {formatUsd(invoice.status === "paid" ? invoice.paidMinor : balance)}
            </p>
            <dl className="mt-4 grid gap-3 border-t pt-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Client</dt>
                <dd>
                  <Link
                    to="/clients/$clientId"
                    params={{ clientId: invoice.client.id }}
                    className="flex items-center gap-2 font-medium hover:underline"
                  >
                    <Avatar name={invoice.client.name} />
                    {invoice.client.name}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Issued</dt>
                <dd className="tabular-nums">{invoice.issueDate}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Due</dt>
                <dd className="tabular-nums">{invoice.dueDate}</dd>
              </div>
            </dl>
          </Card>

          {!closed && explain.data?.level && (
            <Card title="Payment outlook" action={<AiMark />}>
              <RiskBadge level={explain.data.level} />
              <p className="mt-2 text-sm text-muted-foreground" data-testid="risk-explanation">
                {explain.data.explanation}
              </p>
            </Card>
          )}

          {invoice.activePromise && (
            <Card title="Promise to pay">
              <p className="text-sm">
                Client promised to pay on <strong>{invoice.activePromise.promisedDate}</strong> (
                {invoice.activePromise.source}).
              </p>
              <Button
                className="mt-3"
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
                className="mt-3 flex gap-2"
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
              <div className="flex flex-col gap-4">
                {!invoice.activePromise && !invoice.openDispute && (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      addPromise.mutate({
                        invoiceId,
                        promisedDate: field(new FormData(e.currentTarget), "date"),
                      });
                    }}
                  >
                    <div className="grid flex-1 gap-1.5">
                      <Label htmlFor="promise-date">Client promised to pay by</Label>
                      <Input id="promise-date" name="date" type="date" required />
                    </div>
                    <Button type="submit" variant="outline" size="sm" className="w-fit">
                      Record promise
                    </Button>
                  </form>
                )}
                {!invoice.openDispute && (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      openDispute.mutate({
                        invoiceId,
                        reason: field(new FormData(e.currentTarget), "reason"),
                      });
                    }}
                  >
                    <div className="grid flex-1 gap-1.5">
                      <Label htmlFor="dispute-reason">Client disputes this invoice</Label>
                      <Input id="dispute-reason" name="reason" placeholder="Reason" required />
                    </div>
                    <Button type="submit" variant="outline" size="sm" className="w-fit">
                      Record dispute
                    </Button>
                  </form>
                )}
                <form
                  className="flex flex-col gap-2 border-t pt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    voidIt.mutate({ invoiceId, reason: voidReason });
                  }}
                >
                  <div className="grid flex-1 gap-1.5">
                    <Label htmlFor="void-reason">Void this invoice</Label>
                    <Input
                      id="void-reason"
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      placeholder="Reason"
                      required
                    />
                  </div>
                  <Button type="submit" variant="destructive" size="sm" className="w-fit">
                    Void
                  </Button>
                </form>
              </div>
            </Card>
          )}
        </aside>
      </div>
    </Page>
  );
}
