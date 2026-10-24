import type { EmailClient, OutboundEmail } from "./types";

export interface FakeEmail extends EmailClient {
  sent: OutboundEmail[];
  /** Test control: make the next `n` sends fail. */
  failNext(n: number, retryable?: boolean): void;
}

/** Records messages. Repeating an idempotency key returns the original id without a second delivery. */
export function createFakeEmail(): FakeEmail {
  const sent: OutboundEmail[] = [];
  const byKey = new Map<string, string>();
  let failures = 0;
  let retryable = true;
  return {
    sent,
    failNext(n, r = true) {
      failures = n;
      retryable = r;
    },
    async send(email) {
      if (failures > 0) {
        failures--;
        const { EmailSendError } = await import("./client");
        throw new EmailSendError(retryable ? 503 : 422, "fake failure", retryable);
      }
      const prior = byKey.get(email.idempotencyKey);
      if (prior) return { providerMessageId: prior };
      const id = `msg_fake_${sent.length + 1}`;
      byKey.set(email.idempotencyKey, id);
      sent.push(email);
      return { providerMessageId: id };
    },
  };
}
