import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BanknoteIcon,
  FileSearchIcon,
  InboxIcon,
  MailCheckIcon,
  MailQuestionIcon,
  MailXIcon,
  MessageSquareTextIcon,
  PartyPopperIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { AiMark, EmptyState, fieldClass, Page } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/review")({
  component: Review,
});

const MESSAGES: Record<string, string> = {
  "review.no_longer_needed": "That invoice no longer needs a reminder, so nothing was sent.",
  "review.not_found": "That item has already been handled.",
  "invoice.not_found": "We couldn't find that invoice.",
  "review.needs_date": "Choose the date they promised.",
  "invoice.invalid_transition": "This invoice has changed since the reply came in. Check it first.",
  "promise.date_in_past": "Choose a date from today onwards.",
};

// What the assistant read from a reply, as stored on the item. Typed here: the browser never imports server code.
interface Classification {
  label: string;
  confidence: number;
  quote: string | null;
  promisedDate: string | null;
  downgraded: string | null;
  decision: string;
}

const DOWNGRADE_NOTES: Record<string, string> = {
  quote_not_in_message:
    "The assistant's reasoning didn't match the email, so it needs your judgment.",
  date_mismatch: "The date couldn't be confirmed from the email's wording.",
  date_not_understood: "The date in the email isn't clear enough to act on.",
  date_too_far: "The date is more than 90 days away.",
};

const LABEL_TEXT: Record<string, string> = {
  promise: "Looks like a promise to pay",
  dispute: "Looks like a dispute",
  already_paid: "Says they've already paid",
  needs_human: "Needs a person",
  other: "Doesn't need action",
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

  const accept = useMutation(
    trpc.review.accept.mutationOptions({ onSuccess: settled("Done."), onError }),
  );
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
    <Page
      title="Review"
      description="Drafts and replies waiting on your decision. Nothing is sent until you approve it."
    >
      {items.length === 0 ? (
        <EmptyState icon={<PartyPopperIcon />}>
          <span data-testid="review-empty">Nothing needs your attention.</span>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <ItemCard
                item={item}
                busy={
                  approve.isPending ||
                  reject.isPending ||
                  dismiss.isPending ||
                  assign.isPending ||
                  accept.isPending
                }
                onApprove={(edits) => approve.mutate({ itemId: item.id, edits })}
                onReject={() => reject.mutate({ itemId: item.id })}
                onDismiss={() => dismiss.mutate({ itemId: item.id })}
                onAssign={(invoiceId) => assign.mutate({ itemId: item.id, invoiceId })}
                onAccept={(promisedDate) => accept.mutate({ itemId: item.id, promisedDate })}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

const KIND_ICONS: Record<string, LucideIcon> = {
  draft_approval: MailCheckIcon,
  low_confidence_reply: MessageSquareTextIcon,
  unmatched_inbound: MailQuestionIcon,
  already_paid_claim: BanknoteIcon,
  dead_job: MailXIcon,
  extraction_review: FileSearchIcon,
};

/** One review item: what it is, which invoice it belongs to, then whatever it needs from a person. */
function ItemShell({ item, children }: { item: Item; children: ReactNode }) {
  const Icon = KIND_ICONS[item.kind] ?? InboxIcon;
  return (
    <div className="rounded-xl border bg-card p-5 shadow-card">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{KIND_LABELS[item.kind] ?? item.kind}</h2>
          {(item.invoiceNumber || item.clientName) && (
            <p className="truncate text-xs text-muted-foreground">
              {[item.invoiceNumber, item.clientName].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function ItemCard({
  item,
  busy,
  onApprove,
  onReject,
  onDismiss,
  onAssign,
  onAccept,
}: {
  item: Item;
  busy: boolean;
  onApprove: (edits?: { subject: string; body: string }) => void;
  onReject: () => void;
  onDismiss: () => void;
  onAssign: (invoiceId: string) => void;
  onAccept: (promisedDate?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const classification = (item.payload as { classification?: Classification }).classification;

  if (item.kind === "draft_approval") {
    return (
      <ItemShell item={item}>
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
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              To {item.to}
              {(item.payload as { by?: string }).by === "ai" && (
                <AiMark label="Written by the assistant" />
              )}
            </p>
            <p className="mt-1 text-sm font-medium">{item.subject}</p>
            <pre className="mt-2 rounded-lg border bg-muted/50 p-3 font-sans text-sm whitespace-pre-wrap">
              {item.body}
            </pre>
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
      </ItemShell>
    );
  }

  if (item.kind === "low_confidence_reply" || item.kind === "unmatched_inbound") {
    const unmatched = item.kind === "unmatched_inbound";
    return (
      <ItemShell item={item}>
        <p className="text-xs text-muted-foreground">
          From {(item.payload as { from?: string }).from ?? item.to ?? "unknown"}
        </p>
        <p className="mt-1 text-sm font-medium">{item.subject}</p>
        <pre className="mt-2 rounded-lg border bg-muted/50 p-3 font-sans text-sm whitespace-pre-wrap">
          {item.body}
        </pre>
        {classification && classification.decision !== "failed" && (
          <Suggestion c={classification} busy={busy} onAccept={onAccept} onDismiss={onDismiss} />
        )}
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
      </ItemShell>
    );
  }

  return (
    <ItemShell item={item}>
      {item.kind === "already_paid_claim" && (
        <>
          <p className="text-sm">
            The client says they've paid. Reminders are paused until you check your bank.
          </p>
          {item.body && (
            <pre className="mt-2 rounded-lg border bg-muted/50 p-3 font-sans text-sm whitespace-pre-wrap">
              {item.body}
            </pre>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            If they haven't paid, mark this as handled and reminders will resume. If they have,
            their payment will mark the invoice paid.
          </p>
        </>
      )}
      {item.kind === "extraction_review" && (
        <p className="text-sm">
          This draft was read from a file and has details worth checking
          {item.invoiceId && (
            <>
              {" — "}
              <Link
                to="/invoices/$invoiceId"
                params={{ invoiceId: item.invoiceId }}
                className="underline underline-offset-4"
              >
                open the draft
              </Link>
            </>
          )}
          .
        </p>
      )}
      {item.kind === "dead_job" && (
        <p className="text-sm text-muted-foreground">
          We couldn't send this reminder after several tries. You can contact the client directly.
        </p>
      )}
      <div className="mt-3">
        <Button size="sm" variant="outline" disabled={busy} onClick={onDismiss}>
          Mark as handled
        </Button>
      </div>
    </ItemShell>
  );
}

/** The assistant's reading of a reply, with the words it relied on, and what a person can do with it. */
function Suggestion({
  c,
  busy,
  onAccept,
  onDismiss,
}: {
  c: Classification;
  busy: boolean;
  onAccept: (promisedDate?: string) => void;
  onDismiss: () => void;
}) {
  const [date, setDate] = useState(c.promisedDate ?? "");
  const actionable = c.label === "promise" || c.label === "dispute";
  return (
    <div
      className="mt-3 rounded-lg border border-violet/20 bg-violet-soft/40 p-3 text-sm"
      data-testid="suggestion"
    >
      <div className="mb-1">
        <AiMark label="Assistant's reading" />
      </div>
      <p className="font-medium">
        {LABEL_TEXT[c.label] ?? c.label}{" "}
        <span className="font-normal text-muted-foreground">
          ({Math.round(c.confidence * 100)}% sure)
        </span>
      </p>
      {c.quote && <p className="mt-1 text-muted-foreground">“{c.quote}”</p>}
      {c.downgraded && (
        <p className="mt-1 text-warning">
          {DOWNGRADE_NOTES[c.downgraded] ?? "Please check this one yourself."}
        </p>
      )}
      {actionable && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {c.label === "promise" && (
            <div className="grid gap-1">
              <Label htmlFor="promise-date" className="text-xs">
                Promised date
              </Label>
              <Input
                id="promise-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onAccept(c.label === "promise" ? date || undefined : undefined)}
          >
            {c.label === "promise" ? "Record the promise" : "Open a dispute"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
            Ignore
          </Button>
        </div>
      )}
    </div>
  );
}
