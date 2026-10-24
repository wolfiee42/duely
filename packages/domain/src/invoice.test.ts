import { describe, expect, it } from "vite-plus/test";

import {
  effectiveStatus,
  reevaluate,
  transition,
  type InvoiceContext,
  type InvoiceEvent,
  type InvoiceStatus,
} from "./invoice";

const base: InvoiceContext = {
  today: "2026-03-10",
  dueDate: "2026-03-20",
  firstViewedAt: null,
  totalMinor: 10_000,
  paidMinor: 0,
  itemCount: 1,
  chargesEnabled: true,
  hasInvoiceContact: true,
  hasActivePromise: false,
  hasOpenDispute: false,
};
const ctx = (over: Partial<InvoiceContext> = {}): InvoiceContext => ({ ...base, ...over });
const pastDue = { dueDate: "2026-03-01" };

const ALL: InvoiceStatus[] = [
  "draft",
  "sent",
  "viewed",
  "overdue",
  "promised",
  "disputed",
  "paid",
  "void",
];
const EVENTS: InvoiceEvent[] = [
  "SEND",
  "VOID",
  "VIEW",
  "DUE_PASSED",
  "PROMISE_CREATED",
  "PROMISE_BROKEN",
  "PROMISE_CANCELLED",
  "DISPUTE_OPENED",
  "DISPUTE_RESOLVED",
  "PAYMENT_SUCCEEDED",
];

const run = (status: InvoiceStatus, event: InvoiceEvent, c = ctx()) =>
  transition({ status }, event, c);
const effectTypes = (r: ReturnType<typeof run>) => r.effects.map((e) => e.type);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no error";
};

describe("legal transitions (SPEC 3.1)", () => {
  it.each([
    [
      "draft",
      "SEND",
      {},
      "sent",
      ["assign_number", "freeze_items", "set_sent_at", "plan_jobs", "email_invoice"],
    ],
    ["draft", "VOID", {}, "void", []],
    ["sent", "VIEW", {}, "viewed", ["set_first_viewed_at"]],
    ["sent", "DUE_PASSED", pastDue, "overdue", []],
    ["viewed", "DUE_PASSED", pastDue, "overdue", []],
    ["sent", "PROMISE_CREATED", {}, "promised", ["store_prior_status", "pause_jobs"]],
    ["viewed", "PROMISE_CREATED", {}, "promised", ["store_prior_status", "pause_jobs"]],
    ["overdue", "PROMISE_CREATED", pastDue, "promised", ["store_prior_status", "pause_jobs"]],
    ["promised", "PROMISE_BROKEN", {}, "overdue", ["notify_firm", "replan_jobs"]],
    ["promised", "PROMISE_CANCELLED", {}, "sent", ["replan_jobs"]],
    ["sent", "DISPUTE_OPENED", {}, "disputed", ["store_prior_status", "pause_jobs", "notify_firm"]],
    [
      "viewed",
      "DISPUTE_OPENED",
      {},
      "disputed",
      ["store_prior_status", "pause_jobs", "notify_firm"],
    ],
    [
      "overdue",
      "DISPUTE_OPENED",
      pastDue,
      "disputed",
      ["store_prior_status", "pause_jobs", "notify_firm"],
    ],
    [
      "promised",
      "DISPUTE_OPENED",
      {},
      "disputed",
      ["store_prior_status", "pause_jobs", "notify_firm"],
    ],
    ["disputed", "DISPUTE_RESOLVED", {}, "sent", ["replan_jobs"]],
    [
      "sent",
      "PAYMENT_SUCCEEDED",
      { paidMinor: 10_000 },
      "paid",
      ["cancel_jobs", "close_promise", "send_receipt"],
    ],
    [
      "viewed",
      "PAYMENT_SUCCEEDED",
      { paidMinor: 10_000 },
      "paid",
      ["cancel_jobs", "close_promise", "send_receipt"],
    ],
    [
      "overdue",
      "PAYMENT_SUCCEEDED",
      { paidMinor: 10_000 },
      "paid",
      ["cancel_jobs", "close_promise", "send_receipt"],
    ],
    [
      "promised",
      "PAYMENT_SUCCEEDED",
      { paidMinor: 10_000 },
      "paid",
      ["cancel_jobs", "close_promise", "send_receipt"],
    ],
    [
      "disputed",
      "PAYMENT_SUCCEEDED",
      { paidMinor: 10_000 },
      "paid",
      ["cancel_jobs", "close_promise", "send_receipt"],
    ],
    ["sent", "VOID", {}, "void", ["cancel_jobs"]],
    ["viewed", "VOID", {}, "void", ["cancel_jobs"]],
    ["overdue", "VOID", pastDue, "void", ["cancel_jobs"]],
    ["promised", "VOID", {}, "void", ["cancel_jobs"]],
    ["disputed", "VOID", {}, "void", ["cancel_jobs"]],
  ] as const)("%s + %s -> %s", (from, event, over, to, effects) => {
    const result = run(from, event, ctx(over));
    expect(result.state.status).toBe(to);
    expect(effectTypes(result)).toEqual(effects);
  });

  it("every (status, event) pair outside the table is rejected", () => {
    const legal = new Set([
      "draft:SEND",
      "draft:VOID",
      "sent:VIEW",
      "sent:DUE_PASSED",
      "sent:PROMISE_CREATED",
      "sent:DISPUTE_OPENED",
      "sent:PAYMENT_SUCCEEDED",
      "sent:VOID",
      "viewed:VIEW",
      "viewed:DUE_PASSED",
      "viewed:PROMISE_CREATED",
      "viewed:DISPUTE_OPENED",
      "viewed:PAYMENT_SUCCEEDED",
      "viewed:VOID",
      "overdue:VIEW",
      "overdue:PROMISE_CREATED",
      "overdue:DISPUTE_OPENED",
      "overdue:PAYMENT_SUCCEEDED",
      "overdue:VOID",
      "promised:VIEW",
      "promised:PROMISE_BROKEN",
      "promised:PROMISE_CANCELLED",
      "promised:DISPUTE_OPENED",
      "promised:PAYMENT_SUCCEEDED",
      "promised:VOID",
      "disputed:VIEW",
      "disputed:DISPUTE_RESOLVED",
      "disputed:PAYMENT_SUCCEEDED",
      "disputed:VOID",
    ]);
    for (const status of ALL) {
      for (const event of EVENTS) {
        if (legal.has(`${status}:${event}`)) continue;
        expect([
          status,
          event,
          code(() => run(status, event, ctx({ ...pastDue, paidMinor: 10_000 }))),
        ]).toEqual([status, event, "invoice.invalid_transition"]);
      }
    }
  });
});

describe("terminal states", () => {
  it.each(["paid", "void"] as const)("%s rejects every event", (status) => {
    for (const event of EVENTS) {
      expect(code(() => run(status, event, ctx({ paidMinor: 10_000, ...pastDue })))).toBe(
        "invoice.invalid_transition",
      );
    }
  });
});

describe("guards", () => {
  it("SEND needs connected payments, an item, a positive total and a contact", () => {
    expect(code(() => run("draft", "SEND", ctx({ chargesEnabled: false })))).toBe(
      "invoice.charges_not_enabled",
    );
    expect(code(() => run("draft", "SEND", ctx({ itemCount: 0 })))).toBe("invoice.no_items");
    expect(code(() => run("draft", "SEND", ctx({ totalMinor: 0 })))).toBe("invoice.zero_total");
    expect(code(() => run("draft", "SEND", ctx({ hasInvoiceContact: false })))).toBe(
      "invoice.no_contact",
    );
  });

  it("DUE_PASSED needs a past due date and no promise or dispute", () => {
    expect(code(() => run("sent", "DUE_PASSED"))).toBe("invoice.not_due");
    expect(code(() => run("sent", "DUE_PASSED", ctx({ dueDate: null })))).toBe("invoice.not_due");
    expect(code(() => run("sent", "DUE_PASSED", ctx({ ...pastDue, hasActivePromise: true })))).toBe(
      "invoice.on_hold",
    );
    expect(code(() => run("sent", "DUE_PASSED", ctx({ ...pastDue, hasOpenDispute: true })))).toBe(
      "invoice.on_hold",
    );
    expect(code(() => run("sent", "DUE_PASSED", ctx({ today: "2026-03-20" })))).toBe(
      "invoice.not_due",
    ); // due today is not late
  });

  it("DISPUTE_OPENED refuses a second open dispute", () => {
    expect(code(() => run("sent", "DISPUTE_OPENED", ctx({ hasOpenDispute: true })))).toBe(
      "invoice.dispute_exists",
    );
  });

  it("PAYMENT_SUCCEEDED needs the ledger to cover the total (no partial payments, D3)", () => {
    expect(code(() => run("sent", "PAYMENT_SUCCEEDED", ctx({ paidMinor: 9_999 })))).toBe(
      "invoice.underpaid",
    );
    expect(run("sent", "PAYMENT_SUCCEEDED", ctx({ paidMinor: 10_000 })).state.status).toBe("paid");
  });
});

describe("prior status and restoration (D2)", () => {
  it("records the status a promise or dispute came from", () => {
    expect(run("viewed", "PROMISE_CREATED").state.priorStatus).toBe("viewed");
    expect(run("overdue", "PROMISE_CREATED", ctx(pastDue)).effects).toContainEqual({
      type: "store_prior_status",
      status: "overdue",
    });
    expect(run("promised", "DISPUTE_OPENED").state.priorStatus).toBe("promised");
  });

  it("restoring re-evaluates against today", () => {
    expect(run("disputed", "DISPUTE_RESOLVED", ctx()).state.status).toBe("sent");
    expect(
      run("disputed", "DISPUTE_RESOLVED", ctx({ firstViewedAt: new Date() })).state.status,
    ).toBe("viewed");
    expect(run("disputed", "DISPUTE_RESOLVED", ctx(pastDue)).state.status).toBe("overdue");
    expect(run("promised", "PROMISE_CANCELLED", ctx(pastDue)).state.status).toBe("overdue");
  });

  it("a view on an open non-sent invoice only records the timestamp", () => {
    const r = run("overdue", "VIEW", ctx(pastDue));
    expect(r.state.status).toBe("overdue");
    expect(effectTypes(r)).toEqual(["set_first_viewed_at"]);
    expect(
      effectTypes(run("overdue", "VIEW", ctx({ ...pastDue, firstViewedAt: new Date() }))),
    ).toEqual([]);
  });
});

describe("reevaluate and effectiveStatus (D1)", () => {
  it("due today is not overdue; yesterday is", () => {
    expect(reevaluate({ today: "2026-03-10", dueDate: "2026-03-10", firstViewedAt: null })).toBe(
      "sent",
    );
    expect(reevaluate({ today: "2026-03-10", dueDate: "2026-03-09", firstViewedAt: null })).toBe(
      "overdue",
    );
    expect(reevaluate({ today: "2026-03-10", dueDate: null, firstViewedAt: new Date() })).toBe(
      "viewed",
    );
  });

  it("only sent and viewed lapse on read; held and closed statuses do not", () => {
    const c = { today: "2026-03-10", dueDate: "2026-03-01" };
    expect(effectiveStatus("sent", c)).toBe("overdue");
    expect(effectiveStatus("viewed", c)).toBe("overdue");
    for (const s of ["draft", "promised", "disputed", "paid", "void", "overdue"] as const) {
      expect(effectiveStatus(s, c)).toBe(s);
    }
    expect(effectiveStatus("sent", { today: "2026-03-10", dueDate: "2026-03-10" })).toBe("sent");
  });
});
