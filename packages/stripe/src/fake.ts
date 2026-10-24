import type {
  ConnectedAccountStatus,
  CreatePaymentIntentInput,
  PaymentIntentResult,
  StripeClient,
} from "./types";

export interface FakeStripe extends StripeClient {
  accounts: Map<string, ConnectedAccountStatus>;
  intents: Array<CreatePaymentIntentInput & PaymentIntentResult>;
  /** Test control: pretend the firm finished onboarding. */
  completeOnboarding(accountId: string): void;
}

/** In-memory Stripe for default test runs (no remote calls). Idempotency keys behave like the real API. */
export function createFakeStripe(): FakeStripe {
  const accounts = new Map<string, ConnectedAccountStatus>();
  const intents: FakeStripe["intents"] = [];
  const byKey = new Map<string, PaymentIntentResult>();
  let n = 0;
  return {
    accounts,
    intents,
    completeOnboarding(id) {
      accounts.set(id, { id, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    },
    async createExpressAccount() {
      const id = `acct_fake_${++n}`;
      accounts.set(id, {
        id,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      });
      return { id };
    },
    async createAccountLink({ accountId }) {
      return { url: `https://connect.stripe.test/onboard/${accountId}` };
    },
    async retrieveAccount(accountId) {
      const a = accounts.get(accountId);
      if (!a) throw new Error(`no such account ${accountId}`);
      return a;
    },
    async createPaymentIntent(input) {
      const prior = byKey.get(`${input.accountId}:${input.idempotencyKey}`);
      if (prior) return prior;
      const result = { id: `pi_fake_${++n}`, clientSecret: `pi_fake_${n}_secret` };
      byKey.set(`${input.accountId}:${input.idempotencyKey}`, result);
      intents.push({ ...input, ...result });
      return result;
    },
  };
}
