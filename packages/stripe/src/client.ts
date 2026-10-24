import type {
  ConnectedAccountStatus,
  CreatePaymentIntentInput,
  PaymentIntentResult,
  StripeClient,
} from "./types";

const API = "https://api.stripe.com";

type Fetch = typeof fetch;

/** Stripe wants form-encoded bodies with bracketed keys: `metadata[firm_id]=...`. */
export function encodeForm(params: Record<string, unknown>, prefix = ""): string[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => pairs.push(...encodeForm({ [i]: v }, name)));
    } else if (typeof value === "object") {
      pairs.push(...encodeForm(value as Record<string, unknown>, name));
    } else {
      pairs.push(
        `${encodeURIComponent(name)}=${encodeURIComponent(String(value as string | number | boolean))}`,
      );
    }
  }
  return pairs;
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

export function createStripeClient(secretKey: string, fetchImpl: Fetch = fetch): StripeClient {
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<T> {
    const body = encodeForm(params).join("&");
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...headers,
      },
      body: method === "POST" ? body : undefined,
    });
    const json = (await res.json()) as T & { error?: { type?: string; message?: string } };
    if (!res.ok)
      throw new StripeApiError(
        res.status,
        json.error?.type,
        json.error?.message ?? "Stripe request failed",
      );
    return json;
  }

  const toStatus = (a: any): ConnectedAccountStatus => ({
    id: a.id,
    chargesEnabled: Boolean(a.charges_enabled),
    payoutsEnabled: Boolean(a.payouts_enabled),
    detailsSubmitted: Boolean(a.details_submitted),
  });

  return {
    async createExpressAccount({ email, firmId }) {
      const a = await call<{ id: string }>("POST", "/v1/accounts", {
        type: "express",
        country: "US",
        email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { firm_id: firmId },
      });
      return { id: a.id };
    },

    async createAccountLink({ accountId, returnUrl, refreshUrl }) {
      const l = await call<{ url: string }>("POST", "/v1/account_links", {
        account: accountId,
        type: "account_onboarding",
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return { url: l.url };
    },

    async retrieveAccount(accountId) {
      return toStatus(await call("GET", `/v1/accounts/${encodeURIComponent(accountId)}`));
    },

    async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult> {
      const pi = await call<{ id: string; client_secret: string }>(
        "POST",
        "/v1/payment_intents",
        {
          amount: input.amountMinor,
          currency: "usd",
          application_fee_amount: input.applicationFeeMinor,
          payment_method_types: input.methods,
          metadata: input.metadata,
        },
        { "stripe-account": input.accountId, "idempotency-key": input.idempotencyKey },
      );
      return { id: pi.id, clientSecret: pi.client_secret };
    },
  };
}
