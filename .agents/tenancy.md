# Tenancy

Every firm's data is isolated by Postgres row-level security. The rules below keep that true; the
suites in `packages/db/src/tenant-isolation.test.ts` and `packages/api` prove it.

## Roles (SPEC D4)

- `duely_owner` owns the schema and runs migrations (`DATABASE_URL`, local tools and tests only).
- `duely_app` serves every request path. RLS is enforced and it has no `BYPASSRLS`.
- `duely_system` is for the jobs worker and webhook ingress. It bypasses RLS, so it must drop into a tenant
  (`set local role duely_app` + tenant setting) per unit of work.
- `packages/db/sql/roles.sql` creates them (idempotent, PostgreSQL 16+). Docker Compose runs it on first start.

## Rules

- Request code reaches the database through `withTenant(db, tenantId, tx => ...)` only. Only `packages/db` may
  import a Postgres driver (lint-enforced). Do DB work inside it and nothing else: no Stripe, email, AI or R2
  calls (Hyperdrive holds the connection for the whole transaction, D22).
- Build the client per request with `createDb()` from the Hyperdrive binding, never at module scope, and close it.
- Staff tenant comes from the user's `members` row; portal tenant comes from the host. Never from client input.
  Portal procedures never accept `tenantId` or `clientId`.
- Before a tenant is known, RLS hides everything. Use the SECURITY DEFINER resolvers (`resolveTenantByHost`,
  `resolveMembership`, ...) in `packages/db/src/resolvers.ts`. They return only what the caller needs.
- A new tenant table needs `tenant_id uuid not null references firms(id)`, the `tenant_isolation` policy,
  `enable` + `force` row level security, explicit grants, and a case in the tenant-isolation suite.
  Write these in a custom migration (`vpr db generate --custom --name=...`); `audit_log` stays append-only.
- Better Auth tables (`user`, `session`, `account`, `verification`) are outside RLS (D27).
