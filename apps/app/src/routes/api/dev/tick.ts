import { runDevTick } from "@repo/api/usecases";
import { createFileRoute } from "@tanstack/react-router";

import { fake, services, withSystemDb } from "#/lib/server/runtime.ts";

// Fake services mode only: there is no jobs worker locally, so this runs one scheduler cycle inline.
// `makeDue` pulls waiting reminders forward to now, standing in for days passing. 404 in live mode.
export const Route = createFileRoute("/api/dev/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!fake) return new Response("Not Found", { status: 404 });
        const { makeDue = false } = (await request.json().catch(() => ({}))) as {
          makeDue?: boolean;
        };
        return Response.json(
          await withSystemDb((db) =>
            runDevTick(db, services.queue, { makeDue, model: services.model }),
          ),
        );
      },
    },
  },
});
