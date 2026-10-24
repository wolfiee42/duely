# P0-06: Host-kind middleware and `*.localhost` dev

**Result: pass.** A global Start request middleware resolves the host kind, unknown hosts get a 404, and route groups reject the wrong kind with a 404. Works in `vp dev` on `*.localhost`, in the built Worker with production hostnames, and in a real browser. Nothing from the spike is left in `apps/web`; the code is archived in `docs/adr/P0-06-spike/` as `.txt`.

## What I tried

- `resolveHostKind(hostHeader, rootDomain)`: a pure function returning `{ hostKind, slug }` or `null`. `rootDomain` is `duely.app` in production and `localhost` in dev, so `acme.localhost` takes the same path as `acme.duely.app`. Rules from SPEC 1.x: `root` and `www.root` are `marketing`, `app.root` is `app`, any other valid slug is `portal`; reserved or malformed slugs and foreign hosts return `null`.
- `src/start.ts` with `createStart(() => ({ requestMiddleware: [hostMiddleware] }))`. The middleware returns `new Response("Not Found", { status: 404 })` for `null`, otherwise `next({ context })`.
- `$getHostContext`, a server function with `.middleware([hostMiddleware])`, returns the context to route code.
- Two pathless route groups, `_hk-app` and `_hk-portal`, whose `beforeLoad` calls `requireHostKind(kind)` and throws `notFound()` on a mismatch.
- A `Set-Cookie` route without a `Domain` attribute, to check host-only cookie scope.

## Evidence

Dev (`*.localhost:3055`):

| Request                                                                           | Status |
| --------------------------------------------------------------------------------- | ------ |
| `localhost/`, `www.localhost/`                                                    | 200    |
| `app.localhost/staff-only`                                                        | 200    |
| `app.localhost/portal-only` (wrong kind)                                          | 404    |
| `acme.localhost/portal-only`                                                      | 200    |
| `acme.localhost/staff-only` (wrong kind)                                          | 404    |
| `localhost/staff-only` (marketing on app route)                                   | 404    |
| `admin.localhost/` (reserved), `ab.localhost/` (too short), `evil.com.localhost/` | 404    |
| `acme.localhost/api/auth/ok` (middleware covers `/api`)                           | 200    |

Built Worker (`vp preview`, `Host: …duely.app`): the same matrix gives identical results, and `localhost` itself now returns 404 because the root domain is `duely.app`.

Browser (Chromium):

| Check                                                         | Result                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Client-side navigation `app.localhost` to a portal-only route | Not-found page rendered, route content never shown                       |
| Client-side navigation `app.localhost` to a staff-only route  | Renders                                                                  |
| Direct load `acme.localhost/portal-only`                      | Renders with `slug = acme`                                               |
| Cookie set on `app.localhost` without `Domain`                | Present for `app.localhost`; absent for `acme.localhost` and `localhost` |

The middleware ran once per request even with it attached to the server function as well. `vpr lint` is clean apart from the existing template warning.

## Gotchas for Phase 1

- **Type the context by attaching the middleware to the server function** (`.middleware([hostMiddleware])`). Without it `context` is `possibly undefined`; Start has no `Register` hook for global request middleware.
- **Guard on the server, not in the client router context.** `beforeLoad` also runs on the client, so it must call a server function (`$getHostContext`) rather than read anything the client could set.
- **Vite rejects unknown `Host` headers** (403) in dev and preview. That is a dev-tool check and not the guard. To test production hostnames against `vp preview`, temporarily set `preview.allowedHosts: true` (I reverted it).
- **Root domain must not use `import.meta.env.DEV`** in the real code. Put it in the Varlock schema (for example `ROOT_DOMAIN`, `localhost` locally) so staging and preview deployments work.
- **Custom domains** (`active` rows) need `resolve_tenant_by_host` in the database, so `resolveHostKind` cannot decide them alone. P1-05 should call the pure function first and fall back to the lookup only for hosts it cannot classify, with a short per-request cache.
- Hono and tRPC are not behind a separate guard yet; the global middleware already 404s unknown hosts on `/api/*`, but the per-router kind check (`staffRouter` needs `app`, `portalRouter` needs `portal`) still belongs in P1-05.
- React inserts `<!-- -->` between adjacent text nodes in SSR output, so a `grep` for `portal-only:acme` on raw HTML misses; assert in a browser or on a single text node.

## Decision

SPEC 1.x host handling holds as written. Host-kind resolution lives in a pure function in `packages/api`, applied by a global Start request middleware, with route-group guards that throw `notFound()`.
