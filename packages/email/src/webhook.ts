// Resend signs webhooks with Svix: HMAC-SHA256 over `{id}.{timestamp}.{body}`, keyed with the
// base64 part of the `whsec_...` secret, sent as `v1,<base64>` (space-separated when rotating).

export class EmailWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailWebhookError";
  }
}

export interface ResendEvent {
  type: string;
  data: {
    email_id?: string;
    bounce?: { type?: string };
    [key: string]: unknown;
  };
}

const base64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

function secretBytes(secret: string) {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}

export async function signSvix(id: string, timestamp: number, body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${base64(mac)}`;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks the signature over the raw body, then parses it. Throws `EmailWebhookError` on any problem. */
export async function verifyResendWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  { nowSeconds, toleranceSeconds = 300 }: { nowSeconds: number; toleranceSeconds?: number },
): Promise<ResendEvent> {
  const { id, timestamp, signature } = headers;
  if (!secret) throw new EmailWebhookError("webhook secret not configured");
  if (!id || !timestamp || !signature) throw new EmailWebhookError("missing signature headers");
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw new EmailWebhookError("malformed timestamp");
  if (Math.abs(nowSeconds - ts) > toleranceSeconds)
    throw new EmailWebhookError("timestamp outside tolerance");

  let expected: string;
  try {
    expected = await signSvix(id, ts, rawBody, secret);
  } catch {
    throw new EmailWebhookError("bad secret");
  }
  if (!signature.split(" ").some((s) => timingSafeEqual(s, expected)))
    throw new EmailWebhookError("signature mismatch");

  const event = JSON.parse(rawBody) as ResendEvent;
  if (typeof event.type !== "string" || typeof event.data !== "object" || event.data === null)
    throw new EmailWebhookError("not an event");
  return event;
}
