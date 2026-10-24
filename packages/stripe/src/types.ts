export interface ConnectedAccountStatus {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface CreatePaymentIntentInput {
  /** The firm's connected account; the charge is created on it (SPEC 5.1). */
  accountId: string;
  amountMinor: number;
  applicationFeeMinor: number;
  /** `card` and/or `us_bank_account`. */
  methods: Array<"card" | "us_bank_account">;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface PaymentIntentResult {
  id: string;
  clientSecret: string;
}

/** The slice of Stripe Duely uses. Real client in `client.ts`, in-memory fake in `fake.ts`. */
export interface StripeClient {
  createExpressAccount(input: { email: string; firmId: string }): Promise<{ id: string }>;
  createAccountLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }>;
  retrieveAccount(accountId: string): Promise<ConnectedAccountStatus>;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;
}

/** The webhook event fields Duely reads. */
export interface StripeEvent {
  id: string;
  type: string;
  /** Set on Connect events: the connected account the event happened on. */
  account?: string;
  data: { object: Record<string, any> };
}
