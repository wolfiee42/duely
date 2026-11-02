import { processStripeEvent } from "@repo/api/usecases";
import { createFileRoute } from "@tanstack/react-router";

import { fake, services, withSystemDb } from "#/lib/server/runtime.ts";

// Fake services mode only: stands in for Stripe confirming a payment, by feeding the real webhook
// processor the event Stripe would send. 404 in live mode.
export const Route = createFileRoute("/api/dev/simulate-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!fake) return new Response("Not Found", { status: 404 });
        const body = (await request.json()) as {
          intentId: string;
          accountId: string;
          invoiceId: string;
          tenantId: string;
          amountMinor: number;
        };
        const outcome = await withSystemDb((db) =>
          processStripeEvent(db, {
            id: `evt_dev_${body.intentId}`,
            type: "payment_intent.succeeded",
            account: body.accountId,
            data: {
              object: {
                id: body.intentId,
                amount: body.amountMinor,
                amount_received: body.amountMinor,
                payment_method_types: ["card"],
                metadata: { invoice_id: body.invoiceId, tenant_id: body.tenantId },
              },
            },
          }),
        );
        for (const messageId of outcome.messageIds) {
          await services.queue.send({ type: "send_message", messageId });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
