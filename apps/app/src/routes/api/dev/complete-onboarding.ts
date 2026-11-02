import { createFileRoute } from "@tanstack/react-router";

import { fake } from "#/lib/server/runtime.ts";

// Fake services mode only: stands in for the hosted Stripe onboarding form.
export const Route = createFileRoute("/api/dev/complete-onboarding")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!fake) return new Response("Not Found", { status: 404 });
        const { accountId } = (await request.json()) as { accountId?: string };
        if (!accountId?.startsWith("acct_")) return new Response("Bad Request", { status: 400 });
        fake.completeOnboarding(accountId);
        return Response.json({ ok: true });
      },
    },
  },
});
