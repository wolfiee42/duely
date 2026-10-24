# P0-04: Hono + tRPC on a Start `/api/$` route

**Result: pass.** Works in `vp dev`, in the built Worker (`vp preview`), and in a real browser. Nothing from the spike is left in `apps/web`; the code is archived in `docs/adr/P0-04-spike/` as `.txt` so lint does not type-check it.

## What I tried

- `/api/$` Start route forwards every method to `app.fetch(request, env, ctx)` on a Hono app with `basePath("/api")`.
- Hono mounts a `staffRouter` at `/api/trpc/staff/*` with `@hono/trpc-server`. One query, `ping({ name })`, validated by Zod.
- Router context carries `trpc`, built by `createIsomorphicFn`: on the server `createTRPCOptionsProxy({ router, ctx })` (in-process, no HTTP); in the browser `createTRPCClient` + `httpBatchLink({ url: "/api/trpc/staff" })`.
- A route loader warms the query with `queryClient.query(...).catch(noop)`; the component reads it with `useQuery(trpc.ping.queryOptions(...))`.
- A `vars` entry in `wrangler.jsonc` and a `ctx.waitUntil` call inside the procedure proved `env` and `ctx` reach both transports.

## Evidence

| Check                                     | Result                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/health` (Hono)                  | `env.SPIKE_VAR` visible via `c.env`; `c.executionCtx.waitUntil` is a function   |
| `GET /api/trpc/staff/ping?input=…` (curl) | Returns data, `via: "hono"`, `env` var present                                  |
| Invalid input (`name: ""`)                | tRPC error with the Zod issue                                                   |
| `ctx.waitUntil` inside a procedure        | Callback logged after the response was sent                                     |
| `/api/auth/*` (more specific route)       | Still handled by its own route, not swallowed by `/api/$`                       |
| SSR of `/spike`                           | Data is in the HTML, `via: "in-process"`                                        |
| Chromium: load `/spike`                   | Hydrates with the dehydrated result, **0** `/api/trpc` requests, no page errors |
| Chromium: change the query input          | One batched `GET /api/trpc/staff/ping?batch=1&input=…`, `via: "hono"`           |
| `vp build`                                | Passes. Client bundle contains no router code and no `cloudflare:workers`       |
| `vp preview` (built Worker)               | `/api/health`, tRPC over HTTP and SSR all behave as in dev                      |
| `vpr lint`                                | Clean apart from the existing template warning, after the fixes below           |

## How `env` and `ctx` reach Hono (answers SPEC 1.x)

- **`env`**: `import { env, waitUntil } from "cloudflare:workers"`. Start handlers receive only `{ request }`, so this is the only route to bindings. `app.fetch(request, env, ctx)` then gives Hono `c.env`.
- **`ctx`**: there is no `ExecutionContext` in a Start handler. Pass `{ waitUntil, passThroughOnException() {} }` (cast) as the third argument; `c.executionCtx.waitUntil` then works.
- **In-process tRPC** has no Hono context, so build its context from the same `env` / `waitUntil` imports. Keep one context factory shared by both paths so they cannot drift.

## Gotchas for Phase 1

- Types for `cloudflare:workers` and `ExecutionContext` need `wrangler types` (writes `worker-configuration.d.ts`, already gitignored). Add it as a script and run it before lint and in CI, and again after any `wrangler.jsonc` change.
- `#/…` imports need the explicit extension (`#/spike/hono.ts`), as in the existing code.
- `prefetchQuery` is deprecated here; use `queryClient.query(...).catch(noop)` (matches `.agents/data-flow.md`).
- The root route context type must include `trpc`. A `ReturnType<typeof createStaffTrpc>` worked; give the real client a named type in `packages/api`.
- The server branch of `createIsomorphicFn` did not leak into the client bundle (checked by grepping `dist/client`). Re-check when the real router, which pulls in `packages/db`, is wired.
- `D21` assumed an in-process caller bound to the request context. The spike used a fresh context per call; the real one must read the session from `getRequest()` and open `withTenant` per procedure.

## Versions

| Package                                      | Version |
| -------------------------------------------- | ------- |
| hono                                         | 4.13.13 |
| @hono/trpc-server                            | 0.4.2   |
| @trpc/server / client / tanstack-react-query | 11.19.0 |
| zod                                          | 4.6.7   |

## Decision

D18, D19 and D21 hold as written. Proceed with Hono at `/api/$`, `staffRouter` at `/api/trpc/staff`, in-process on the server and `httpBatchLink` in the browser.
