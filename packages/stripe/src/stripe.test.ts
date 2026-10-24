import { describe, expect, it } from "vite-plus/test";

import { createStripeClient, encodeForm, StripeApiError } from "./client";
import { createFakeStripe } from "./fake";
import { signPayload, verifyWebhook, WebhookSignatureError } from "./webhook";

describe("encodeForm", () => {
  it("brackets nested objects and arrays like Stripe expects", () => {
    expect(
      encodeForm({
        amount: 100,
        metadata: { firm_id: "f 1" },
        payment_method_types: ["card", "us_bank_account"],
        skip: undefined,
      }),
    ).toEqual([
      "amount=100",
      "metadata%5Bfirm_id%5D=f%201",
      "payment_method_types%5B0%5D=card",
      "payment_method_types%5B1%5D=us_bank_account",
    ]);
  });
});

describe("createStripeClient", () => {
  const recorder = (response: unknown, status = 200) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it("creates the payment intent on the connected account with the fee and an idempotency key", async () => {
    const { calls, fetchImpl } = recorder({ id: "pi_1", client_secret: "pi_1_secret" });
    const stripe = createStripeClient("sk_test_x", fetchImpl);
    const out = await stripe.createPaymentIntent({
      accountId: "acct_9",
      amountMinor: 10_000,
      applicationFeeMinor: 100,
      methods: ["card"],
      metadata: { invoice_id: "inv_1" },
      idempotencyKey: "key-1",
    });
    expect(out).toEqual({ id: "pi_1", clientSecret: "pi_1_secret" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["stripe-account"]).toBe("acct_9");
    expect(headers["idempotency-key"]).toBe("key-1");
    expect(headers.authorization).toBe("Bearer sk_test_x");
    const body = calls[0]!.init.body as string;
    expect(body).toContain("amount=10000");
    expect(body).toContain("application_fee_amount=100");
    expect(body).toContain("currency=usd");
  });

  it("maps account flags and surfaces API errors", async () => {
    const ok = recorder({
      id: "acct_1",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    });
    expect(await createStripeClient("k", ok.fetchImpl).retrieveAccount("acct_1")).toEqual({
      id: "acct_1",
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
    const bad = recorder({ error: { type: "invalid_request_error", message: "nope" } }, 400);
    await expect(
      createStripeClient("k", bad.fetchImpl).retrieveAccount("x"),
    ).rejects.toBeInstanceOf(StripeApiError);
  });
});

describe("verifyWebhook", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: { object: {} },
  });
  const now = 1_800_000_000;

  it("accepts a correctly signed payload and returns the event", async () => {
    const sig = `t=${now},v1=${await signPayload(body, secret, now)}`;
    expect((await verifyWebhook(body, sig, secret, { nowSeconds: now })).id).toBe("evt_1");
  });

  it("accepts when any one of several v1 signatures matches (secret rotation)", async () => {
    const sig = `t=${now},v1=deadbeef,v1=${await signPayload(body, secret, now)}`;
    expect((await verifyWebhook(body, sig, secret, { nowSeconds: now })).type).toBe(
      "payment_intent.succeeded",
    );
  });

  it.each([
    ["missing header", null],
    ["garbage", "nonsense"],
    ["wrong secret", `t=${now},v1=${"0".repeat(64)}`],
    ["no v1", `t=${now}`],
  ])("rejects %s", async (_name, header) => {
    await expect(verifyWebhook(body, header, secret, { nowSeconds: now })).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it("rejects a tampered body and a stale timestamp (replay)", async () => {
    const sig = `t=${now},v1=${await signPayload(body, secret, now)}`;
    await expect(
      verifyWebhook(body.replace("evt_1", "evt_2"), sig, secret, { nowSeconds: now }),
    ).rejects.toThrow(/mismatch/);
    await expect(verifyWebhook(body, sig, secret, { nowSeconds: now + 301 })).rejects.toThrow(
      /tolerance/,
    );
    await expect(verifyWebhook(body, sig, secret, { nowSeconds: now - 301 })).rejects.toThrow(
      /tolerance/,
    );
  });
});

describe("fake stripe", () => {
  it("honours idempotency keys per account", async () => {
    const s = createFakeStripe();
    const input = {
      accountId: "a",
      amountMinor: 1,
      applicationFeeMinor: 0,
      methods: ["card" as const],
      metadata: {},
      idempotencyKey: "k",
    };
    const first = await s.createPaymentIntent(input);
    expect(await s.createPaymentIntent(input)).toEqual(first);
    expect(s.intents).toHaveLength(1);
    expect((await s.createPaymentIntent({ ...input, accountId: "b" })).id).not.toBe(first.id);
  });
});
