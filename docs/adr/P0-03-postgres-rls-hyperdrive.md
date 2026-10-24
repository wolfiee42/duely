# P0-03: Postgres, RLS and Hyperdrive from a Worker

**Result: pass locally. Real Hyperdrive pooling is not yet verified (needs a deployed Hyperdrive config).**

## What I tried

A throwaway Postgres 18 (Homebrew binaries, own data dir, port 54329, trust auth) with the SPEC 2.1 shape: roles `duely_app` (`NOBYPASSRLS`) and `duely_system` (`BYPASSRLS`, member of `duely_app` per D4), and an `invoices` table with `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy on `current_setting('app.tenant_id', true)` (`USING` and `WITH CHECK`). 30 rows for tenant A, 20 for tenant B.

The dev Worker had two Hyperdrive bindings (`HYPERDRIVE_APP`, `HYPERDRIVE_SYSTEM`) with `localConnectionString`, and a spike route that builds `postgres()` + `drizzle()` **per request** from `env.<binding>.connectionString` and closes it in `finally` (SPEC 9.1). Tenant context is `set_config('app.tenant_id', $1, true)` inside a transaction (`SET LOCAL` semantics).

Files are archived in `docs/adr/P0-03-spike/`: `setup.sql`, `spike-route.ts`, `wrangler.hyperdrive.jsonc`. The app tree is reverted; nothing from the spike is in `apps/web`.

## Evidence (all through `vp dev`, workerd)

| Check                                                       | Result                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Tenant A / tenant B transaction                             | 30 / 20 rows, only own tenant                           |
| App role, no `withTenant` (no setting)                      | 0 rows. Fails closed                                    |
| Same connection after a tenant tx commits                   | 0 rows, setting empty. No context leaks after the tx    |
| Tx that throws after setting tenant                         | 0 rows afterwards. Nothing left on the connection       |
| System role, no tenant                                      | 50 rows (BYPASSRLS works)                               |
| System role, `set local role duely_app` + tenant B          | 20 rows, `current_user` back to `duely_system` after tx |
| Insert for tenant B while scoped to A                       | Rejected by `WITH CHECK`                                |
| 40 overlapping requests (20 per tenant, 300 ms in-tx sleep) | 20/20 and 20/20 correct; 0 cross-tenant results         |

## Findings and gotchas

- postgres-js + drizzle work in workerd via the Hyperdrive binding with `nodejs_compat`. `fetch_types: false` and `max: 1` used.
- Miniflare **requires a password** in `localConnectionString` or `vp dev` fails to start (any value works with trust auth).
- Local Hyperdrive is a direct connection, so this proves the SQL/RLS pattern and per-request client lifecycle, **not** Hyperdrive's transaction-mode pooling. Re-verify on a real Hyperdrive config before Phase 1 relies on D22 (short transactions); the leak and rollback checks above are the ones to repeat there.
- `set_config(..., true)` (transaction-local) is what makes pooled connections safe. Never use session-level `set`.
- Postgres' Unix socket path limit (103 bytes) breaks a data dir under the scratchpad; the spike disabled Unix sockets.

## Decision

D4 and D22 hold as written. `withTenant` = one transaction, `set_config('app.tenant_id', id, true)` first, DB work only. Real Hyperdrive verification is carried into P1-03.
