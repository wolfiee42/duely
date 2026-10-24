# P0-02: Cloudflare Vite plugin with Cove's aliased Vite

**Result: pass.** Build, local Worker runtime, deploy dry-run and `vp dev` all work. Dev needed one workaround for Varlock's entry detection (option 3 below, applied in `b1bc95b`). The runtime env decision (D23) is still open for P0-05.

## What I tried

- Removed Nitro: `nitro.config.ts`, the `nitro()` plugin, the `nitro` dependency, the Nitro build-cache entries, the `start` script, and the Nitro-only evlog wiring (`src/lib/logger.server.ts`, `evlogErrorHandler` middleware in `__root.tsx`).
- Added `@cloudflare/vite-plugin` and `wrangler` to the pnpm catalog and `apps/web` devDependencies, pinned exactly. Added `workerd: true` to `allowBuilds` (its postinstall is required).
- `vite.config.ts`: `cloudflare({ viteEnvironment: { name: "ssr" } })` before `tanstackStart()`.
- `apps/web/wrangler.jsonc`: `nodejs_compat`, `main: "@tanstack/react-start/server-entry"`, observability on.
- Added a `deploy` script (`vp run build && wrangler deploy`).

## Evidence

| Check                                                                          | Result                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Install, peer deps (`vite ^8`, `wrangler ^4.152.0`) against the aliased `vite` | Clean, no peer warnings for the Cloudflare packages                                         |
| `vp build`                                                                     | Passes (about 1s). Emits `dist/server/index.js`, `dist/server/wrangler.json`, `dist/client` |
| `vp preview` (built Worker in workerd)                                         | `/` and `/login` return 200, SSR renders the page                                           |
| `wrangler deploy --dry-run`                                                    | Passes. 46 modules, 2.5 MiB, 728 KiB gzip. No bindings yet                                  |
| `vpr lint`                                                                     | Passes (one pre-existing template warning)                                                  |
| `vp dev` (before the workaround)                                               | Starts, workerd boots, every request returns 500: `Error: varlock ENV not initialized`      |
| `vp dev` (with option 3, `b1bc95b`)                                            | `/` and `/login` return 200, SSR renders the page                                           |

I did not run a real `wrangler deploy`: it needs the developer's Cloudflare login and would publish a Worker. Say so if you want that done.

## Why `vp dev` fails

Varlock only injects its init code into modules it recognises as SSR entry points. Under the Cloudflare plugin it recognises none, so `ENV` (imported at module scope by `packages/auth` and `packages/db`) throws.

- Without any option, both dev and the built Worker fail.
- `ssrEdgeRuntime: true` plus `ssrEntryModuleIds: [<resolved path of @tanstack/react-start/server-entry>]` fixes the **built** Worker (rollup gives the exact path).
- In **dev** the same module is loaded as `…/default-entry/esm/server.js?v=7b78e36f`. Varlock matches `ssrEntryModuleIds` with exact string equality, so the query hash breaks the match and no entry is detected. I confirmed this with a throwaway probe plugin (since removed) and by the absence of any "detected entry" debug line.

This is the Varlock-on-Workers question that D23 assigns to P0-05. The Cloudflare plugin itself is not the cause.

## Versions

| Package                             | Version                        |
| ----------------------------------- | ------------------------------ |
| @cloudflare/vite-plugin             | 1.65.0                         |
| wrangler                            | 4.152.0 (workerd 1.20261019.1) |
| vite-plus / aliased vite            | 1.3.0                          |
| @tanstack/react-start               | 1.169.4                        |
| @varlock/vite-integration / varlock | 1.5.4 / 1.23.0                 |
| Node / pnpm                         | 24.22.1 / 12.15.0              |

## Decision / options

D17 and D26 hold: the plugin works with Cove's aliased Vite, so the "plain Vite" fallback is **not** needed and would not fix this. **Chosen: option 3** (D30). Options considered for the dev gap:

1. **Varlock's Cloudflare integration** (`@varlock/cloudflare-integration` is referenced in the plugin's types). Adds a dependency; needs checking in P0-05.
2. **Worker `env` plus a Zod-validated module** (D23 fallback). Varlock stays for local/CI validation and codegen; runtime reads bindings. Larger change to `packages/auth` and `packages/db`, which Phase 1 reshapes anyway (P1-03, P1-07).
3. **Make Varlock's matcher accept the dev id** with a small wrapper, for example an array whose `includes` ignores the `?v=` query. Works today but couples to a plugin internal. **Applied** as `withQueryInsensitiveIncludes` in `apps/web/vite.config.ts`; `vp dev` then returns 200. Risk: a Varlock upgrade that changes how it matches entry ids breaks dev and the build silently; re-test after any Varlock bump. P0-05 may still replace this with option 1 or 2.

## Side effects to know about

- Nitro removal leaves `start:e2e` in `apps/web/package.json` and `playwright.config.ts` pointing at `.output/server/index.mjs`, which no longer exists. There are no E2E specs yet; fix when P2-17 adds the first one.
- Request logging: evlog's Nitro integration is gone. Replacement is SPEC open item 5 (Phase 1).
- Verification gotcha: if port 3000 is already taken, Vite silently moves to 3001, so a curl on 3000 can hit someone else's server. Use `--port N --strictPort` when testing.
- `vp run build` strips env vars not declared in the task, so a missing `BETTER_AUTH_SECRET` fails the build in a local shell. Real values go in `apps/web/.env.local`; I used a throwaway process-only value and wrote no secrets.

## Update (P0-05)

The `withQueryInsensitiveIncludes` workaround (D30) has been removed. P0-05 found that `@varlock/vite-integration` bakes secrets into the Worker and replaced it with `@varlock/cloudflare-integration`, which needs no entry-id workaround. See `docs/adr/P0-05-env.md`.
