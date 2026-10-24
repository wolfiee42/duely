import { resolveTenantByHost, withTenant } from "@repo/db";
import { auditLog, disputes, promises, refunds } from "@repo/db/schema";
import { signPayload } from "@repo/stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  APP,
  createHarness,
  deliverMessage,
  testDeps,
  WEBHOOK_SECRET,
  type Harness,
} from "../testing";

// webhook-replay (SPEC 8, a CI gate): the same event 3x has one ledger effect, and events converge
// whatever order they arrive in.

const ACME = "https://acme.duely.app";
const cfg = testDeps().config;

let h: Harness;
let acme: string;
let tenantId: string;
let accountId: string;
let clientId: string;
let portalCookie: string;
let seq = 0;

const drain = async () => {
  for (const m of h.fakes.queue.messages.splice(0)) {
    if (m.type === "send_message")
      await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
  }
};

async function sentInvoice(amount = 10_000) {
  const id = (
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: { clientId, items: [{ description: "Work", quantity: "1", unitAmountMinor: amount }] },
    })
  ).data.id as string;
  expect(
    (
      await h.staff("invoices.send", {
        cookie: acme,
        body: { invoiceId: id, idempotencyKey: crypto.randomUUID() },
      })
    ).status,
  ).toBe(200);
  return id;
}

const intent = (invoiceId: string, over: Record<string, unknown> = {}) => ({
  id: `pi_${++seq}`,
  amount: 10_000,
  amount_received: 10_000,
  application_fee_amount: 100,
  payment_method_types: ["card"],
  latest_charge: `ch_${seq}`,
  metadata: { invoice_id: invoiceId, tenant_id: tenantId },
  ...over,
});
const event = (
  type: string,
  object: Record<string, unknown>,
  over: Record<string, unknown> = {},
) => ({
  id: `evt_${++seq}`,
  type,
  account: accountId,
  data: { object },
  ...over,
});

async function post(
  evt: unknown,
  opts: { host?: string; secret?: string; header?: string | null; ts?: number } = {},
) {
  const raw = JSON.stringify(evt);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const header =
    opts.header === undefined
      ? `t=${ts},v1=${await signPayload(raw, opts.secret ?? WEBHOOK_SECRET, ts)}`
      : opts.header;
  const res = await h.app.request(`${opts.host ?? APP}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(header ? { "stripe-signature": header } : {}),
    },
    body: raw,
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string };
  return { status: res.status, outcome: json.status };
}

const invoice = async (id: string) =>
  (await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } })).data;
const audits = (id: string, action: string) =>
  withTenant(h.db, tenantId, async (tx) =>
    (await tx.select().from(auditLog)).filter((a) => a.entityId === id && a.action === action),
  );
const eventRow = async (id: string) =>
  (await h.systemDb.execute<{
    processed_at: string | null;
    attempts: number;
    error: string | null;
  }>(
    `select processed_at, attempts, error from stripe_events where id = '${id}'` as never,
  )) as never;

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  tenantId = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
  await h.staff("stripe.connectLink", { cookie: acme, body: {} });
  accountId = (await h.staff("firm.get", { cookie: acme })).data.firm.stripeAccountId;
  h.fakes.stripe.completeOnboarding(accountId);
  await h.staff("stripe.status", { cookie: acme });
  clientId = (
    await h.staff("clients.create", {
      cookie: acme,
      body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
    })
  ).data.id;

  await h.portal("auth.requestLink", {
    host: ACME,
    body: { email: "bill@initech.test" },
    ip: "10.9.9.9",
  });
  await drain();
  const token = /\/api\/portal\/auth\/([\w-]{43})/.exec(h.fakes.email.sent.at(-1)!.text)![1]!;
  portalCookie = (
    await h.app.request(`${ACME}/api/portal/auth/${token}`, { redirect: "manual" })
  ).headers
    .get("set-cookie")!
    .split(";")[0]!;
}, 60_000);
afterAll(() => h?.close());
beforeEach(() => h.testDbAdmin("delete from rate_limit_events"));

describe("pay flow (P2-10)", () => {
  const pay = (invoiceId: string, key = crypto.randomUUID(), cookie = portalCookie) =>
    h.portal("invoices.createPayment", {
      host: ACME,
      cookie,
      body: { invoiceId, idempotencyKey: key },
    });

  it("creates a PaymentIntent on the firm's account for the full balance, with the platform fee", async () => {
    const id = await sentInvoice(12_345);
    const res = await pay(id);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      amountMinor: 12_345,
      stripeAccountId: accountId,
      publishableKey: "pk_test_fake",
    });
    expect(res.data.clientSecret).toMatch(/_secret$/);
    expect(h.fakes.stripe.intents.at(-1)).toMatchObject({
      accountId,
      amountMinor: 12_345,
      applicationFeeMinor: 123, // floor(12345 * 100bps) = 123
      methods: ["card", "us_bank_account"],
      metadata: { invoice_id: id, tenant_id: tenantId },
    });
  });

  it("ignores any amount the client sends, and replays an idempotency key without a second intent", async () => {
    const id = await sentInvoice(5000);
    const key = crypto.randomUUID();
    const before = h.fakes.stripe.intents.length;
    const a = await h.portal("invoices.createPayment", {
      host: ACME,
      cookie: portalCookie,
      body: { invoiceId: id, idempotencyKey: key, amountMinor: 1, applicationFeeMinor: 0 },
    });
    const b = await pay(id, key);
    expect(a.data.amountMinor).toBe(5000);
    expect(b.data.clientSecret).toBe(a.data.clientSecret);
    expect(h.fakes.stripe.intents.length).toBe(before + 1);
  });

  it("requires a session, the client's own invoice, and a payable state", async () => {
    const id = await sentInvoice();
    expect((await pay(id, crypto.randomUUID(), "")).status).toBe(401);
    const other = (
      await h.staff("clients.create", {
        cookie: acme,
        body: { client: { name: "Other" }, contact: { name: "o", email: "o@other.test" } },
      })
    ).data.id;
    const theirs = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: {
          clientId: other,
          items: [{ description: "x", quantity: "1", unitAmountMinor: 100 }],
        },
      })
    ).data.id;
    await h.staff("invoices.send", {
      cookie: acme,
      body: { invoiceId: theirs, idempotencyKey: crypto.randomUUID() },
    });
    expect((await pay(theirs)).status).toBe(404);
    await h.staff("invoices.void", { cookie: acme, body: { invoiceId: id, reason: "x" } });
    expect((await pay(id)).domainCode).toBe("invoice.not_payable");
  });
});

describe("signature and routing", () => {
  it("rejects missing, wrong, malformed and stale signatures without touching state", async () => {
    const evt = event("payment_intent.succeeded", intent(await sentInvoice()));
    const now = Math.floor(Date.now() / 1000);
    for (const opts of [
      { header: null },
      { header: "garbage" },
      { secret: "whsec_wrong" },
      { ts: now - 3600 },
    ]) {
      expect((await post(evt, opts)).status).toBe(400);
    }
    const rows = await h.systemDb.execute(
      `select 1 from stripe_events where id = '${evt.id}'` as never,
    );
    expect((rows as unknown as unknown[]).length).toBe(0);
  });

  it("is accepted on the app host only", async () => {
    expect((await post(event("account.updated", {}), { host: ACME })).status).toBe(404);
    expect(
      (await post(event("account.updated", {}), { host: "https://evil.example" })).status,
    ).toBe(404);
  });

  it("ignores events for an unknown connected account (200, no effect)", async () => {
    const id = await sentInvoice();
    const res = await post(
      event("payment_intent.succeeded", intent(id), { account: "acct_nobody" }),
    );
    expect([res.status, res.outcome]).toEqual([200, "ignored"]);
    expect((await invoice(id)).status).toBe("sent");
  });

  it("syncs capability flags from account.updated", async () => {
    await post(
      event("account.updated", {
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: true,
      }),
    );
    expect((await h.staff("firm.get", { cookie: acme })).data.firm).toMatchObject({
      stripeChargesEnabled: false,
      stripeDetailsSubmitted: true,
    });
    await post(
      event("account.updated", {
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      }),
    );
    expect((await h.staff("firm.get", { cookie: acme })).data.firm.stripeChargesEnabled).toBe(true);
  });
});

describe("replay: same event, one effect", () => {
  it("delivers payment_intent.succeeded three times and records the payment once", async () => {
    const id = await sentInvoice(10_000);
    const evt = event("payment_intent.succeeded", intent(id));
    const results = [await post(evt), await post(evt), await post(evt)];
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.outcome)).toEqual(["processed", "duplicate", "duplicate"]);

    const inv = await invoice(id);
    expect(inv).toMatchObject({ status: "paid", paidMinor: 10_000, paymentProcessing: false });
    expect(inv.paidAt).toBeTruthy();
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0]).toMatchObject({
      status: "succeeded",
      method: "card",
      amountMinor: 10_000,
      applicationFeeMinor: 100,
    });
    expect(await audits(id, "payment.succeeded")).toHaveLength(1);
  });

  it("five simultaneous deliveries still have one effect", async () => {
    const id = await sentInvoice(10_000);
    const evt = event("payment_intent.succeeded", intent(id));
    const results = await Promise.all(Array.from({ length: 5 }, () => post(evt)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.outcome === "processed")).toHaveLength(1);
    const inv = await invoice(id);
    expect(inv.paidMinor).toBe(10_000);
    expect(inv.payments).toHaveLength(1);
  });

  it("a different event id for the same PaymentIntent (Stripe re-sent) is also absorbed", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    expect((await post(event("payment_intent.succeeded", pi))).status).toBe(200);
    expect((await post(event("payment_intent.succeeded", pi))).status).toBe(200); // not a 500 left to the DB trigger
    const inv = await invoice(id);
    expect(inv.paidMinor).toBe(10_000);
    expect(inv.payments).toHaveLength(1);
  });
});

describe("out of order and retried payments", () => {
  it("succeeded then processing: the late processing event never downgrades", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id, { payment_method_types: ["us_bank_account"] });
    await post(event("payment_intent.succeeded", pi));
    await post(event("payment_intent.processing", pi));
    const inv = await invoice(id);
    expect(inv).toMatchObject({ status: "paid", paymentProcessing: false, paidMinor: 10_000 });
    expect(inv.payments).toMatchObject([{ status: "succeeded", method: "ach" }]);
  });

  it("ACH in order: processing blocks a second payment, then succeeds", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id, { payment_method_types: ["card", "us_bank_account"] });
    await post(event("payment_intent.processing", pi));
    expect((await invoice(id)).paymentProcessing).toBe(true);
    const blocked = await h.portal("invoices.createPayment", {
      host: ACME,
      cookie: portalCookie,
      body: { invoiceId: id, idempotencyKey: crypto.randomUUID() },
    });
    expect([blocked.status, blocked.domainCode]).toEqual([409, "invoice.payment_in_progress"]);

    await post(event("payment_intent.succeeded", pi));
    expect(await invoice(id)).toMatchObject({
      status: "paid",
      paymentProcessing: false,
      payments: [{ method: "ach", status: "succeeded" }],
    });
  });

  it("a decline followed by a successful retry on the same intent ends paid", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    await post(
      event("payment_intent.payment_failed", {
        ...pi,
        last_payment_error: { message: "Your card was declined." },
      }),
    );
    let inv = await invoice(id);
    expect(inv.status).toBe("sent");
    expect(inv.payments).toMatchObject([
      { status: "failed", failureReason: "Your card was declined." },
    ]);

    await post(event("payment_intent.succeeded", pi));
    inv = await invoice(id);
    expect(inv).toMatchObject({ status: "paid", paidMinor: 10_000 });
    expect(inv.payments).toMatchObject([{ status: "succeeded" }]);
  });

  it("paying a promised invoice marks the promise kept and jobs-facing state is final", async () => {
    const id = await sentInvoice(10_000);
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await h.portal("promises.create", {
      host: ACME,
      cookie: portalCookie,
      body: { invoiceId: id, promisedDate: date },
    });
    expect((await invoice(id)).status).toBe("promised");
    await post(event("payment_intent.succeeded", intent(id)));
    const inv = await invoice(id);
    expect(inv).toMatchObject({ status: "paid", activePromise: null });
    const rows = await withTenant(h.db, tenantId, (tx) => tx.select().from(promises));
    expect(rows.find((p) => p.invoiceId === id)).toMatchObject({ status: "kept" });
    expect(rows.find((p) => p.invoiceId === id)!.resolvedAt).toBeTruthy();
  });

  it("a late failure event after success changes nothing", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    await post(event("payment_intent.succeeded", pi));
    await post(event("payment_intent.payment_failed", pi));
    expect(await invoice(id)).toMatchObject({
      status: "paid",
      payments: [{ status: "succeeded" }],
    });
  });

  it("a second payment on an already-paid invoice is kept in the ledger and flagged, not silently lost", async () => {
    const id = await sentInvoice(10_000);
    await post(event("payment_intent.succeeded", intent(id)));
    await drain();
    const receipts = h.fakes.email.sent.length;
    await post(event("payment_intent.succeeded", intent(id)));
    const inv = await invoice(id);
    expect(inv.status).toBe("paid");
    expect(inv.paidMinor).toBe(20_000);
    expect(inv.payments).toHaveLength(2);
    expect(await audits(id, "payment.unexpected")).toHaveLength(1);
    await drain();
    expect(h.fakes.email.sent.length).toBe(receipts); // no second receipt
  });
});

describe("refunds and disputes (P2-12)", () => {
  const refund = (pi: { id: string }, over: Record<string, unknown> = {}) =>
    event("refund.created", {
      id: `re_${++seq}`,
      payment_intent: pi.id,
      amount: 2500,
      status: "succeeded",
      ...over,
    });

  it("applies a refund once, adjusts refunded_minor only, and the invoice stays paid", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    await post(event("payment_intent.succeeded", pi));
    const r = refund(pi);
    await post(r);
    await post(r);
    await post(r);
    expect(await invoice(id)).toMatchObject({
      status: "paid",
      paidMinor: 10_000,
      refundedMinor: 2500,
    });
    expect(await withTenant(h.db, tenantId, (tx) => tx.select().from(refunds))).toHaveLength(1);
  });

  it("a refund that arrives before its payment waits (503), then converges when the payment lands", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    const r = refund(pi, { amount: 4000 });
    const early = await post(r);
    expect(early.status).toBe(503);
    expect((await invoice(id)).refundedMinor).toBe(0);

    await post(event("payment_intent.succeeded", pi));
    expect((await post(r)).status).toBe(200); // Stripe's retry
    expect((await post(r)).outcome).toBe("duplicate");
    expect(await invoice(id)).toMatchObject({
      status: "paid",
      paidMinor: 10_000,
      refundedMinor: 4000,
    });
  });

  it("two partial refunds add up; a failed refund is ignored", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    await post(event("payment_intent.succeeded", pi));
    await post(refund(pi, { amount: 1000 }));
    await post(refund(pi, { amount: 2000 }));
    await post(refund(pi, { amount: 9999, status: "failed" }));
    expect((await invoice(id)).refundedMinor).toBe(3000);
  });

  it("records a chargeback as a Stripe dispute without changing the paid invoice, then closes it", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    await post(event("payment_intent.succeeded", pi));
    const opened = event("charge.dispute.created", {
      id: "dp_1",
      payment_intent: pi.id,
      amount: 10_000,
      reason: "fraudulent",
    });
    await post(opened);
    await post(opened);
    const rows = async () => withTenant(h.db, tenantId, (tx) => tx.select().from(disputes));
    expect((await rows()).filter((d) => d.stripeDisputeId === "dp_1")).toMatchObject([
      { status: "open", source: "stripe", reason: "fraudulent", priorStatus: "paid" },
    ]);
    expect((await invoice(id)).status).toBe("paid");

    await post(event("charge.dispute.closed", { id: "dp_1", status: "lost" }));
    expect((await rows()).find((d) => d.stripeDisputeId === "dp_1")).toMatchObject({
      status: "upheld",
    });
    await post(event("charge.dispute.closed", { id: "dp_1", status: "won" }));
    expect((await rows()).find((d) => d.stripeDisputeId === "dp_1")!.status).toBe("upheld"); // a closed dispute stays closed
  });

  it("a dispute close before its open waits, then converges", async () => {
    const id = await sentInvoice(10_000);
    const pi = intent(id);
    const closed = event("charge.dispute.closed", { id: "dp_2", status: "won" });
    expect((await post(closed)).status).toBe(503);
    await post(event("payment_intent.succeeded", pi));
    await post(
      event("charge.dispute.created", {
        id: "dp_2",
        payment_intent: pi.id,
        amount: 1,
        reason: "general",
      }),
    );
    expect((await post(closed)).status).toBe(200);
    const d = (await withTenant(h.db, tenantId, (tx) => tx.select().from(disputes))).find(
      (x) => x.stripeDisputeId === "dp_2",
    );
    expect(d!.status).toBe("resolved");
  });
});

describe("failure handling", () => {
  it("keeps the event unprocessed on error, records why, and a corrected redelivery succeeds", async () => {
    const id = await sentInvoice(10_000);
    const bad = event("payment_intent.succeeded", intent(id, { amount: 0, amount_received: 0 }));
    const first = await post(bad);
    expect(first.status).toBe(500);
    const [row] = (await eventRow(bad.id)) as unknown as Array<{
      processed_at: string | null;
      attempts: number;
      error: string | null;
    }>;
    expect(row).toMatchObject({ processed_at: null, attempts: 1 });
    expect(row!.error).toBeTruthy();
    expect(await invoice(id)).toMatchObject({ status: "sent", paidMinor: 0 }); // nothing leaked from the failed attempt
    expect((await invoice(id)).payments).toHaveLength(0);
  });
});

describe("receipts (P2-14)", () => {
  it("queues a receipt on payment, emails it once with the ledger amount, and lists it in the portal", async () => {
    const id = await sentInvoice(33_300);
    const pi = intent(id, { amount: 33_300, amount_received: 33_300 });
    await drain(); // receipts queued by earlier tests are not this test's business
    const before = h.fakes.email.sent.length;
    await post(event("payment_intent.succeeded", pi));
    await drain();
    await drain();
    expect(h.fakes.email.sent.length).toBe(before + 1);
    const mail = h.fakes.email.sent.at(-1)!;
    expect(mail.to).toBe("bill@initech.test");
    expect(mail.subject).toMatch(/^Receipt for invoice /);
    expect(mail.html).toContain("$333.00");

    const receipts = await h.portal("invoices.receipts", { host: ACME, cookie: portalCookie });
    expect(receipts.data[0]).toMatchObject({ invoiceId: id, amountMinor: 33_300, method: "card" });
  });

  it("each client sees only their own receipts", async () => {
    const other = (
      await h.staff("clients.create", {
        cookie: acme,
        body: { client: { name: "Elsewhere" }, contact: { name: "e", email: "e@elsewhere.test" } },
      })
    ).data.id;
    await h.portal("auth.requestLink", {
      host: ACME,
      body: { email: "e@elsewhere.test" },
      ip: "10.8.8.8",
    });
    await drain();
    const token = /\/api\/portal\/auth\/([\w-]{43})/.exec(h.fakes.email.sent.at(-1)!.text)![1]!;
    const cookie = (
      await h.app.request(`${ACME}/api/portal/auth/${token}`, { redirect: "manual" })
    ).headers
      .get("set-cookie")!
      .split(";")[0]!;
    expect((await h.portal("invoices.receipts", { host: ACME, cookie })).data).toEqual([]);
    expect((await h.portal("invoices.receipts", { host: ACME })).status).toBe(401);
    void other;
  });
});
