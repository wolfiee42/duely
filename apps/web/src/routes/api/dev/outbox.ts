import { createFileRoute } from "@tanstack/react-router";

import { fake } from "#/lib/server/runtime.ts";

// Fake services mode only (local dev and E2E): lets a test read the emails that "were sent".
// 404 in live mode, so it does not exist in production.
export const Route = createFileRoute("/api/dev/outbox")({
  server: {
    handlers: {
      GET: () =>
        fake
          ? Response.json(
              fake.outbox().map((m) => ({ to: m.to, subject: m.subject, text: m.text })),
            )
          : new Response("Not Found", { status: 404 }),
    },
  },
});
