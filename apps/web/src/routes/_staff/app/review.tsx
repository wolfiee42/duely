import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Card, fieldClass, Page } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/app/review")({
  component: Review,
});

const MESSAGES: Record<string, string> = {
  "review.no_longer_needed": "That invoice no longer needs a reminder, so nothing was sent.",
  "review.not_found": "That item has already been handled.",
  "invoice.not_found": "We couldn't find that invoice.",
};

const KIND_LABELS: Record<string, string> = {
  draft_approval: "Reminder to approve",
  low_confidence_reply: "Reply to read",
  unmatched_inbound: "Reply we couldn't match",
  already_paid_claim: "Says they've paid",
  dead_job: "Reminder that failed",
  extraction_review: "Invoice to check",
};

type Item = ReturnType<typeof useItems>[number];

function useItems() {
  const { trpc } = Route.useRouteContext();
  return useSuspenseQuery(trpc.review.list.queryOptions()).data;
}

function Review() {
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const items = useItems();

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.review.list.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.review.count.queryKey() });
  };
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });
  const settled = (description: string) => async () => {
    await refresh();
    toast.add({ type: "success", description });
  };

  const approve = useMutation(
    trpc.review.approve.mutationOptions({
      onSuccess: settled("Approved. It will be sent shortly."),
      onError: async (e) => {
        onError(e);
        await refresh();
      },
    }),
  );
  const reject = useMutation(
    trpc.review.reject.mutationOptions({
      onSuccess: settled("Dropped. Nothing will be sent."),
      onError,
    }),
  );
  const dismiss = useMutation(
    trpc.review.dismiss.mutationOptions({ onSuccess: settled("Marked as handled."), onError }),
  );
  const assign = useMutation(
    trpc.review.assign.mutationOptions({
      onSuccess: settled("Reply attached to the invoice."),
      onError,
    }),
  );

  return (
    <Page title="Review">
      {items.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground" data-testid="review-empty">
            Nothing needs your attention.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <ItemCard
                item={item}
                busy={
                  approve.isPending || reject.isPending || dismiss.isPending || assign.isPending
                }
                onApprove={(edits) => approve.mutate({ itemId: item.id, edits })}
                onReject={() => reject.mutate({ itemId: item.id })}
                onDismiss={() => dismiss.mutate({ itemId: item.id })}
                onAssign={(invoiceId) => assign.mutate({ itemId: item.id, invoiceId })}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function ItemCard({
  item,
  busy,
  onApprove,
  onReject,
  onDismiss,
  onAssign,
}: {
  item: Item;
  busy: boolean;
  onApprove: (edits?: { subject: string; body: string }) => void;
  onReject: () => void;
  onDismiss: () => void;
  onAssign: (invoiceId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const heading = `${KIND_LABELS[item.kind] ?? item.kind}${item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}${item.clientName ? ` · ${item.clientName}` : ""}`;

  if (item.kind === "draft_approval") {
    return (
      <Card title={heading}>
        {editing ? (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              onApprove({ subject: field(f, "subject"), body: field(f, "body") });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`subject-${item.id}`}>Subject</Label>
              <Input
                id={`subject-${item.id}`}
                name="subject"
                defaultValue={item.subject ?? ""}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`body-${item.id}`}>Message</Label>
              <textarea
                id={`body-${item.id}`}
                name="body"
                rows={9}
                className={fieldClass}
                defaultValue={item.body ?? ""}
                required
              />
              <p className="text-xs text-muted-foreground">
                Keep <code>{"{{portal_url}}"}</code> where the pay link should go.
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                Approve and send
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">To {item.to}</p>
            <p className="mt-1 text-sm font-medium">{item.subject}</p>
            <pre className="mt-1 font-sans text-sm whitespace-pre-wrap">{item.body}</pre>
            <div className="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => onApprove()}>
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>
                Don't send
              </Button>
            </div>
          </>
        )}
      </Card>
    );
  }

  if (item.kind === "low_confidence_reply" || item.kind === "unmatched_inbound") {
    const unmatched = item.kind === "unmatched_inbound";
    return (
      <Card title={heading}>
        <p className="text-xs text-muted-foreground">
          From {(item.payload as { from?: string }).from ?? item.to ?? "unknown"}
        </p>
        <p className="mt-1 text-sm font-medium">{item.subject}</p>
        <pre className="mt-1 font-sans text-sm whitespace-pre-wrap">{item.body}</pre>
        {unmatched && (
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onAssign(field(new FormData(e.currentTarget), "invoiceId").trim());
            }}
          >
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor={`invoice-${item.id}`}>Attach to invoice</Label>
              <Input id={`invoice-${item.id}`} name="invoiceId" placeholder="Invoice ID" required />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              Attach
            </Button>
          </form>
        )}
        <div className="mt-3">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
            Mark as handled
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={heading}>
      <p className="text-sm text-muted-foreground">
        {item.kind === "dead_job"
          ? "We couldn't send this reminder after several tries. You can contact the client directly."
          : "This needs a look."}
      </p>
      <div className="mt-3">
        <Button size="sm" variant="outline" disabled={busy} onClick={onDismiss}>
          Mark as handled
        </Button>
      </div>
    </Card>
  );
}
