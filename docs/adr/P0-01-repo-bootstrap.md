# P0-01: Repo bootstrap from cove-monorepo

**Result: pass.**

## What I tried

- The repo already existed as a copy of `mugnavo/cove-monorepo` with `.cove.jsonc` in place (`source` points at the template), so no re-creation was needed.
- `vp install`, then `vpr dev:web`, then `curl http://localhost:3000/`.
- Deleted the `_DELETE_ME_*` folders (`apps/web/src/components/_DELETE_ME_intro-page`, `apps/web/e2e/_DELETE_ME_example-tests`) and replaced the home route with a one-line placeholder so nothing imports them.
- `vpr lint`.

## What worked

- Install completes (about 39s). The `prepare` hook ran `vp config` and `varlock codegen` successfully.
- `vpr dev:web` serves `/` with HTTP 200 and the placeholder `<h1>Duely</h1>` rendered by SSR.
- `vpr lint` (type-aware lint + type check) passes. One pre-existing warning from the template: unused parameter `r` in `packages/db/src/schema/relations.ts`.
- `pnpm-lock.yaml` was not tracked by the template; it is committed now so versions stay pinned.

## Findings

- `varlock load --agent --path apps/web` reports the config invalid until `BETTER_AUTH_SECRET` is set in `apps/web/.env.local`. `DATABASE_URL` resolves (value redacted) but varlock warns that the `postgresql` protocol will need `allowedProtocols` in the next varlock major. For this spike I supplied a throwaway `BETTER_AUTH_SECRET` through the process environment only; nothing was written to disk. The developer needs to add a real local value.
- The `vp` CLI reports "Local vite-plus: Not found" before install; after install it resolves normally.

## Versions

| Tool                                    | Version                                            |
| --------------------------------------- | -------------------------------------------------- |
| Node                                    | 24.22.1                                            |
| pnpm                                    | 12.15.0                                            |
| vite-plus (`vp`)                        | 1.3.0                                              |
| vite                                    | `npm:@voidzero-dev/vite-plus-core@1.3.0` (aliased) |
| @tanstack/react-start                   | 1.169.4                                            |
| nitro (still present, removed in P0-02) | 3.0.260903-beta                                    |

## Decision

Proceed to P0-02. No change to SPEC.md decisions.
