import type { StripeEvent } from "./types";

// SPEC 7: verify the signature over the raw body before parsing anything.
// Header format: `t=<unix>,v1=<hex hmac-sha256 of "t.body">[,v1=...]`.

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signPayload(rawBody: string, secret: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );
}

export async function verifyWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  { nowSeconds, toleranceSeconds = 300 }: { nowSeconds: number; toleranceSeconds?: number },
): Promise<StripeEvent> {
  if (!signatureHeader) throw new WebhookSignatureError("missing signature");
  const parts = signatureHeader.split(",").map((p) => p.trim().split("="));
  const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(timestamp) || signatures.length === 0)
    throw new WebhookSignatureError("malformed signature");
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds)
    throw new WebhookSignatureError("timestamp outside tolerance");

  const expected = await signPayload(rawBody, secret, timestamp);
  if (!signatures.some((s) => timingSafeEqual(s, expected)))
    throw new WebhookSignatureError("signature mismatch");

  const event = JSON.parse(rawBody) as StripeEvent;
  if (typeof event.id !== "string" || typeof event.type !== "string")
    throw new WebhookSignatureError("not an event");
  return event;
}
