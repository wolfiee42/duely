import { Button } from "@repo/ui/components/button";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";
import { useState } from "react";

const route = getRouteApi("/_staff/_app/");

// What the assistant read from a reply, as stored on the item. Typed here: the browser never imports server code.
interface Classification {
  label: string;
  promisedDate: string | null;
  quote: string | null;
  decision: string;
}

const KIND_CHIPS: Record<string, { label: string; tone: string }> = {
  draft_approval: { label: "Draft", tone: "bg-warning-soft text-warning" },
  low_confidence_reply: { label: "Reply", tone: "bg-violet-soft text-violet" },
  unmatched_inbound: { label: "Reply", tone: "bg-violet-soft text-violet" },
  already_paid_claim: { label: "Says paid", tone: "bg-info-soft text-info" },
  dead_job: { label: "Failed", tone: "bg-danger-soft text-danger" },
  extraction_review: { label: "Check", tone: "bg-info-soft text-info" },
};

const REPLY_TITLES: Record<string, string> = {
  promise: "Looks like a promise to pay",
  dispute: "Looks like a dispute",
  already_paid: "Says they've already paid",
};

type ReviewItem = ReturnType<typeof useReviewItems>[number];

function useReviewItems() {
  const { trpc } = route.useRouteContext();
  return useSuspenseQuery(trpc.review.list.queryOptions()).data;
}

function describe(item: ReviewItem) {
  const classification = (item.payload as { classification?: Classification }).classification;
  const reading = classification && classification.decision !== "failed" ? classification : null;
  const title =
    item.kind === "draft_approval"
      ? (item.subject ?? "Reminder to approve")
      : ((reading && REPLY_TITLES[reading.label]) ?? item.subject ?? "Needs a look");
  const note = reading?.quote ? `“${reading.quote}”` : item.body;
  return { classification: reading, title, note };
}

/** The review queue as a stack of cards: act on the top one without leaving the dashboard. */
export function DecisionDeck({ className }: { className: string }) {
  const { trpc } = route.useRouteContext();
  const queryClient = useQueryClient();
  const items = useReviewItems();
  // "Not now" sends a card to the back of the stack for this visit only; nothing is saved.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<"done" | "skip" | null>(null);

  const deck = [
    ...items.filter((i) => !skipped.includes(i.id)),
    ...skipped.flatMap((id) => items.filter((i) => i.id === id)),
  ];
  const top = deck[0];

  const settle = (description: string) => async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.review.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.review.count.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.dashboard.get.queryKey() }),
    ]);
    setLeaving(null);
    toast.add({ type: "success", description });
  };
  const failed = async () => {
    setLeaving(null);
    // The item may already have been handled elsewhere; refresh so the stack is accurate.
    await queryClient.invalidateQueries({ queryKey: trpc.review.list.queryKey() });
    toast.add({ type: "error", description: "Something went wrong. Open review to handle it." });
  };

  const approve = useMutation(
    trpc.review.approve.mutationOptions({
      onSuccess: settle("Approved. It will be sent shortly."),
      onError: failed,
    }),
  );
  const accept = useMutation(
    trpc.review.accept.mutationOptions({ onSuccess: settle("Done."), onError: failed }),
  );
  const dismiss = useMutation(
    trpc.review.dismiss.mutationOptions({
      onSuccess: settle("Marked as handled."),
      onError: failed,
    }),
  );
  const busy = approve.isPending || accept.isPending || dismiss.isPending;

  if (!top) {
    return (
      <section className={`${className} flex flex-col rounded-2xl border bg-card p-6 shadow-card`}>
        <span className="grid size-10 place-items-center rounded-xl bg-success-soft text-success [&_svg]:size-5">
          <CheckCircle2Icon />
        </span>
        <p className="mt-4 text-xl font-semibold">All caught up</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing is waiting for your decision. Reminders keep going out on schedule.
        </p>
      </section>
    );
  }

  const chip = KIND_CHIPS[top.kind] ?? { label: "Review", tone: "bg-muted text-muted-foreground" };
  const { classification, title, note } = describe(top);

  // The one thing the top card can do in place; anything needing a form or a choice goes to Review.
  let primary: { label: string; run: () => void } | null = null;
  if (top.kind === "draft_approval") {
    primary = { label: "Approve and send", run: () => approve.mutate({ itemId: top.id }) };
  } else if (top.kind === "low_confidence_reply" && classification?.label === "promise") {
    const promisedDate = classification.promisedDate;
    if (promisedDate)
      primary = {
        label: "Record the promise",
        run: () => accept.mutate({ itemId: top.id, promisedDate }),
      };
  } else if (top.kind === "low_confidence_reply" && classification?.label === "dispute") {
    primary = { label: "Open a dispute", run: () => accept.mutate({ itemId: top.id }) };
  } else if (top.kind === "already_paid_claim" || top.kind === "dead_job") {
    primary = { label: "Mark as handled", run: () => dismiss.mutate({ itemId: top.id }) };
  }

  const act = (run: () => void) => () => {
    setLeaving("done");
    run();
  };
  const notNow = () => {
    setLeaving("skip");
    setTimeout(() => {
      setSkipped((ids) => [...ids.filter((id) => id !== top.id), top.id]);
      setLeaving(null);
    }, 280);
  };

  const position = items.findIndex((i) => i.id === top.id) + 1;
  const reference = [top.invoiceNumber, top.clientName].filter(Boolean).join(" · ");

  return (
    <section
      className={`${className} flex min-w-0 flex-col rounded-2xl border border-primary bg-primary p-6 text-primary-foreground`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm opacity-90">
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-current" />
          Needs your decision
        </p>
        {items.length <= 6 && (
          <div className="flex gap-1.5" aria-hidden>
            {items.map((i) => (
              <span
                key={i.id}
                className={`h-1 rounded-full transition-all ${i.id === top.id ? "w-8 bg-white" : "w-5 bg-white/35"}`}
              />
            ))}
          </div>
        )}
      </div>
      <h2 className="mt-3 text-2xl leading-tight font-bold tracking-tight">
        {items.length === 1 ? "One decision to make" : `${items.length} decisions to make`}
      </h2>

      <div className="relative mt-4 min-h-0 flex-1">
        {deck.length > 2 && (
          <div aria-hidden className="absolute inset-x-6 top-4 bottom-0 rounded-xl bg-white/35" />
        )}
        {deck.length > 1 && (
          <div aria-hidden className="absolute inset-x-3 top-2 bottom-2.5 rounded-xl bg-white/60" />
        )}
        <div
          key={top.id}
          className={`absolute inset-x-0 top-0 bottom-5 z-10 flex animate-in flex-col rounded-xl bg-card p-5 text-card-foreground shadow-xl duration-300 zoom-in-95 fade-in motion-reduce:animate-none ${
            leaving === "done"
              ? "translate-x-12 rotate-3 opacity-0 transition-[transform,opacity] duration-300"
              : leaving === "skip"
                ? "-translate-x-12 -rotate-3 opacity-0 transition-[transform,opacity] duration-300"
                : ""
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${chip.tone}`}>
              {chip.label}
            </span>
            {position > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {position} of {items.length}
              </span>
            )}
          </div>
          <p className="mt-3 line-clamp-2 font-semibold">{title}</p>
          {reference && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{reference}</p>
          )}
          {note && (
            <p className="mt-3 [display:-webkit-box] min-h-0 flex-1 overflow-hidden rounded-lg bg-muted px-3 py-2.5 text-sm [-webkit-box-orient:vertical] [-webkit-line-clamp:4]">
              {note}
            </p>
          )}
          <div className="mt-3 flex shrink-0 gap-2">
            {items.length > 1 && (
              <Button variant="outline" disabled={busy || leaving !== null} onClick={notNow}>
                Not now
              </Button>
            )}
            {primary ? (
              <Button
                className="flex-1"
                disabled={busy || leaving !== null}
                onClick={act(primary.run)}
              >
                {primary.label}
              </Button>
            ) : (
              <Button className="flex-1" render={<Link to="/review" />}>
                Open in review <ArrowRightIcon />
              </Button>
            )}
          </div>
          {primary && (
            <Link
              to="/review"
              className="mt-3 block shrink-0 text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Edit or see details
            </Link>
          )}
        </div>
      </div>

      <p className="mt-auto text-xs opacity-85">Nothing goes out until you approve it.</p>
    </section>
  );
}
