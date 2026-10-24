import type { EmailClient, OutboundEmail } from "./types";

export class EmailSendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 4xx other than 429 will not succeed on retry. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

/** Resend over `fetch`. The idempotency key lets a retry after a crash be a no-op at the provider. */
export function createResendClient(apiKey: string, fetchImpl: typeof fetch = fetch): EmailClient {
  return {
    async send(email: OutboundEmail) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          reply_to: email.replyTo,
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !json.id) {
        throw new EmailSendError(
          res.status,
          json.message ?? "email send failed",
          res.status >= 500 || res.status === 429,
        );
      }
      return { providerMessageId: json.id };
    },
  };
}
