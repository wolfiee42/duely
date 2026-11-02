import { createFileRoute } from "@tanstack/react-router";

import { fake } from "#/lib/server/runtime.ts";

// Fake services mode only: stands in for DNS propagating and the certificate being issued.
export const Route = createFileRoute("/api/dev/activate-domain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!fake) return new Response("Not Found", { status: 404 });
        const { hostname } = (await request.json()) as { hostname?: string };
        if (!hostname) return new Response("Bad Request", { status: 400 });
        fake.activateDomain(hostname);
        return Response.json({ ok: true });
      },
    },
  },
});
