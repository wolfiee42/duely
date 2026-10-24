import { DomainError } from "./errors";

// SPEC 3.1. `transition` is pure: it returns the next status and effects as data, and the caller
// runs the effects inside the same DB transaction. The stored status is authoritative (D1).

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "overdue"
  | "promised"
  | "disputed"
  | "paid"
  | "void";

export type InvoiceEvent =
  | "SEND"
  | "VOID"
  | "VIEW"
  | "DUE_PASSED"
  | "PROMISE_CREATED"
  | "PROMISE_BROKEN"
  | "PROMISE_CANCELLED"
  | "DISPUTE_OPENED"
  | "DISPUTE_RESOLVED"
  | "PAYMENT_SUCCEEDED";

export type InvoiceEffect =
  | { type: "assign_number" }
  | { type: "freeze_items" }
  | { type: "set_sent_at" }
  | { type: "set_first_viewed_at" }
  | { type: "plan_jobs" }
  | { type: "replan_jobs" }
  | { type: "pause_jobs" }
  | { type: "cancel_jobs" }
  | { type: "email_invoice" }
  | { type: "store_prior_status"; status: InvoiceStatus }
  | { type: "close_promise"; as: "kept" }
  | { type: "notify_firm"; reason: "promise_broken" | "dispute_opened" }
  | { type: "send_receipt" };

export interface InvoiceState {
  status: InvoiceStatus;
  /** Set on the promise or dispute row (D2); carried here only for the event that restores it. */
  priorStatus?: InvoiceStatus;
}

export interface InvoiceContext {
  /** Today's date in the firm's timezone, `YYYY-MM-DD` (from the clock service, D6). */
  today: string;
  dueDate: string | null;
  firstViewedAt: Date | null;
  totalMinor: number;
  paidMinor: number;
  itemCount: number;
  chargesEnabled: boolean;
  hasInvoiceContact: boolean;
  hasActivePromise: boolean;
  hasOpenDispute: boolean;
}

const OPEN: readonly InvoiceStatus[] = ["sent", "viewed", "overdue", "promised", "disputed"];
const COLLECTIBLE: readonly InvoiceStatus[] = ["sent", "viewed", "overdue"];

const reject = (state: InvoiceState, event: InvoiceEvent, why?: string): never => {
  throw new DomainError(
    "invoice.invalid_transition",
    "conflict",
    why ?? `Cannot ${event} an invoice that is ${state.status}.`,
  );
};

const guard = (ok: boolean, code: string, message: string) => {
  if (!ok) throw new DomainError(code, "unprocessable", message);
};

/** "Re-evaluated": past due -> overdue, else viewed if it was ever viewed, else sent. */
export function reevaluate(
  ctx: Pick<InvoiceContext, "today" | "dueDate" | "firstViewedAt">,
): InvoiceStatus {
  if (ctx.dueDate !== null && ctx.dueDate < ctx.today) return "overdue";
  return ctx.firstViewedAt ? "viewed" : "sent";
}

export function transition(
  state: InvoiceState,
  event: InvoiceEvent,
  ctx: InvoiceContext,
): { state: InvoiceState; effects: InvoiceEffect[] } {
  const { status } = state;
  const to = (next: InvoiceStatus, effects: InvoiceEffect[] = [], priorStatus?: InvoiceStatus) => ({
    state: { status: next, ...(priorStatus ? { priorStatus } : {}) },
    effects,
  });

  if (status === "paid" || status === "void") return reject(state, event);

  switch (event) {
    case "SEND":
      if (status !== "draft") return reject(state, event);
      guard(
        ctx.chargesEnabled,
        "invoice.charges_not_enabled",
        "Finish connecting payments before sending.",
      );
      guard(ctx.itemCount > 0, "invoice.no_items", "Add at least one line item.");
      guard(ctx.totalMinor > 0, "invoice.zero_total", "The total must be more than zero.");
      guard(ctx.hasInvoiceContact, "invoice.no_contact", "Add a contact who receives invoices.");
      return to("sent", [
        { type: "assign_number" },
        { type: "freeze_items" },
        { type: "set_sent_at" },
        { type: "plan_jobs" },
        { type: "email_invoice" },
      ]);

    case "VOID":
      return to("void", status === "draft" ? [] : [{ type: "cancel_jobs" }]);

    case "VIEW":
      // The first view is a timestamp; status only moves off `sent`.
      if (status === "sent") return to("viewed", [{ type: "set_first_viewed_at" }]);
      if (OPEN.includes(status))
        return to(status, ctx.firstViewedAt ? [] : [{ type: "set_first_viewed_at" }]);
      return reject(state, event);

    case "DUE_PASSED":
      if (status !== "sent" && status !== "viewed") return reject(state, event);
      guard(
        ctx.dueDate !== null && ctx.dueDate < ctx.today,
        "invoice.not_due",
        "The invoice is not past due.",
      );
      // A promise or dispute holds the invoice in its own status instead.
      guard(
        !ctx.hasActivePromise && !ctx.hasOpenDispute,
        "invoice.on_hold",
        "A promise or dispute is open.",
      );
      return to("overdue");

    case "PROMISE_CREATED":
      if (!COLLECTIBLE.includes(status)) return reject(state, event);
      return to(
        "promised",
        [{ type: "store_prior_status", status }, { type: "pause_jobs" }],
        status,
      );

    case "PROMISE_BROKEN":
      if (status !== "promised") return reject(state, event);
      return to("overdue", [
        { type: "notify_firm", reason: "promise_broken" },
        { type: "replan_jobs" },
      ]);

    case "PROMISE_CANCELLED":
      if (status !== "promised") return reject(state, event);
      return to(reevaluate(ctx), [{ type: "replan_jobs" }]);

    case "DISPUTE_OPENED":
      if (!["sent", "viewed", "overdue", "promised"].includes(status)) return reject(state, event);
      guard(!ctx.hasOpenDispute, "invoice.dispute_exists", "A dispute is already open.");
      return to(
        "disputed",
        [
          { type: "store_prior_status", status },
          { type: "pause_jobs" },
          { type: "notify_firm", reason: "dispute_opened" },
        ],
        status,
      );

    case "DISPUTE_RESOLVED":
      if (status !== "disputed") return reject(state, event);
      return to(reevaluate(ctx), [{ type: "replan_jobs" }]);

    case "PAYMENT_SUCCEEDED":
      if (!OPEN.includes(status)) return reject(state, event);
      guard(
        ctx.paidMinor >= ctx.totalMinor,
        "invoice.underpaid",
        "The payment does not cover the total.",
      );
      return to("paid", [
        { type: "cancel_jobs" },
        { type: "close_promise", as: "kept" },
        { type: "send_receipt" },
      ]);
  }
}

/** Read-time status (D1): never stale between scheduler sweeps. Only `sent` and `viewed` can lapse. */
export function effectiveStatus(
  status: InvoiceStatus,
  ctx: Pick<InvoiceContext, "today" | "dueDate">,
): InvoiceStatus {
  if (
    (status === "sent" || status === "viewed") &&
    ctx.dueDate !== null &&
    ctx.dueDate < ctx.today
  ) {
    return "overdue";
  }
  return status;
}
