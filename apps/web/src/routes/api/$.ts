import { createFileRoute } from "@tanstack/react-router";

import { app, env, executionContext } from "#/lib/server/runtime.ts";

// Every /api/* request goes through Hono (D18); more specific routes can still win.
const handle = ({ request }: { request: Request }) => app.fetch(request, env, executionContext);

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
