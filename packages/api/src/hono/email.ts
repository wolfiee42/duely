import { realNow } from "@repo/clock";
import { EmailWebhookError, escapeHtml, verifyResendWebhook } from "@repo/email";
import { Hono, type Context } from "hono";

import type { WithDb } from "../db";
import type { AppConfig, QueuePort } from "../services";
import {
  MessageNotReady,
  processEmailEvent,
  unsubscribeFromReminders,
  unsubscribeTarget,
} from "../usecases/email-events";
import { receiveInboundEmail } from "../usecases/inbound";
import { requireHostKind, type AppEnv } from "./middleware";
import { MAX_WEBHOOK_BYTES } from "./webhooks";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;color:#111"><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</body></html>`;

export function emailRoutes(deps: { withSystemDb: WithDb; queue: QueuePort; config: AppConfig }) {
  const app = new Hono<AppEnv>();

  // Both webhooks are accepted on the app host only, signed by the provider, and checked over the raw body
  // before anything is parsed or stored (SPEC 7).
  async function verified(c: Context<AppEnv>) {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES)
      return { response: c.json({ error: "too_large" }, 413) };
    const raw = await c.req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) return { response: c.json({ error: "too_large" }, 413) };
    try {
      const event = await verifyResendWebhook(
        raw,
        {
          id: c.req.header("svix-id") ?? null,
          timestamp: c.req.header("svix-timestamp") ?? null,
          signature: c.req.header("svix-signature") ?? null,
        },
        deps.config.resendWebhookSecret,
        { nowSeconds: Math.floor(realNow().getTime() / 1000) },
      );
      return { event };
    } catch (error) {
      if (error instanceof EmailWebhookError)
        return { response: c.json({ error: "invalid_signature" }, 400) };
      throw error;
    }
  }

  // Delivery events (FR-8.4).
  app.post("/webhooks/resend", requireHostKind("app"), async (c) => {
    const { event, response } = await verified(c);
    if (!event) return response;
    try {
      const status = await deps.withSystemDb((db) => processEmailEvent(db, event));
      return c.json({ received: true, status });
    } catch (error) {
      // The event can beat our own record of the send; a 503 makes the provider retry.
      if (error instanceof MessageNotReady) return c.json({ error: "not_ready" }, 503);
      throw error;
    }
  });

  // A client's reply (FR-8.5). Matching, storing and queueing happen in `receiveInboundEmail`.
  app.post("/inbound/email", requireHostKind("app"), async (c) => {
    const { event, response } = await verified(c);
    if (!event) return response;
    if (event.type !== "email.received") return c.json({ received: true, status: "ignored" });
    const d = event.data as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const to = (Array.isArray(d.to) ? d.to : [d.to]).map(text);
    if (typeof d.email_id !== "string" || typeof d.from !== "string") {
      return c.json({ error: "malformed" }, 400);
    }
    const result = await deps.withSystemDb((db) =>
      receiveInboundEmail(db, {
        providerId: d.email_id as string,
        from: d.from as string,
        to,
        subject: text(d.subject),
        text: text(d.text),
      }),
    );
    if ("messageId" in result) {
      await deps.queue.send({ type: "classify_reply", messageId: result.messageId });
    }
    return c.json({ received: true, status: result.outcome });
  });

  // A GET only shows the page: mail scanners follow links, so the change needs a deliberate POST.
  app.get("/unsubscribe/:token", async (c) => {
    const target = await deps.withSystemDb((db) => unsubscribeTarget(db, c.req.param("token")));
    if (!target) return c.html(page("Link not valid", "<p>This link is no longer valid.</p>"), 404);
    return c.html(
      page(
        "Stop reminders?",
        `<p>You won't get payment reminders about invoices from ${escapeHtml(target.clientName ?? "this account")} any more.</p>
<form method="post"><button type="submit" style="padding:10px 18px;font-size:16px">Stop reminders</button></form>`,
      ),
    );
  });

  app.post("/unsubscribe/:token", async (c) => {
    const done = await deps.withSystemDb((db) =>
      unsubscribeFromReminders(db, c.req.param("token")),
    );
    if (!done) return c.html(page("Link not valid", "<p>This link is no longer valid.</p>"), 404);
    return c.html(
      page(
        "Reminders stopped",
        "<p>You won't get any more reminders. You can still view and pay invoices you've been sent.</p>",
      ),
    );
  });

  return app;
}
