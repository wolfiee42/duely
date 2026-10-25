import { receiveInboundEmail } from "@repo/api/usecases";
import { createFileRoute } from "@tanstack/react-router";

import { fake, services, withSystemDb } from "#/lib/server/runtime.ts";

// Fake services mode only: stands in for the email provider delivering a client's reply, by feeding the real
// inbound pipeline. The reply is then classified inline, as the jobs worker would. 404 in live mode.
export const Route = createFileRoute("/api/dev/inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!fake) return new Response("Not Found", { status: 404 });
        const body = (await request.json()) as {
          from: string;
          subject: string;
          text: string;
          to?: string[];
        };
        const result = await withSystemDb((db) =>
          receiveInboundEmail(db, {
            providerId: `dev_in_${crypto.randomUUID()}`,
            from: body.from,
            to: body.to ?? ["billing@duely.app"],
            subject: body.subject,
            text: body.text,
          }),
        );
        if ("messageId" in result) {
          await services.queue.send({ type: "classify_reply", messageId: result.messageId });
        }
        return Response.json(result);
      },
    },
  },
});
