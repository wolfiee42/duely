import { realNow } from "@repo/clock";
import { verifyWebhook, WebhookSignatureError } from "@repo/stripe";
import { Hono } from "hono";

import type { WithDb } from "../db";
import type { AppConfig, QueuePort } from "../services";
import { EventNotReady, processStripeEvent } from "../usecases/stripe-webhook";
import { requireHostKind, type AppEnv } from "./middleware";

export const MAX_WEBHOOK_BYTES = 512 * 1024;

export function webhookRoutes(deps: { withSystemDb: WithDb; queue: QueuePort; config: AppConfig }) {
  const app = new Hono<AppEnv>();

  // Webhooks are accepted on the app host only (D20). The signature is checked over the raw body
  // before anything is parsed or stored (SPEC 7).
  app.post("/webhooks/stripe", requireHostKind("app"), async (c) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES)
      return c.json({ error: "too_large" }, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) return c.json({ error: "too_large" }, 413);

    let event;
    try {
      event = await verifyWebhook(
        raw,
        c.req.header("stripe-signature") ?? null,
        deps.config.stripeWebhookSecret,
        {
          nowSeconds: Math.floor(realNow().getTime() / 1000),
        },
      );
    } catch (error) {
      if (error instanceof WebhookSignatureError)
        return c.json({ error: "invalid_signature" }, 400);
      throw error;
    }

    try {
      const outcome = await deps.withSystemDb((db) => processStripeEvent(db, event));
      for (const messageId of outcome.messageIds)
        await deps.queue.send({ type: "send_message", messageId });
      return c.json({ received: true, status: outcome.status });
    } catch (error) {
      // 5xx makes Stripe retry later with the same event id; an event that is waiting on another is expected.
      if (error instanceof EventNotReady) return c.json({ error: "not_ready" }, 503);
      throw error;
    }
  });

  return app;
}
