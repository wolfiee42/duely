import { Button } from "@repo/ui/components/button";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon, InfoIcon } from "lucide-react";
import { useState } from "react";

import { Card, fieldClass, Page } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/demo")({
  component: DemoTools,
});

const JUMPS = [1, 3, 7, 14, 30] as const;
const REPLIES = [
  "Sorry for the delay. I'll pay this on Friday.",
  "We already paid this by bank transfer last week.",
  "This amount is wrong, we dispute the hours billed.",
  "Can we set up a payment plan?",
];

const TOUR: Array<[key: "sent" | "advanced" | "replied" | "promised" | "paid", text: string]> = [
  ["sent", "Send an invoice (open a draft and press Send)"],
  ["advanced", "Fast-forward time with the buttons below"],
  ["replied", "Type a client reply, like “I'll pay Friday”"],
  ["promised", "Go to Review and record the promise it found"],
  ["paid", "Open the client's email below, follow its link and pay"],
];

const LINK = /(https?:\/\/[^\s)]+)/g;

function DemoTools() {
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { data: status } = useSuspenseQuery(trpc.demo.status.queryOptions());
  const { data: outbox } = useSuspenseQuery(trpc.demo.outbox.queryOptions());
  const { data: invoices } = useSuspenseQuery(trpc.invoices.list.queryOptions());
  const { data: firm } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const [confirmReset, setConfirmReset] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const open = invoices.filter((i) => ["sent", "viewed", "overdue"].includes(i.effectiveStatus));
  const refresh = async () => {
    await queryClient.invalidateQueries();
  };
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        trpcErrorInfo(error).domainCode === "demo.not_matched"
          ? "That reply couldn't be matched to the invoice."
          : "Something went wrong. Please try again.",
    });

  const advance = useMutation(
    trpc.demo.advanceClock.mutationOptions({
      onSuccess: async (r) => {
        setNote(
          `It's now ${r.today}. ${r.cycle.claimed} reminder${r.cycle.claimed === 1 ? "" : "s"} came due; ${r.cycle.drafted} waiting for your approval in Review.`,
        );
        await refresh();
      },
      onError,
    }),
  );
  const reply = useMutation(
    trpc.demo.simulateReply.mutationOptions({
      onSuccess: async () => {
        setNote("The reply arrived and was read. Open Review to see what the assistant found.");
        await refresh();
      },
      onError,
    }),
  );
  const reset = useMutation(
    trpc.demo.reset.mutationOptions({
      onSuccess: async () => {
        setConfirmReset(false);
        setNote("Demo data is back to the start.");
        await refresh();
      },
      onError,
    }),
  );

  const done = TOUR.filter(([k]) => status.tour[k]).length;

  return (
    <Page
      title="Demo tools"
      actions={
        firm.role === "owner" &&
        (confirmReset ? (
          <>
            <span className="text-xs text-muted-foreground">
              Everything you added will be removed.
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              Reset
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)}>
            Reset demo data
          </Button>
        ))
      }
    >
      <p className="text-sm text-muted-foreground">
        This is a sample firm. Emails stay in the outbox below instead of being delivered, and you
        control the clock.
      </p>
      {note && (
        <p
          className="flex items-start gap-2.5 rounded-xl border border-info/20 bg-info-soft p-3.5 text-sm text-info"
          role="status"
          data-testid="demo-note"
        >
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {note}
        </p>
      )}

      <Card title={`Quick tour · ${done} of ${TOUR.length}`}>
        <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${(done / TOUR.length) * 100}%` }}
          />
        </div>
        <ol className="grid gap-3 text-sm" data-testid="tour">
          {TOUR.map(([key, text]) => (
            <li key={key} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border ${status.tour[key] ? "border-transparent bg-success-soft text-success" : ""}`}
              >
                {status.tour[key] && <CheckIcon className="size-3" />}
              </span>
              <span className={status.tour[key] ? "text-muted-foreground line-through" : ""}>
                {text}
                <span className="sr-only">{status.tour[key] ? " (done)" : " (to do)"}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Time">
        <p className="mb-3 text-sm">
          The firm's date is <strong data-testid="demo-today">{status.today}</strong>
          {status.offsetDays > 0 && ` (${status.offsetDays} days ahead)`}.
        </p>
        <div className="flex flex-wrap gap-2">
          {JUMPS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant="outline"
              disabled={advance.isPending}
              onClick={() => advance.mutate({ days: d })}
            >
              +{d} {d === 1 ? "day" : "days"}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Reminders that fall due are drafted or sent straight away.
        </p>
      </Card>

      <Card title="Pretend to be the client">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            reply.mutate({ invoiceId: field(f, "invoice"), text: field(f, "text") });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="invoice">Reply to invoice</Label>
            <select id="invoice" name="invoice" className={fieldClass} required>
              {open.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number} · {i.clientName}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="text">Their message</Label>
            <textarea id="text" name="text" rows={3} className={fieldClass} required />
            <div className="flex flex-wrap gap-1.5">
              {REPLIES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-muted"
                  onClick={() => {
                    const box = document.getElementById("text") as HTMLTextAreaElement | null;
                    if (box) box.value = r;
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <Button
            type="submit"
            size="sm"
            className="w-fit"
            disabled={reply.isPending || open.length === 0}
          >
            Send reply
          </Button>
        </form>
      </Card>

      <Card title="Outbox">
        <p className="mb-2 text-xs text-muted-foreground">
          Everything this firm has emailed, newest first. Links open the client's view.
        </p>
        <ul className="divide-y text-sm" data-testid="outbox">
          {outbox.slice(0, 30).map((m) => (
            <li key={m.id} className="py-2">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                      {m.direction === "in" ? "from client" : m.kind}
                    </span>
                    {m.subject}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {m.direction === "in" ? "from" : "to"} {m.to}
                  </span>
                </summary>
                <pre className="mt-2 font-sans text-sm whitespace-pre-wrap">
                  {(m.body ?? "").split(LINK).map((part, i) =>
                    /^https?:\/\//.test(part) ? (
                      <a
                        key={i}
                        href={part}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-4"
                      >
                        {part}
                      </a>
                    ) : (
                      part
                    ),
                  )}
                </pre>
              </details>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          <Link
            to="/review"
            className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
          >
            Open review <ArrowRightIcon className="size-4" />
          </Link>
        </p>
      </Card>
    </Page>
  );
}
