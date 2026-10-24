export interface OutboundEmail {
  /** One recipient per message, so each has its own delivery state. */
  to: string;
  /** Display name and address, e.g. `Acme via Duely <billing@duely.app>`. */
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Sending the same key twice must not deliver twice (outbox safety, D22). */
  idempotencyKey: string;
}

export interface EmailClient {
  send(email: OutboundEmail): Promise<{ providerMessageId: string }>;
}
