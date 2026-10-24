# Duely: Technical Spec

> Implements `PRD.md` and `FEATURE_REQUIREMENTS.md` (FR-x.y IDs reference the latter).
> **Status:** Draft v2 · **Last updated:** 2026-10-24
> **Rev 2:** stack moved from Next.js to **TanStack Start + tRPC + Hono**; repo is based on **`mugnavo/cove-monorepo`**; staff and portal are separated by host kind; transactions are kept short for Hyperdrive; all outbound email goes through an outbox. Sections 0, 1, 6, 9, 10, 11 are rewritten, 3.2 and parts of 4 and 7 to 8 are amended, the schema (section 2) is unchanged apart from three small additions.
> Rule for this doc: decisions are written down _before_ code. If code disagrees with this file, fix one of them in the same PR.

## 0. Decisions log

| #   | Decision                   | Choice                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `overdue` authority        | Stored `status` is authoritative; scheduler sweep sets it. UI and APIs use `effective_status()` (computed from `due_date` + clock) so they are never stale between sweeps                                                                                                                                                                                                              | Fast queries plus no stale reads                                                                                                   |
| D2  | Promised / disputed        | Real statuses (per PRD), but the _pre-state_ is stored on the promise or dispute row so resolution restores the correct state                                                                                                                                                                                                                                                          | Avoids guessing on return                                                                                                          |
| D3  | Partial payments           | Not in v1. `payments.amount_minor` may be less than the invoice total at schema level; the app rejects it                                                                                                                                                                                                                                                                              | Cheap v1.1 upgrade                                                                                                                 |
| D4  | DB roles                   | `duely_app` (RLS enforced, used by all request paths), `duely_system` (BYPASSRLS, used only by the jobs worker and webhook ingress, then drops into tenant context per unit of work). One Hyperdrive config per role                                                                                                                                                                   | Cron and webhooks have no host to resolve                                                                                          |
| D5  | Tenant context             | `withTenant(tenantId, fn)` opens a transaction and runs `select set_config('app.tenant_id', $1, true)` first (the parameterized form of `SET LOCAL`, which cannot take bind parameters). It is the only DB entry point in request paths                                                                                                                                                | One choke point to test                                                                                                            |
| D6  | Time                       | Every time-dependent code path reads `clock.now(firmId)`. Demo firms have `clock_offset_seconds`; others always 0                                                                                                                                                                                                                                                                      | Makes simulate-time trivial                                                                                                        |
| D7  | IDs                        | UUID primary keys (`gen_random_uuid()`); human-facing invoice numbers are separate                                                                                                                                                                                                                                                                                                     | No enumeration                                                                                                                     |
| D8  | Money                      | `bigint` minor units + `char(3)` currency (always `USD` in v1, enforced by CHECK). Drizzle maps to JS `number` (safe far beyond any invoice)                                                                                                                                                                                                                                           | No floats                                                                                                                          |
| D9  | Staff auth                 | better-auth, email + password, mounted in Hono at `/api/auth/*` on the app host. GitHub/Google providers from Cove are removed for v1                                                                                                                                                                                                                                                  | Existing stack depth; smaller env surface                                                                                          |
| D10 | Client auth                | Own magic-link implementation (`portal_tokens`), host-only session cookie on the tenant host                                                                                                                                                                                                                                                                                           | Different trust model than staff                                                                                                   |
| D11 | Soft vs hard delete        | Soft delete (`archived_at`) for clients; invoices are never deleted after `sent`; ledger rows are immutable                                                                                                                                                                                                                                                                            | Audit integrity                                                                                                                    |
| D12 | Webhook ingress            | Verify signature → insert into `stripe_events` (unique on event id) → process in one short transaction; on failure leave `processed_at` null so retry reprocesses; side effects are queued after commit (D22)                                                                                                                                                                          | Simple and idempotent                                                                                                              |
| D13 | Queue payloads             | IDs only (`process_job {job_id}`, `send_message {message_id}`, `classify_reply {message_id}`); workers re-read everything from the DB                                                                                                                                                                                                                                                  | Re-check at send (FR-9.9)                                                                                                          |
| D14 | Reply matching             | `reply+{token}@inbound.duely.app` per outbound message, falling back to sender + subject                                                                                                                                                                                                                                                                                               | FR-8.5                                                                                                                             |
| D15 | Validation                 | Zod schemas shared between tRPC inputs, Hono handlers, forms, and AI structured output                                                                                                                                                                                                                                                                                                 | Single source of truth                                                                                                             |
| D16 | Framework                  | **TanStack Start** (React 19, Router, Query) with SSR on Cloudflare Workers. Replaces Next.js                                                                                                                                                                                                                                                                                          | Requested; file-based routing and Query-owned data fit the portal and dashboard well                                               |
| D17 | Deploy target              | `@cloudflare/vite-plugin` + `wrangler.jsonc` (the setup TanStack's own hosting guide documents for Workers). Cove's **Nitro is removed**, including its evlog Nitro module                                                                                                                                                                                                             | Nitro is Cove's default, but the documented Workers path does not use it                                                           |
| D18 | Transport split            | **Hono** = HTTP edge (better-auth, webhooks, inbound email, magic-link consume, file upload and download, health). **tRPC** = typed app RPC for staff and portal. **Start server functions** = only SSR route guards (`$getUser`, `$getHostContext`). Business logic lives in `packages/api/usecases`; handlers stay thin                                                              | One RPC style, no overlap                                                                                                          |
| D19 | Two tRPC routers           | `staffRouter` at `/api/trpc/staff`, `portalRouter` at `/api/trpc/portal`, mounted with `@hono/trpc-server`. Separate contexts and separate client types                                                                                                                                                                                                                                | A portal bundle can never call a staff procedure                                                                                   |
| D20 | Host kinds                 | `marketing` (`duely.app`), `app` (`app.duely.app`), `portal` (`{slug}.duely.app` or an `active` custom domain). Staff cookie is host-only on the app host and never sent to tenant hosts. Staff tenant comes from the `members` row; portal tenant comes from the host. Webhooks are accepted on the app host only. Supersedes the "tenant from Host for everything" wording of FR-1.3 | Custom domains only ever expose the client portal; staff sessions cannot leak to tenant subdomains                                 |
| D21 | SSR data                   | On the server, tRPC runs in-process (options proxy bound to the router and request context); in the browser it uses `httpBatchLink`. Loaders follow Cove's `.agents/data-flow.md` (Query owns server data)                                                                                                                                                                             | No self-HTTP on Workers; keeps Cove's data rules                                                                                   |
| D22 | Short transactions, outbox | Hyperdrive holds a connection for the whole transaction, so transactions contain **DB work only**: no Stripe, Resend, Claude, or R2 calls inside one. Outbound email is an outbox: insert `messages(status='queued')`, commit, then enqueue `send_message`. Same for receipts and notifications                                                                                        | Correct under Hyperdrive and crash-safe                                                                                            |
| D23 | Env and bindings           | Typed env via Cove's Varlock schema for local, CI, and codegen; at runtime on Workers, bindings come from the Worker `env`. Final choice is made in spike P0-05                                                                                                                                                                                                                        | Varlock on Workers is unverified                                                                                                   |
| D24 | Jobs worker                | One extra Worker, `workers/jobs`, exporting `scheduled()` (tick) and `queue()` (consumers). The web Worker only produces to the queue                                                                                                                                                                                                                                                  | Avoids custom-entry tricks in the Start Worker                                                                                     |
| D25 | Repo provenance            | Create from **`mugnavo/cove-monorepo`** (not the single-package `cove`) as a GitHub template rather than a fork; keep `.cove.jsonc` so Cove's `sync-template` skill can pull upstream changes; credit Cove Stack in the README                                                                                                                                                         | The monorepo already has `apps/`, `packages/{auth,db,ui,logger}`, `tools/tsconfig`; a template gives a clean history for a CV repo |
| D26 | Toolchain                  | Keep Cove's pinned toolchain (Vite+, Oxlint/Oxfmt, pnpm 12, Node 24, TypeScript 7, Drizzle 1.0 RC, Tailwind 4, shadcn on Base UI). Spike P0-02 confirms `@cloudflare/vite-plugin` works with Cove's aliased `vite`; fallback is plain Vite. No dependency upgrades mid-build                                                                                                           | Cove's versions are very new; stability beats freshness                                                                            |
| D27 | Auth tables                | better-auth tables (`user`, `session`, `account`, `verification`) are not tenant-scoped and have no RLS. `members` links a user to exactly one firm in v1                                                                                                                                                                                                                              | better-auth owns that schema                                                                                                       |
| D28 | Hyperdrive caching         | Query caching **disabled** on both Hyperdrive configs                                                                                                                                                                                                                                                                                                                                  | The ledger and statuses must never be served stale                                                                                 |
| D29 | Idempotency                | Side-effecting mutations take a client-generated `idempotencyKey`; results are stored in `idempotency_keys` for 24h. Other mutations rely on state-machine guards                                                                                                                                                                                                                      | The v1 spec referenced stored keys but had no table                                                                                |

---

## 1. Repo and project structure

### 1.1 Layout

Created from `mugnavo/cove-monorepo`. Items marked (Cove) come from the template.

```
duely/
  apps/
    web/                           # TanStack Start app, deployed as a Cloudflare Worker
      src/
        routes/
          __root.tsx               # (Cove)
          _marketing/              # host kind: marketing
            index.tsx
          _guest/                  # host kind: app. login, signup (Cove)
          _staff/                  # host kind: app. guarded layout (Cove's _auth)
            app/                   # dashboard, invoices, clients, policies, review, domains, settings
          _portal/                 # host kind: portal
            portal/                # login, invoices, invoice detail, receipts
          api/$.ts                 # forwards every /api/* request to the Hono app
        start.ts                   # global request middleware: request id, host kind
        router.tsx                 # QueryClient, tRPC options proxies (Cove + additions)
        lib/trpc/                  # staff.ts, portal.ts (browser clients), server.ts (in-process)
        lib/host.ts                # host-kind route guards
      wrangler.jsonc               # bindings, routes, compatibility flags
      vite.config.ts               # cloudflare() + tanstackStart() + react + tailwind
  workers/
    jobs/                          # scheduled() tick, queue() consumers, sweeps
      src/index.ts  tick.ts  process-job.ts  send-message.ts  classify-reply.ts  sweeps.ts
      wrangler.jsonc
  packages/
    api/                           # Hono app + tRPC routers + use-cases
      src/hono/                    # app.ts, middleware/, routes/
      src/trpc/                    # init.ts, context-staff.ts, context-portal.ts, routers/{staff,portal}/
      src/usecases/                # send-invoice.ts, create-promise.ts, apply-payment.ts, ...
    auth/                          # createAuth() factory (Cove) + portal magic-link module
    db/                            # Drizzle schema, migrations, createDb(), withTenant()   (Cove, reshaped)
    domain/                        # pure: state machines, planner, money, date parsing
    clock/                         # clock service
    ai/                            # prompts, Zod schemas, runAi(), ai_runs logging
    email/                         # templates + Resend adapter
    stripe/                        # Connect helpers, webhook handlers
    cloudflare/                    # custom hostname API client
    ui/                            # shadcn on Base UI, theme provider                       (Cove)
    logger/                        # evlog config and helpers                                 (Cove)
  tools/tsconfig/                  # shared tsconfig                                          (Cove)
  docs/                            # PRD.md, FEATURE_REQUIREMENTS.md, SPEC.md, adr/
  seed/                            # demo seed + eval set
  AGENTS.md  .agents/              # Cove's agent guidelines + Duely rules (tenancy, money, ai)
  .cove.jsonc                      # template provenance for sync-template
```

### 1.2 Dependency rules

| Package                               | May import                                                       | Must not import                        |
| ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `domain`, `clock`                     | each other (types only)                                          | everything else; no IO                 |
| `db`                                  | `domain` (types)                                                 | `api`, `auth`, anything Start-specific |
| `email`, `stripe`, `cloudflare`, `ai` | `domain`, `clock`                                                | `api`, `apps/*`                        |
| `auth`                                | `db`                                                             | `apps/*`                               |
| `api`                                 | all packages above                                               | `apps/*`, `workers/*`                  |
| `workers/jobs`                        | `db`, `domain`, `clock`, `email`, `ai`, `stripe`, `api/usecases` | `api/hono`, `api/trpc`, `apps/*`       |
| `apps/web`                            | `api`, `auth`, `ui`, `logger`                                    | `workers/*`                            |
| `ui`                                  | nothing from the domain                                          | domain packages                        |

Enforced with import-restriction lint rules (P1-01). `packages/domain` stays pure so state machines and the planner are unit-testable without infrastructure.

### 1.3 Cove adoption map

| Cove piece                                                                                                             | Action                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| App shell: `router.tsx`, `__root.tsx`, `default-catch-boundary`, `default-not-found`, `theme-provider`, `theme-toggle` | Keep                                                                                                               |
| `_guest/login`, `_guest/signup`                                                                                        | Keep; app host only; signup becomes a two-step flow that also creates the firm                                     |
| `_auth/route.tsx` and the `$getUser` + `authQueryOptions` pattern                                                      | Keep as `_staff`; add member and tenant lookup, owner-role helper                                                  |
| `packages/ui` (shadcn on Base UI)                                                                                      | Keep; add components with `vpr ui add`                                                                             |
| `packages/logger` + evlog                                                                                              | Keep the package; **replace the Nitro wiring** with Hono and Start middleware that emit one event per request      |
| `nitro.config.ts`, `nitro` dependency, `.output` start script                                                          | Delete; add `@cloudflare/vite-plugin`, `wrangler.jsonc`, `deploy` script                                           |
| `packages/db/src/index.ts` (module-level `postgres(ENV.DATABASE_URL)`)                                                 | Replace with `createDb(connectionString)` factory built per request from the Hyperdrive binding, plus `withTenant` |
| `@tanstack/react-start/server-only` import and the `react-start` peer dependency in `packages/db` and `packages/auth`  | Remove, so `workers/jobs` can import both packages                                                                 |
| `packages/auth/src/auth.ts` (module-level singleton)                                                                   | Replace with `createAuth({ db, baseURL, secret })`                                                                 |
| GitHub and Google social providers, their env vars                                                                     | Remove for v1                                                                                                      |
| `routes/api/auth/$.ts`                                                                                                 | Delete; better-auth is mounted in Hono                                                                             |
| `_DELETE_ME_*` demo files                                                                                              | Delete                                                                                                             |
| Varlock `.env.schema` and `ENV` import                                                                                 | Keep for typed env, local and CI validation; runtime access on Workers decided in P0-05                            |
| `docker-compose.yml`, `dev.sh`                                                                                         | Keep for local Postgres; extend to start the jobs worker and Stripe CLI forwarding                                 |
| `.agents/*`, `AGENTS.md`                                                                                               | Keep; add `tenancy.md`, `money.md`, `ai.md`                                                                        |
| `.cove.jsonc` + `sync-template` skill                                                                                  | Keep                                                                                                               |
| Vitest + Playwright setup, `fallow`                                                                                    | Keep and extend                                                                                                    |
| `public/_headers`                                                                                                      | Keep and add security headers (Cove leaves this as a TODO)                                                         |

### 1.4 Host kinds and request flow

| Kind        | Hosts                                          | Serves                                                                                                         | Session cookie                 |
| ----------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `marketing` | `duely.app`, `www.duely.app`                   | `_marketing` routes                                                                                            | none                           |
| `app`       | `app.duely.app`                                | `_guest` and `_staff` routes; `/api/auth/*`; `/api/trpc/staff/*`; `/api/webhooks/*`; `/api/inbound/*`; uploads | better-auth session, host-only |
| `portal`    | `{slug}.duely.app`; any `active` custom domain | `_portal` routes; `/api/trpc/portal/*`; `/api/portal/auth/:token`                                              | portal session, host-only      |
| any         | n/a                                            | `/api/health`, `/api/unsubscribe/:token`                                                                       | none                           |

```
Request
  -> Start global middleware: request id, resolveHostKind(host) [+ tenant for portal hosts]
  -> /api/*   : forwarded to Hono (middleware: request id, logger, host-kind guard, secure headers, rate limit)
                 -> /api/trpc/staff/*   : staffRouter  (requires hostKind=app, session, member)
                 -> /api/trpc/portal/*  : portalRouter (requires hostKind=portal, portal session)
                 -> other Hono routes   : thin handlers calling use-cases
  -> otherwise: SSR route tree. Route-group beforeLoad rejects a mismatched host kind (404, not a redirect)
```

Rules:

- `resolveHostKind` is a pure function in `packages/api` with table-driven tests. Unknown hosts get a generic 404.
- Platform slugs are lowercase, 3 to 30 characters, and not reserved: `app`, `www`, `api`, `inbound`, `mail`, `admin`, `status`, `docs`, `assets`.
- Local development uses `*.localhost`: `app.localhost:3000`, `acme.localhost:3000`. `acme.localhost` resolves to the `acme` firm via the same code path as production.
- Hono mounting, following Cove's server-route style:

```ts
// apps/web/src/routes/api/$.ts
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => app.fetch(request, env, ctx),
      POST: ({ request }) => app.fetch(request, env, ctx),
      PUT: ({ request }) => app.fetch(request, env, ctx),
      PATCH: ({ request }) => app.fetch(request, env, ctx),
      DELETE: ({ request }) => app.fetch(request, env, ctx),
    },
  },
});
```

How `env` and `ctx` are obtained on Workers (for example `import { env } from "cloudflare:workers"`) is confirmed in spike P0-04.

---

## 2. Database schema

Conventions: every tenant table has `tenant_id uuid not null references firms(id)`, `created_at`, `updated_at`; RLS enabled and forced.

### 2.1 RLS template

```sql
-- applied to every tenant table T
alter table T enable row level security;
alter table T force row level security;

create policy tenant_isolation on T
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- unset or empty setting => NULL => no rows match (fail closed)
```

`firms` uses `id` in place of `tenant_id`. `duely_app` has no `BYPASSRLS`.

Host resolution is the one pre-tenant lookup, so it is a `SECURITY DEFINER` function returning only `tenant_id` and domain status:

```sql
create function resolve_tenant_by_host(h text) returns table(tenant_id uuid) ...
-- matches firms.platform_slug (subdomain) or firm_domains.hostname where status = 'active'
```

### 2.2 Tables

```sql
-- Tenancy and people
create table firms (
  id uuid primary key default gen_random_uuid(),
  platform_slug text not null unique,            -- acme -> acme.duely.app
  legal_name text not null,
  display_name text not null,
  timezone text not null default 'America/New_York',
  reply_to_email text,
  logo_url text,
  brand_primary text not null default '#1F4FD8',
  brand_accent text,
  default_terms_days int not null default 14,
  invoice_prefix text not null default 'INV-',
  stripe_account_id text unique,
  stripe_charges_enabled boolean not null default false,
  stripe_payouts_enabled boolean not null default false,
  stripe_details_submitted boolean not null default false,
  platform_fee_bps int not null default 100,     -- 1.00%
  ai_monthly_cap_cents int not null default 500,
  auto_send_allowed boolean not null default false,
  auto_classify_actions boolean not null default false,   -- allow AI to auto-create promises/disputes (section 5.3)
  is_demo boolean not null default false,
  clock_offset_seconds bigint not null default 0,
  onboarding_state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (clock_offset_seconds = 0 or is_demo)    -- FR-14.7 enforced in the DB too
);

create table members (                            -- firm staff; auth rows owned by better-auth
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  user_id text not null,                          -- better-auth user id
  email citext not null,
  name text,
  role text not null check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, email)
);

create table firm_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  hostname citext not null unique,                -- global uniqueness (FR-7.1)
  cf_custom_hostname_id text,
  status text not null check (status in ('pending','verifying','active','failed')),
  ssl_status text,
  verification_errors jsonb,
  last_checked_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now()
);

-- Clients
create table clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  name text not null,
  billing_address jsonb,
  timezone text,                                  -- null => firm timezone
  notes text,
  policy_id uuid references collection_policies(id),   -- optional override
  external_ref text,                              -- CSV import idempotency
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_ref)
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  client_id uuid not null references clients(id),
  name text not null,
  email citext not null,
  role text,
  is_primary boolean not null default false,
  receives_invoices boolean not null default true,
  receives_reminders boolean not null default true,
  email_status text not null default 'ok' check (email_status in ('ok','bounced','complained','unsubscribed')),
  created_at timestamptz not null default now(),
  unique (tenant_id, client_id, email)
);
create unique index one_primary_contact on contacts (client_id) where is_primary;

-- Invoices
create table invoice_sequences (
  tenant_id uuid primary key references firms(id),
  next_number bigint not null default 1
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  client_id uuid not null references clients(id),
  number text,                                    -- assigned on send, e.g. INV-0042
  status text not null default 'draft' check (status in
    ('draft','sent','viewed','overdue','promised','disputed','paid','void')),
  currency char(3) not null default 'USD' check (currency = 'USD'),
  issue_date date,
  due_date date,
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  notes text,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  payment_processing boolean not null default false,   -- ACH in flight
  risk_level text check (risk_level in ('low','medium','high')),
  risk_factors jsonb,
  risk_explanation text,
  source text not null default 'manual' check (source in ('manual','ai_extraction','csv_import')),
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number),
  unique (tenant_id, external_ref)
);
create index invoices_tenant_status_due on invoices (tenant_id, status, due_date);
create index invoices_client on invoices (tenant_id, client_id);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  invoice_id uuid not null references invoices(id) on delete cascade,
  position int not null,
  description text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  amount_minor bigint not null check (amount_minor >= 0),   -- computed server-side, rounded half-up
  unique (invoice_id, position)
);

create table documents (                           -- uploaded PDFs/images (extraction source, attachments)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  invoice_id uuid references invoices(id),
  kind text not null check (kind in ('extraction_source','attachment','invoice_pdf')),
  storage_key text not null,
  content_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);

-- Money (immutable ledger)
create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  invoice_id uuid not null references invoices(id),
  stripe_payment_intent_id text not null unique,
  stripe_charge_id text,
  method text not null check (method in ('card','ach')),
  status text not null check (status in ('processing','succeeded','failed')),
  amount_minor bigint not null check (amount_minor > 0),
  application_fee_minor bigint not null default 0,
  failure_reason text,
  succeeded_at timestamptz,
  created_at timestamptz not null default now()
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  payment_id uuid not null references payments(id),
  invoice_id uuid not null references invoices(id),
  stripe_refund_id text unique,
  amount_minor bigint not null check (amount_minor > 0),
  reason text,
  created_at timestamptz not null default now()
);

create table stripe_events (                       -- written by duely_system; has stripe_account_id, not RLS-scoped
  id text primary key,                            -- Stripe event id (dedupe)
  type text not null,
  stripe_account_id text,
  tenant_id uuid references firms(id),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  attempts int not null default 0
);

-- Collections
create table collection_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  name text not null,
  is_default boolean not null default false,
  quiet_start time not null default '08:00',
  quiet_end   time not null default '19:00',     -- allowed window is [quiet_start, quiet_end)
  send_weekends boolean not null default false,
  promise_grace_days int not null default 1,
  created_at timestamptz not null default now()
);
create unique index one_default_policy on collection_policies (tenant_id) where is_default;

create table policy_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  policy_id uuid not null references collection_policies(id) on delete cascade,
  position int not null,
  offset_days int not null,                       -- relative to due_date; negative = before
  template_key text not null,
  tone text not null check (tone in ('friendly','neutral','firm')),
  send_mode text not null default 'draft' check (send_mode in ('draft','auto')),
  escalate_notify_firm boolean not null default false,
  unique (policy_id, position),
  unique (policy_id, offset_days)
);

create table reminder_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  invoice_id uuid not null references invoices(id),
  step_id uuid not null references policy_steps(id),
  status text not null default 'scheduled' check (status in
    ('scheduled','claimed','enqueued','awaiting_approval','sent','failed','dead','cancelled','skipped')),
  planned_for date not null,                      -- due_date + offset (local date)
  next_run_at timestamptz not null,               -- real UTC instant, after quiet-hour adjustment
  attempts int not null default 0,
  last_error text,
  claimed_at timestamptz,
  message_id uuid,                                -- set when a message row exists
  pause_reason text check (pause_reason in ('promise','dispute','already_paid_review')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, step_id)                    -- idempotent planning
);
create index reminder_jobs_due on reminder_jobs (next_run_at) where status = 'scheduled';

-- Messaging
create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  client_id uuid references clients(id),
  invoice_id uuid references invoices(id),
  contact_id uuid references contacts(id),
  direction text not null check (direction in ('out','in')),
  kind text not null check (kind in ('invoice','reminder','receipt','notification','reply')),
  status text not null check (status in
    ('draft','approved','queued','sent','delivered','bounced','complained','received','unmatched','cancelled')),
  subject text,
  body_text text,
  body_html text,
  body_stripped text,                             -- inbound without quoted history
  reply_token text unique,                        -- outbound only
  provider_message_id text unique,
  job_id uuid unique references reminder_jobs(id),     -- one message per job (FR-8.3)
  dedupe_key text unique,                         -- outbox idempotency: 'job:{id}', 'invoice:{id}', 'receipt:{payment_id}', 'notify:{kind}:{entity_id}'
  generated_by text not null default 'template' check (generated_by in ('template','ai','human')),
  approved_by uuid references members(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index messages_invoice on messages (tenant_id, invoice_id, created_at);

create table promises (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  invoice_id uuid not null references invoices(id),
  promised_date date not null,
  source text not null check (source in ('portal','ai_reply','manual')),
  source_message_id uuid references messages(id),
  source_quote text,
  confidence numeric(4,3),
  status text not null default 'active' check (status in ('active','kept','broken','cancelled')),
  prior_status text not null,                     -- invoice status to restore (D2)
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index one_active_promise on promises (invoice_id) where status = 'active';

create table disputes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  invoice_id uuid not null references invoices(id),
  reason text not null,
  detail text,
  source text not null check (source in ('portal','ai_reply','manual','stripe')),
  source_message_id uuid references messages(id),
  stripe_dispute_id text unique,
  status text not null default 'open' check (status in ('open','resolved','upheld')),
  resolution_note text,
  prior_status text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index one_open_dispute on disputes (invoice_id) where status = 'open' and stripe_dispute_id is null;

-- Portal auth
create table portal_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  contact_id uuid not null references contacts(id),
  token_hash text not null unique,                -- sha256; raw token only in the email
  purpose text not null check (purpose in ('login','invoice_link')),
  invoice_id uuid references invoices(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table portal_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  contact_id uuid not null references contacts(id),
  session_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- AI and review
create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  purpose text not null check (purpose in ('extraction','draft','classify','risk_explain')),
  prompt_version text not null,
  model text not null,
  input_hash text not null,
  input_tokens int, output_tokens int,
  cost_micros bigint,                             -- millionths of a dollar
  latency_ms int,
  status text not null check (status in ('ok','schema_invalid','error','capped')),
  output jsonb,                                   -- validated output only
  error text,
  invoice_id uuid references invoices(id),
  message_id uuid references messages(id),
  created_at timestamptz not null default now()
);

create table review_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  kind text not null check (kind in
    ('draft_approval','low_confidence_reply','unmatched_inbound','already_paid_claim','dead_job','extraction_review')),
  invoice_id uuid references invoices(id),
  message_id uuid references messages(id),
  job_id uuid references reminder_jobs(id),
  ai_run_id uuid references ai_runs(id),
  payload jsonb not null default '{}',
  status text not null default 'open' check (status in ('open','approved','edited','rejected','dismissed')),
  resolved_by uuid references members(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index review_open on review_items (tenant_id, status, created_at);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  actor_type text not null check (actor_type in ('member','contact','system','ai','stripe')),
  actor_id text,
  action text not null,                           -- e.g. invoice.sent, promise.created
  entity_type text not null,
  entity_id uuid,
  summary jsonb,                                  -- before/after, no secrets
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_entity on audit_log (tenant_id, entity_type, entity_id, created_at);

create table idempotency_keys (                    -- D29; rows older than 24h are purged by the jobs worker
  tenant_id uuid not null references firms(id),
  key uuid not null,
  procedure text not null,                        -- e.g. 'invoices.send'
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, key, procedure)
);
```

> **Additions vs. the PRD's table list:** `invoice_sequences`, `documents`, `disputes`, `portal_tokens`, `portal_sessions`, `review_items`, `idempotency_keys`. The better-auth tables (`user`, `session`, `account`, `verification`) are generated by better-auth and are outside RLS (D27). All were implied by requirements; update the PRD's entity list when convenient.

### 2.3 Triggers and constraints worth enforcing in the DB

- `audit_log`, `payments`, `refunds`: no `UPDATE` or `DELETE` for `duely_app` except `payments.status` and `failure_reason` transitions from `processing` (revoke other column grants).
- `invoice_items` locked once the parent invoice is not `draft` (trigger raises).
- `invoices.status` transitions validated by a trigger that mirrors the table in section 3.1, as a backstop to the domain layer.

---

## 3. State machines

Implemented as pure functions in `packages/domain`: `transition(state, event, ctx) -> { state, effects[] }`. Effects are data (e.g. `cancel_jobs`, `create_promise`), executed by the caller inside the same DB transaction.

### 3.1 Invoice

| From                                             | Event               | To                                                         | Guard                                                                                   | Effects                                                              |
| ------------------------------------------------ | ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| draft                                            | `SEND`              | sent                                                       | firm `stripe_charges_enabled`, ≥1 item, total > 0, client has invoice-receiving contact | assign number, freeze items, set `sent_at`, plan jobs, email invoice |
| draft                                            | `VOID`              | void                                                       | none                                                                                    | audit                                                                |
| sent                                             | `VIEW`              | viewed                                                     | first portal view                                                                       | set `first_viewed_at`                                                |
| sent, viewed                                     | `DUE_PASSED`        | overdue                                                    | `effective due_date < today (firm tz)` and no active promise/dispute                    | none                                                                 |
| sent, viewed, overdue                            | `PROMISE_CREATED`   | promised                                                   | promise valid                                                                           | store `prior_status`, pause jobs                                     |
| promised                                         | `PROMISE_BROKEN`    | overdue                                                    | promise expired unpaid                                                                  | notify firm, replan jobs                                             |
| promised                                         | `PROMISE_CANCELLED` | `prior_status` (re-evaluated for overdue)                  | none                                                                                    | replan jobs                                                          |
| sent, viewed, overdue, promised                  | `DISPUTE_OPENED`    | disputed                                                   | no open dispute                                                                         | store `prior_status`, pause jobs, notify firm                        |
| disputed                                         | `DISPUTE_RESOLVED`  | `prior_status` re-evaluated: overdue if past due else sent | none                                                                                    | replan jobs                                                          |
| sent, viewed, overdue, promised, disputed        | `PAYMENT_SUCCEEDED` | paid                                                       | `paid_minor >= total_minor`                                                             | cancel jobs, close promise as `kept`, receipt                        |
| sent, viewed, overdue, promised, disputed, draft | `VOID`              | void                                                       | not paid                                                                                | cancel jobs                                                          |
| paid, void                                       | any                 | (rejected)                                                 |                                                                                         |                                                                      |

Notes:

- `PAYMENT_PROCESSING` and `PAYMENT_FAILED` do **not** change `status`; they toggle `payment_processing` and write a `payments` row. This keeps the status enum from the PRD intact.
- "Re-evaluated" means: if `due_date < today` then `overdue` else `sent` (or `viewed` if `first_viewed_at` is set).
- Refunds adjust `refunded_minor` only; the invoice stays `paid` in v1.

### 3.2 Reminder job

```
scheduled -> claimed -> enqueued -> sent
                            |-> awaiting_approval -> (approved) -> enqueued -> sent
                            |-> failed -> scheduled (retry with backoff) | dead
scheduled|claimed|enqueued|awaiting_approval -> cancelled   (paid, void, hard bounce, unsubscribe)
scheduled|claimed|enqueued -> skipped                         (paused by promise/dispute, or step obsolete)
skipped (pause) -> scheduled                                  (replanned on resolution)
```

Outbound email is an **outbox** (D22). A short transaction inserts a `messages` row with `status = 'queued'`; only after COMMIT is `{ message_id }` put on the queue. Reminder jobs add one stage in front of that. Both stages run in `workers/jobs`, and no transaction ever contains a network call, because Hyperdrive holds a connection for the length of a transaction.

```
process_job { job_id }                       -- DB-only transaction
1. BEGIN; withTenant(job.tenant_id)
2. SELECT job FOR UPDATE; if status <> 'enqueued' -> COMMIT, ack, return
3. Re-load invoice, contact, firm. Re-check:
   - invoice.status in (sent, viewed, overdue)  else job -> cancelled (paid/void) or skipped (promise/dispute)
   - contact.email_status = 'ok' and receives_reminders
   - quiet hours (clock.now(firm), client tz); outside -> set next_run_at to next window, status scheduled
4. If step.send_mode = 'draft' and no approved message -> insert draft message + review_item,
   job = awaiting_approval, COMMIT, return
   (the draft carries the same dedupe_key 'job:' || job.id; approving it in the review queue sets the
   message to 'approved', the job to 'enqueued', and enqueues send_message directly, skipping steps 5 to 7)
5. INSERT messages (dedupe_key = 'job:' || job.id, status 'queued', reply_token, ...)
   ON CONFLICT (dedupe_key) DO NOTHING
6. UPDATE job SET message_id; COMMIT
7. After commit: queue.send({ type: 'send_message', message_id })

send_message { message_id }
1. Transaction: SELECT message FOR UPDATE; if status not in (queued, approved) -> ack, return
   Re-check (FR-9.9) for kind = reminder: invoice still unpaid and not paused, contact still ok.
   If not -> message 'cancelled', job 'cancelled' or 'skipped'; COMMIT, return.
   COMMIT. No row lock is held while calling the provider.
2. Call Resend with Idempotency-Key = message.id            -- outside any transaction
3. Transaction: UPDATE message SET status 'sent', provider_message_id, sent_at; job 'sent'; audit_log; COMMIT
4. Crash between 2 and 3: the reaper re-enqueues messages stuck in 'queued' for more than 5 minutes.
   Resend's idempotency key turns the repeat into a no-op.
```

Residual race, stated plainly: a payment that lands in the few milliseconds between the re-check in step 1 and the provider call in step 2 can still produce one reminder. The acceptance test (FR-9.9) asserts that a payment committed one second before the send produces no email, not that the window is zero.

Non-job messages (invoice email, receipt, firm notifications) use the same outbox: the use-case inserts the message with `dedupe_key` such as `invoice:{id}`, `receipt:{payment_id}`, or `notify:{kind}:{entity_id}` in its own transaction, then enqueues `send_message` after commit.

### 3.3 Promise

`active -> kept` (payment) · `active -> broken` (sweep: `now > promised_date + grace`) · `active -> cancelled` (firm dismisses, invoice void). Creating a new promise supersedes any active one (`cancelled` + audit).

### 3.4 Domain

`pending -> verifying -> active`; any state `-> failed` on error; `failed -> verifying` via retry. Only `active` resolves a tenant (D4, FR-7.x).

### 3.5 Review item

`open -> approved | edited | rejected | dismissed`; resolution always writes `audit_log`.

---

## 4. Core algorithms

### 4.1 Policy planner (`packages/domain/planner.ts`)

Pure function: `plan(invoice, policy, firm, client, now) -> JobPlan[]`.

```
for step in policy.steps ordered by offset:
  planned_for = due_date + step.offset_days            // a calendar date in client tz
  if planned_for < today(client tz) and step.offset_days < 0: skip   // don't back-send pre-due notices
  candidate = planned_for at quiet_start in client tz
  next_run_at = nextAllowedInstant(candidate, policy.quiet window, send_weekends, client tz)
  emit { step_id, planned_for, next_run_at }
```

`replan(invoice)` on resolution: cancel nothing already sent; for each step without a sent message, upsert the job (unique on `invoice_id, step_id`) with the recalculated time; if a step's `planned_for` is already past, schedule at the next allowed instant, but never fire more than **one** catch-up reminder (skip the rest).

### 4.2 Scheduler tick (cron, every minute, `duely_system`)

```sql
with due as (
  select j.id from reminder_jobs j
  join firms f on f.id = j.tenant_id
  where j.status = 'scheduled'
    and j.next_run_at <= now() + make_interval(secs => f.clock_offset_seconds)   -- D6
  order by j.next_run_at
  limit 200
  for update of j skip locked
)
update reminder_jobs j set status = 'claimed', claimed_at = now(), attempts = attempts + 1
from due where j.id = due.id
returning j.id, j.tenant_id;
```

Then enqueue `process_job { job_id }` messages and set `status = 'enqueued'` (the sender stages are in section 3.2). A **reaper** step in the same tick resets jobs stuck in `claimed`/`enqueued` for > 5 minutes back to `scheduled` (the send algorithm's unique `job_id` makes this safe).

Also in each tick (same transaction boundaries, separate queries):

1. **Overdue sweep:** invoices in `sent|viewed` with `due_date < firm-local today` → apply `DUE_PASSED`.
2. **Promise sweep:** active promises past `promised_date + grace` → `PROMISE_BROKEN`.
3. **Domain poll:** domains in `pending|verifying` last checked > 60s ago → check Cloudflare, update status.

### 4.3 Stripe webhook processing

```
verify signature (Connect endpoint secret)
INSERT stripe_events ON CONFLICT (id) DO NOTHING; if no insert and processed_at set -> 200
resolve tenant from event.account via firms.stripe_account_id
withTenant(tenant): handler(event)  -- handlers are pure-ish and derive state from event + ledger
UPDATE stripe_events SET processed_at = now()
on exception: store error, attempts++, return 500 (Stripe retries)
```

| Event                           | Handler                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `account.updated`               | Update `stripe_*` flags on firm                                                                         |
| `payment_intent.processing`     | Upsert `payments(status=processing)`, `invoice.payment_processing = true`                               |
| `payment_intent.succeeded`      | Upsert payment `succeeded`, set `paid_minor`, apply `PAYMENT_SUCCEEDED`, clear processing, send receipt |
| `payment_intent.payment_failed` | Payment `failed` with reason, clear processing flag, notify firm                                        |
| `charge.refunded`               | Insert refund rows for new refunded amount (diff against ledger), update `refunded_minor`               |
| `charge.dispute.created`        | Insert dispute (`source=stripe`), apply `DISPUTE_OPENED` if appropriate, notify firm                    |

Order-independence: handlers upsert by Stripe object IDs and compute from totals, so a refund arriving before a success event creates the payment placeholder first and converges.

Side effects (receipt, firm notification) are written as outbox `messages` rows inside the same short transaction and enqueued after commit (D22). The handler never calls Resend itself.

### 4.4 Inbound email pipeline

```
POST /api/inbound/email  (Resend inbound webhook, signature verified)
1. Dedupe by provider message id
2. Match: reply token in To address -> outbound message -> invoice, client, contact
          else: sender email = contact email AND (subject contains invoice number) -> match
          else: status 'unmatched' + review_item(unmatched_inbound)
3. Store messages(direction=in, status=received), strip quoted text -> body_stripped
4. After commit, enqueue `classify_reply { message_id }`
5. `workers/jobs` runs the classifier (see 5.3) outside any DB transaction, then applies the decision table in its own short transaction
```

### 4.5 Clock service

```ts
clock.now(firmId): Date   // real now + firm.clock_offset_seconds
clock.advance(firmId, seconds)  // demo firms only; checked in app AND by DB CHECK
```

Lint rule: ban `new Date()` and `Date.now()` outside `packages/clock`.

### 4.6 Money

`amount_minor = round_half_up(quantity * unit_amount_minor)` per line, computed in `packages/domain/money.ts` with integer arithmetic (quantity scaled to 3 decimals). Invoice total = sum of line amounts. Platform fee = `floor(amount * platform_fee_bps / 10000)`. Currency formatting is display-only.

---

## 5. AI contracts

All calls go through `runAi({ purpose, input, schema, promptVersion })` which: checks the monthly cap → calls Claude → validates against the Zod schema (one automatic retry on schema failure) → writes `ai_runs` → returns validated output or a typed failure. On failure the caller takes the manual path (FR-11.20).

### 5.1 Extraction

```ts
ExtractionOutput = {
  client_name: string | null,
  invoice_number: string | null,
  issue_date: string | null,       // ISO
  due_date: string | null,
  currency: "USD",
  items: { description: string; quantity: number; unit_amount_minor: number }[],
  stated_total_minor: number | null,
  field_confidence: Record<string, number>   // 0..1
}
```

Post-checks: sum of items must equal `stated_total_minor` or `needs_review = true`. Result becomes a `draft` invoice plus an `extraction_review` item if any field < 0.7.

### 5.2 Follow-up draft

Input: tone, step, invoice facts (**amount, due date, number are passed as data and injected into the template slots, not generated**), last 3 messages (stripped). Output: `{ subject: string, body_text: string }` containing placeholders `{{amount}}`, `{{due_date}}`, `{{invoice_number}}`, `{{portal_link}}`. Post-check rejects drafts missing required placeholders or containing disallowed terms (threat/legal word list).

### 5.3 Reply classification

```ts
ClassifyOutput = {
  label: "promise" | "dispute" | "already_paid" | "needs_human" | "other",
  confidence: number, // 0..1
  rationale: string, // <= 200 chars
  promise_date_text: string | null, // raw phrase, e.g. "Friday"
  promise_date_iso: string | null, // resolved by the model, re-verified in code
  source_quote: string | null, // must be a substring of the message
};
```

Code-side checks: `source_quote` must appear in the message; `promise_date_iso` must be re-derived by a deterministic date parser against the message timestamp and client tz — if they disagree, downgrade to review.

Decision table:

| Label               | Confidence ≥ 0.85                                                      | 0.60 to 0.85 | < 0.60        |
| ------------------- | ---------------------------------------------------------------------- | ------------ | ------------- |
| promise             | auto-create promise **if** firm enabled auto-actions, else review item | review item  | `needs_human` |
| dispute             | auto-open dispute (same rule)                                          | review item  | `needs_human` |
| already_paid        | pause + review item (always)                                           | review item  | `needs_human` |
| needs_human / other | review item                                                            | review item  | review item   |

The classifier prompt treats the email as quoted data; the output schema has no free-form action field.

### 5.4 Risk score

`computeRiskFactors(client, invoice)` → `{ late_rate, avg_days_late, broken_promises, invoice_age_days, amount_percentile }`. Rules map to `low|medium|high`. LLM receives only these factors and returns `{ explanation: string }` (≤ 2 sentences).

### 5.5 Eval harness

`seed/eval/replies.jsonl` (≥ 40 labeled). `pnpm eval:classify` prints accuracy, per-class precision/recall, confusion matrix, and the average cost per call. Results are pasted into the README.

---

## 6. API surface

### 6.1 Transport rules (D18, D19)

| Layer                                    | Used for                                                                                                       | Not used for                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **tRPC** (`staffRouter`, `portalRouter`) | Every authenticated read and write made by the UI                                                              | Webhooks, file streams, anything that needs the raw `Request` |
| **Hono**                                 | better-auth, webhooks, inbound email, magic-link consume, uploads, PDF and file downloads, health, unsubscribe | Typed UI calls                                                |
| **Start server functions**               | SSR route guards only: `$getUser`, `$getHostContext`                                                           | Data fetching, mutations                                      |

- Business logic lives in `packages/api/src/usecases`. A tRPC procedure or Hono handler does only: parse input (Zod) → open `withTenant` → call the use-case → map errors.
- Every tRPC input is a Zod schema from a shared module (D15). Dates cross the wire as ISO strings; money as integer minor units (`number`).
- Procedure builders (`packages/api/src/trpc/init.ts`):

| Builder                    | Requires                           | Adds to context                               |
| -------------------------- | ---------------------------------- | --------------------------------------------- |
| `publicProcedure`          | host kind matches the router       | `hostKind`, request id                        |
| `newUserProcedure` (staff) | session, no membership yet         | `user` (used by `firm.create` only)           |
| `staffProcedure`           | host kind `app`, session, member   | `user`, `member`, `tenantId`                  |
| `ownerProcedure`           | `staffProcedure` + `role = owner`  | same                                          |
| `demoProcedure`            | `staffProcedure` + `firm.is_demo`  | same                                          |
| `portalProcedure`          | host kind `portal`, portal session | `contact`, `clientId`, `tenantId` (from host) |

- Portal procedures **never** accept `clientId` or `tenantId` as input. Every portal query is `where client_id = ctx.clientId` in addition to RLS.
- Side-effecting mutations (`invoices.send`, `invoices.createPayment`, `import.*`, `domains.add`, `review.resolve`) take `idempotencyKey: string (uuid)`; results are stored in `idempotency_keys` for 24h (D29).
- Errors: use-cases throw typed domain errors with namespaced codes (`invoice.invalid_transition`). The tRPC error formatter maps them to a `TRPCError` code and exposes the namespaced code as `data.domainCode`.

| Domain situation                      | tRPC code               | HTTP |
| ------------------------------------- | ----------------------- | ---- |
| Validation failure                    | `BAD_REQUEST`           | 400  |
| No or expired session                 | `UNAUTHORIZED`          | 401  |
| Wrong role or wrong host kind         | `FORBIDDEN`             | 403  |
| Not found, **including cross-tenant** | `NOT_FOUND`             | 404  |
| State conflict (stale transition)     | `CONFLICT`              | 409  |
| Domain rule violated                  | `UNPROCESSABLE_CONTENT` | 422  |
| Rate limited                          | `TOO_MANY_REQUESTS`     | 429  |

### 6.2 `staffRouter` (`/api/trpc/staff`)

| Namespace   | Procedures                                                                                                       | Builder                                                | FR               |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------- |
| `firm`      | `create`, `get`, `update`, `onboardingState`, `slugAvailable`                                                    | `newUserProcedure` for `create`, else `staffProcedure` | 2.1, 2.4, 2.6    |
| `stripe`    | `connectLink`, `status`                                                                                          | `ownerProcedure`, `staffProcedure`                     | 2.2, 2.3         |
| `members`   | `list`, `invite`, `setRole`, `remove`                                                                            | `staffProcedure`, owner for writes                     | 1.5, 1.6         |
| `clients`   | `list`, `get`, `create`, `update`, `archive`                                                                     | `staffProcedure`                                       | 3.1, 3.4, 3.5    |
| `contacts`  | `add`, `update`, `remove`, `setPrimary`                                                                          | `staffProcedure`                                       | 3.2, 3.3         |
| `invoices`  | `list`, `get`, `createDraft`, `updateDraft`, `send`, `void`, `timeline`, `extractFromDocument`, `duplicate` (P2) | `staffProcedure`                                       | 4.x, 11.1, 12.4  |
| `policies`  | `list`, `get`, `create`, `update`, `delete`, `steps.upsert`, `steps.remove`, `steps.reorder`, `preview`          | `ownerProcedure` for writes                            | 9.1 to 9.3, 9.11 |
| `promises`  | `create`, `cancel`                                                                                               | `staffProcedure`                                       | 10.1, 10.9       |
| `disputes`  | `open`, `resolve`                                                                                                | `staffProcedure`                                       | 10.7 to 10.9     |
| `review`    | `list`, `resolve` (`approve`, `edit`, `reject`, `dismiss`)                                                       | `staffProcedure`                                       | 12.1, 12.2       |
| `dashboard` | `summary`                                                                                                        | `staffProcedure`                                       | 12.3             |
| `domains`   | `list`, `add`, `remove`, `check`                                                                                 | `ownerProcedure`                                       | 7.x              |
| `import`    | `clients`, `invoices` (each with `dryRun`)                                                                       | `staffProcedure`                                       | 13.x             |
| `ai`        | `usage`                                                                                                          | `staffProcedure`                                       | 11.19            |
| `demo`      | `advance`, `simulateReply`, `reset`                                                                              | `demoProcedure`                                        | 14.2, 14.4, 14.5 |

### 6.3 `portalRouter` (`/api/trpc/portal`)

| Namespace  | Procedures                                                                                                                  | Builder                              | FR                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------- |
| `auth`     | `requestLink` (always succeeds, sends a link only if the contact exists; rate limited per IP and per email), `me`, `logout` | `publicProcedure`, `portalProcedure` | 6.1                  |
| `invoices` | `list`, `get` (records first view), `createPayment` (PaymentIntent on the connected account, returns client secret)         | `portalProcedure`                    | 6.2 to 6.4, 5.1, 5.2 |
| `promises` | `create`                                                                                                                    | `portalProcedure`                    | 6.5                  |
| `disputes` | `open`                                                                                                                      | `portalProcedure`                    | 6.6                  |
| `receipts` | `list`                                                                                                                      | `portalProcedure`                    | 6.7                  |

### 6.4 Hono routes (`packages/api/src/hono`)

Middleware order: request id → logger (evlog event per request) → host-kind guard → secure headers → route-level rate limits → route → error handler.

| Method   | Path                       | Host kind     | Auth                       | Purpose                                                                               | FR             |
| -------- | -------------------------- | ------------- | -------------------------- | ------------------------------------------------------------------------------------- | -------------- |
| ALL      | `/api/auth/*`              | app           | better-auth                | Sign-in, sign-up, session                                                             | 1.1            |
| GET      | `/api/portal/auth/:token`  | portal        | token                      | Consume magic link, set portal session cookie, redirect to the invoice or list        | 6.1, 6.8       |
| POST     | `/api/webhooks/stripe`     | app           | signature                  | Connect events (section 4.3)                                                          | 5.3 to 5.5     |
| POST     | `/api/webhooks/resend`     | app           | signature                  | Delivery events                                                                       | 8.4            |
| POST     | `/api/webhooks/cloudflare` | app           | signature                  | Custom hostname status, if available                                                  | 7.4            |
| POST     | `/api/inbound/email`       | app           | signature                  | Inbound replies (section 4.4)                                                         | 8.5            |
| POST     | `/api/files/upload`        | app           | staff session              | Streaming upload to R2 (logo, extraction source, attachment); validates type and size | 2.4, 4.9, 11.1 |
| GET      | `/api/files/:id`           | app or portal | session for that host kind | Signed or proxied download                                                            | 4.9            |
| GET      | `/api/invoices/:id/pdf`    | app or portal | session for that host kind | Invoice PDF                                                                           | 4.7, 6.3       |
| GET/POST | `/api/unsubscribe/:token`  | any           | token                      | One-click "stop reminders"                                                            | 8.7            |
| GET      | `/api/health`              | any           | none                       | Build id and DB check                                                                 | n/a            |

---

## 7. Security checklist

- [ ] `duely_app` role has no `BYPASSRLS`; `FORCE ROW LEVEL SECURITY` on all tenant tables
- [ ] `withTenant` is the only DB entry point in request paths (lint rule bans direct pool use)
- [ ] No network call (Stripe, Resend, Claude, R2) inside a DB transaction
- [ ] Staff session cookie is host-only on the app host; portal session cookie is host-only on the tenant host; neither sets a `Domain` attribute
- [ ] `staffRouter` rejects portal hosts and `portalRouter` rejects the app host (tested)
- [ ] Reserved platform slugs enforced at firm creation
- [ ] Both Hyperdrive configs have query caching disabled
- [ ] Magic tokens: 32 random bytes, stored as sha256, 15-min expiry for login, 7-day for invoice links bound to one invoice, single-use for login
- [ ] Portal session cookie: `HttpOnly; Secure; SameSite=Lax`, scoped to host; rotated on login
- [ ] Rate limits: login requests per IP and per email; inbound webhook size cap
- [ ] File uploads: type and size allowlist, random storage keys, no user-controlled paths
- [ ] Webhook signatures verified before any parsing; raw body preserved for verification
- [ ] Email HTML sanitized; firm-supplied text escaped in templates
- [ ] No card or bank data stored; Stripe Elements only
- [ ] Secrets in Workers secrets, not env vars in the repo; `.env.example` only
- [ ] Logs redact tokens, emails in error paths, and full prompt bodies

---

## 8. Test plan

| Suite                   | What it proves                                                                                                        | Type                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `tenant-isolation`      | Cross-tenant reads/writes blocked at DB and API; unset context returns nothing                                        | Integration (real Postgres)       |
| `state-machines`        | Every row in 3.1 and illegal transitions rejected (table-driven)                                                      | Unit                              |
| `webhook-replay`        | Same event 3x → one ledger effect; out-of-order convergence                                                           | Integration                       |
| `scheduler-concurrency` | Two schedulers, one job, one send                                                                                     | Integration                       |
| `send-recheck`          | Pay 1s before send → no email                                                                                         | Integration                       |
| `planner`               | Quiet hours, weekends, timezones, DST, catch-up cap                                                                   | Unit (property tests for time)    |
| `money`                 | Rounding, fee calculation, totals match across UI/PDF/ledger                                                          | Unit                              |
| `portal-authz`          | Contact A cannot see client B; token single-use and expiry                                                            | Integration                       |
| `host-kind`             | `resolveHostKind` table; wrong-kind requests get 404; staff cookie never accepted on a tenant host                    | Unit + integration                |
| `trpc-authz`            | Each procedure builder rejects missing session, wrong role, wrong host kind; portal inputs cannot override `clientId` | Integration                       |
| `outbox`                | Crash between provider call and mark-sent yields exactly one email; duplicate `send_message` is a no-op               | Integration                       |
| `ai-contracts`          | Schema failure → no state change; injection string ignored; quote substring rule                                      | Unit with recorded fixtures       |
| `eval:classify`         | Accuracy on labeled set                                                                                               | Script (not in CI gate, reported) |
| `e2e-happy-path`        | Sign-up → connect (test) → invoice → pay → paid                                                                       | Playwright                        |
| `e2e-demo-loop`         | Scripted demo under 90s                                                                                               | Playwright                        |

CI gates: `vp check` (format, lint, types), unit, integration (Postgres service container), and the core suites (tenant-isolation, host-kind, webhook-replay, scheduler-concurrency, state-machines, money).

---

## 9. Environments and config

| Env       | Purpose           | Notes                                                                                                                                                                                                                                    |
| --------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local     | Dev               | Docker Postgres; the Worker runs in workerd via the Cloudflare Vite plugin; Hyperdrive bindings use `localConnectionString` pointing at the Docker DB; `*.localhost` hosts; Stripe CLI forwards webhooks; mail goes to the in-app outbox |
| preview   | Per-PR (optional) | Separate Worker name and DB branch if the Postgres host supports it; Stripe test mode                                                                                                                                                    |
| prod-demo | Public demo       | `is_demo` firm seeded; real Stripe **test** mode; outbound email disabled for demo tenants                                                                                                                                               |

### 9.1 Workers and bindings

| Worker         | Entry                                                                                             | Bindings and triggers                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`     | `@tanstack/react-start/server-entry` (TanStack's documented Workers setup), flags `nodejs_compat` | `HYPERDRIVE_APP`, `QUEUE_MAIN` (producer), `FILES` (R2), static assets; routes `app.<domain>/*`, `*.<domain>/*`, and the custom-hostname fallback origin |
| `workers/jobs` | `src/index.ts` exporting `scheduled` and `queue`                                                  | `HYPERDRIVE_SYSTEM`, `QUEUE_MAIN` (consumer), `FILES` (R2); cron `* * * * *`                                                                             |

Hyperdrive rules (D4, D22, D28):

- Two Hyperdrive configs, one per DB role, **query caching disabled** on both. Hyperdrive caches read queries by default, which would serve stale statuses and balances.
- Per Cloudflare's docs, a connection is held for the duration of a transaction and `SET` values last only for that transaction, which is exactly what `set_config(..., true)` needs. Keep transactions short and free of network calls.
- Build the Drizzle client per request from `env.HYPERDRIVE_APP.connectionString`; never at module scope.
- Migrations and `drizzle-kit` use a direct `DATABASE_URL` (a third, migration-owner role), not Hyperdrive.

### 9.2 Config

| Kind       | Names                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bindings   | `HYPERDRIVE_APP`, `HYPERDRIVE_SYSTEM`, `QUEUE_MAIN`, `FILES`                                                                                                                        |
| Secrets    | `BETTER_AUTH_SECRET`, `PORTAL_SESSION_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `CF_API_TOKEN` |
| Vars       | `PLATFORM_DOMAIN`, `APP_HOST`, `INBOUND_DOMAIN`, `CF_ZONE_ID`, `PLATFORM_FEE_BPS_DEFAULT`                                                                                           |
| Local only | `DATABASE_URL` (migrations, drizzle-kit, tests)                                                                                                                                     |

Typed access: Cove's Varlock schema stays the source of truth for names and validation in local dev and CI; how the runtime reads Worker bindings is decided in P0-05 (D23). Fallback is a small Zod-validated env module over the Worker `env`.

### 9.3 CI and deploy

GitHub Actions: `vp check` (format, lint, types), `vp test` (unit), integration suites against a Postgres service container, Playwright e2e. Deploy to `prod-demo` from `main` with `wrangler deploy` for both Workers. Migrations run as a separate gated step before deploy.

> To verify before building Phase 3: current Cloudflare for SaaS plan limits and pricing, and whether custom-hostname status webhooks are available on your plan. Polling is the fallback already specced.

---

## 10. Build checklist (issue by issue)

Format: `[ ] ID · title · FRs · size (S ≤ half day, M ≤ 1 day, L ≤ 2 days)`

### Phase 0: Spikes (go/no-go before building; budget 2 days total)

Each spike ends with a written result in `docs/adr/`. A failed spike means the alternative is recorded in the decisions log before Phase 1 starts.

- [ ] P0-01 · Create the repo from the `cove-monorepo` template, install, boot `vp dev`, delete `_DELETE_ME_*`, commit `.cove.jsonc` · S
- [ ] P0-02 · **Cloudflare spike:** remove Nitro; add `@cloudflare/vite-plugin` and `wrangler.jsonc` (`nodejs_compat`, `main: @tanstack/react-start/server-entry`); confirm `vp dev` and `wrangler deploy` work with Cove's aliased `vite`. Fallback: plain Vite · M
- [ ] P0-03 · **Hyperdrive spike:** two configs with caching disabled; postgres.js + Drizzle; `set_config('app.tenant_id', $1, true)` inside a transaction; prove two concurrent requests for different tenants never see each other's rows and that nothing leaks to the next request · M
- [ ] P0-04 · **Hono + tRPC spike:** `/api/$` Start route → Hono → `@hono/trpc-server` → `staffRouter`; in-process SSR caller plus browser `httpBatchLink` with TanStack Query; one query end to end; confirm how `env` and `ctx` reach Hono · M
- [ ] P0-05 · **Env spike:** Varlock vs Worker `env` (D23); decide and record · S
- [ ] P0-06 · **Host-kind spike:** `*.localhost` multi-host dev; Start middleware attaches host kind; a guarded route returns 404 on the wrong kind · S

### Phase 1: Foundation

- [ ] P1-01 · Add `workers/jobs` and `packages/{api,domain,clock,ai,email,stripe,cloudflare}` skeletons; import-boundary lint rules; CI skeleton (`vp check`, tests, Postgres service) · M
- [ ] P1-02 · `packages/clock` + lint ban on raw `Date.now()` / `new Date()` · S · 14.2
- [ ] P1-03 · `packages/db`: remove the Start coupling, `createDb()` factory, roles (`duely_app`, `duely_system`, migration owner), `withTenant`, migration tooling (drizzle-kit plus custom SQL for RLS) · M · 1.4
- [ ] P1-04 · Migration 001: `firms`, `members`, `audit_log`, `firm_domains`, `idempotency_keys`; RLS template; better-auth tables stay outside RLS · M · 1.2
- [ ] P1-05 · `resolveHostKind`, `resolve_tenant_by_host` SQL function, Start request middleware, Hono host-kind guard, reserved slugs, 404 on unknown host · M · 1.3
- [ ] P1-06 · **Tenant-isolation + host-kind test suites** (gate in CI) · M · 1.4
- [ ] P1-07 · `packages/auth` `createAuth()` factory mounted in Hono; Cove's `_guest` and `_staff` routes on the app host; signup creates a firm and its owner member · L · 1.1, 1.5
- [ ] P1-08 · tRPC init: contexts, procedure builders, error mapping, idempotency middleware, Query integration, `firm.get` end to end · M
- [ ] P1-09 · Audit helper `audit(actor, action, entity)` used by all mutations · S · 15.1
- [ ] P1-10 · Member invites · S · 1.6

### Phase 2: Money path

- [ ] P2-01 · Migration 002: clients, contacts, invoices, items, sequences, payments, refunds, stripe_events, documents · M
- [ ] P2-02 · `packages/domain`: money + invoice state machine + table-driven tests · M · 4.2, 4.5
- [ ] P2-03 · Clients and contacts CRUD + UI · M · 3.x
- [ ] P2-04 · Invoice draft CRUD + line items + totals · L · 4.1, 4.2
- [ ] P2-05 · Branding settings (logo upload via the Hono upload route to R2, colors) · M · 2.4
- [ ] P2-06 · Stripe Connect Express onboarding + `account.updated` · M · 2.2, 2.3
- [ ] P2-07 · Send invoice (numbering, freeze, outbox message, `send_message` consumer, portal link) · L · 4.3, 4.4, 8.1
- [ ] P2-08 · Portal auth: magic link + sessions + rate limit · L · 6.1
- [ ] P2-09 · Portal: invoice list and detail, first-view tracking · M · 6.2, 6.3
- [ ] P2-10 · Pay flow: PaymentIntent on connected account with application fee · L · 5.1, 5.2
- [ ] P2-11 · Stripe webhook route in Hono + dedupe + handlers (succeeded, failed, processing) with outbox receipts · L · 5.3 to 5.5, 5.7
- [ ] P2-12 · Refund and dispute handlers · M · 5.8, 5.9
- [ ] P2-13 · **Webhook-replay + out-of-order tests** (gate) · M · 5.5
- [ ] P2-14 · Receipts email + portal receipts · S · 6.7
- [ ] P2-15 · Invoice PDF · M · 4.7
- [ ] P2-16 · Portal promise and dispute actions (manual path, without AI) · M · 6.5, 6.6, 10.x
- [ ] P2-17 · E2E: sign-up → connect → invoice → pay → paid · M

### Phase 3: Custom domains

- [ ] P3-01 · Cloudflare API client (create/get/delete custom hostname) · M · 7.2
- [ ] P3-02 · Add-domain flow + CNAME instructions UI · M · 7.1, 7.2
- [ ] P3-03 · Status tracking, poller, manual re-check, status badge · M · 7.3, 7.4
- [ ] P3-04 · Host resolution honors `active` only; link generation prefers active domain · S · 7.5, 7.6
- [ ] P3-05 · Remove/replace domain · S · 7.7
- [ ] P3-06 · Troubleshooting hints (P2) · S · 7.8

### Phase 4: Collections engine

- [ ] P4-01 · Migration 003: policies, steps, reminder_jobs, messages, promises, disputes, review_items · M
- [ ] P4-02 · `packages/domain` planner + quiet hours/timezone/DST property tests · L · 9.8
- [ ] P4-03 · Policy and steps CRUD + default policy on firm creation · M · 9.1 to 9.3
- [ ] P4-04 · Plan jobs on send; cancel on pay/void · M · 9.4, 9.6
- [ ] P4-05 · `workers/jobs` `scheduled()` tick: claim, enqueue, reaper (jobs and queued messages), sweeps · L · 9.5
- [ ] P4-06 · `process_job` and `send_message` consumers per section 3.2 (outbox) · L · 9.9, 8.3
- [ ] P4-07 · **Scheduler-concurrency + send-recheck tests** (gate) · M
- [ ] P4-08 · Promise and dispute pause/resume + replan · L · 9.7, 10.x
- [ ] P4-09 · Draft approval flow + review queue UI (v1 without AI) · M · 9.12, 12.1, 12.2
- [ ] P4-10 · Resend delivery webhooks, bounce handling, unsubscribe · M · 8.4, 8.7
- [ ] P4-11 · Inbound email pipeline: token matching, stripping, unmatched → queue · L · 8.5, 8.6, 8.8
- [ ] P4-12 · Policy preview endpoint and UI · S · 9.11

### Phase 5: AI layer

- [ ] P5-01 · `runAi` wrapper: cap check, schema validation, retry, `ai_runs` logging · L · 11.18 to 11.21
- [ ] P5-02 · Extraction pipeline + review UI · L · 11.1 to 11.4
- [ ] P5-03 · Follow-up draft generator with placeholder/guardrail checks · M · 11.5 to 11.7
- [ ] P5-04 · Reply classifier + decision table + promise/dispute creation · L · 11.9 to 11.13
- [ ] P5-05 · Deterministic date parser cross-check for promises · M · 11.10
- [ ] P5-06 · Eval set (≥ 40) + `eval:classify` script · M · 11.14
- [ ] P5-07 · Injection tests and schema-failure fallback tests · S · 11.13, 11.20
- [ ] P5-08 · Risk factors + LLM explanation + UI badge · M · 11.15 to 11.17
- [ ] P5-09 · AI usage page and cap enforcement · S · 11.19

### Phase 6: Demo polish

- [ ] P6-01 · Dashboard: totals, AR aging, promises this week · M · 12.3
- [ ] P6-02 · Invoice timeline component · M · 12.4
- [ ] P6-03 · CSV import (clients, invoices) with dry-run · L · 13.x
- [ ] P6-04 · Seed script: demo firm, data across all statuses · M · 14.1
- [ ] P6-05 · Demo mode: outbox viewer, email interception, Stripe test mode · M · 14.3
- [ ] P6-06 · Simulate time + simulate reply endpoints/UI + server guards · M · 14.2, 14.4, 14.7
- [ ] P6-07 · Reset demo · S · 14.5
- [ ] P6-08 · E2E demo loop under 90s · M
- [ ] P6-09 · README: architecture diagram, decisions table, trade-offs, eval results, credit to Cove Stack · M
- [ ] P6-10 · GIF + Loom (< 90s) · S
- [ ] P6-11 · Accessibility pass on portal (WCAG AA basics) · S
- [ ] P6-12 · Guided tour overlay (P2) · S · 14.6

### Cut line if time runs short (in order)

P6-12 → P3-06 → P5-08 → P6-03 → P2-15 → P6-11. Never cut: the Phase 0 spikes, tenant-isolation and host-kind, webhook-replay, scheduler-concurrency and outbox tests, or the promise loop (P4-08, P5-04).

---

## 11. Open items

Settled in Rev 2: file storage is R2 (`FILES` binding); Postgres access is through Hyperdrive with caching disabled; `SET`-style tenant context is supported inside a transaction per Cloudflare's docs (still proven in P0-03).

1. **Spikes P0-02 to P0-06** (section 10) decide: Cloudflare Vite plugin with Cove's aliased Vite, per-request DB clients, in-process tRPC on the server, env access, and host-kind middleware.
2. **Postgres host:** pick one that works with Hyperdrive and supports the two roles plus `BYPASSRLS` for `duely_system` (managed providers differ on role privileges).
3. **Inbound email:** confirm Resend inbound supports the tokenized reply address (`reply+{token}@…`). Fallback: Cloudflare Email Routing with an `email()` handler in `workers/jobs`.
4. **Migration ordering:** `clients.policy_id` references `collection_policies`, which is defined later in section 2.2. Create `collection_policies` before `clients` in the real migrations, or add the foreign key afterwards.
5. **Logging without Nitro:** evlog is wired through Nitro in Cove. Replace it with Hono and Start middleware that emit one event per request, and confirm evlog works on Workers; fallback is a small structured logger in `packages/logger`.
6. **Pre-1.0 dependencies:** Drizzle 1.0 RC (relations v2), TypeScript 7, and the Vite+ toolchain are pinned by Cove. Pin them and take upgrades only between phases, using the `sync-template` skill.
7. **Auto-classification default:** promise and dispute auto-creation is off unless the firm enables `auto_classify_actions`.
8. **Two apps instead of one:** splitting `apps/web` into a staff app and a portal app would give a harder deployment boundary. Rejected for v1 because host-kind gating plus separate routers covers the risk at lower cost; revisit if the portal needs independent scaling.
