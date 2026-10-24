# P0-05: Varlock vs Worker `env` (D23)

**Result: pass, with a changed plugin.** Keep Varlock as the typed schema and validation layer, but switch from `@varlock/vite-integration` to `@varlock/cloudflare-integration`. Bindings (Hyperdrive, R2, Queues, and so on) come from the Worker `env`, never from Varlock.

## The problem with the current setup

`varlockVitePlugin({ ssrInjectMode: "resolved-env" })`, which P0-02 left in place, **bakes the build machine's resolved values into the built Worker**. I built with canary values and grepped:

| Check                                            | `@varlock/vite-integration` (before) | `@varlock/cloudflare-integration` (after) |
| ------------------------------------------------ | ------------------------------------ | ----------------------------------------- |
| Canary `BETTER_AUTH_SECRET` in `dist/`           | **Found** in `dist/server/index.js`  | Not found                                 |
| Canary `DATABASE_URL` (with password) in `dist/` | **Found**, plaintext                 | Not found                                 |
| `encryptInjectedEnv`                             | `false`                              | n/a                                       |
| Secrets rotated with `wrangler secret put`       | Ignored, build-time values win       | Applied                                   |
| Server-entry workaround (D30)                    | Needed                               | Not needed                                |

So the previous setup would publish production secrets inside the Worker source and make rotation require a rebuild. The Cloudflare integration stores sensitive values as Cloudflare secrets and the rest as vars.

## What I tried

- Installed `@varlock/cloudflare-integration` 1.6.2 and replaced `varlockVitePlugin(...)` + `cloudflare(...)` with `varlockCloudflareVitePlugin({ viteEnvironment: { name: "ssr" } })` in `apps/web/vite.config.ts`. Removed `withQueryInsensitiveIncludes` and the `ssrEntryModuleIds` override.
- Removed the direct `@varlock/vite-integration` dependency (the new package brings what it needs).
- `deploy` script is now `vp run build && varlock-wrangler deploy`.
- `ENV` from `varlock/env` is unchanged in `packages/auth` and `packages/db`.

## Evidence

| Check                               | Result                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `vp build` with canary secrets      | Passes; 0 files in `dist/` contain a canary                                      |
| `vp dev`                            | `/`, `/login` and `/api/auth/ok` return 200 (auth and db load `ENV`)             |
| `vp preview` (built Worker)         | Same three routes return 200                                                     |
| `varlock-wrangler deploy --dry-run` | Passes. "1 var, 2 secrets" detected; no canary in output. 3.2 MiB / 728 KiB gzip |
| `vpr lint`                          | Clean apart from the existing template warning                                   |

I did not run a real deploy: it needs your Cloudflare login and would publish a Worker and upload secrets.

## Rules this sets

1. **Strings** (secrets, URLs, flags): declare in `apps/web/.env.schema`, read with `ENV` from `varlock/env`. Sensitive ones must be marked `@sensitive` so they become Worker secrets.
2. **Bindings** (Hyperdrive, R2, Queues, KV, Durable Objects, service bindings): declare in `wrangler.jsonc`, read with `env` from `cloudflare:workers` (see ADR P0-04). They are objects and Varlock cannot represent them.
3. `DATABASE_URL` is for local tools and migrations only. The Worker reaches Postgres through the Hyperdrive binding (ADR P0-03).
4. Do not create a `.dev.vars` file; the plugin throws if one exists.
5. Use `varlock-wrangler` instead of `wrangler` for deploy. Type generation stays plain `wrangler types` (bindings only; it must not require real secrets, so CI can run it). Secrets and vars are typed by the Varlock `env.d.ts`.

## Risks

- `@varlock/cloudflare-integration` is a young package that wraps `@cloudflare/vite-plugin`; a version bump of either should re-run this check (canary build, dev, preview, dry-run).
- Varlock patches `console` and `Response` for redaction and leak prevention. I did not measure the runtime cost; check it when load testing.
- Secrets are uploaded by `varlock-wrangler deploy` from the machine or CI that runs it, so that environment must hold the real values (CI secrets, or a Varlock plugin for a secret store). Decide this in P1 CI work.

## Decision

D23 resolved: Varlock schema + `@varlock/cloudflare-integration` for strings, Worker `env` for bindings. D30 is superseded.
