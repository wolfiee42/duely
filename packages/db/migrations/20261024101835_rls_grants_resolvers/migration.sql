-- Row level security (SPEC 2.1). Unset or empty `app.tenant_id` yields NULL, so no row matches:
-- the system fails closed. FORCE applies the policy to the table owner too.
alter table firms enable row level security;
alter table firms force row level security;
create policy tenant_isolation on firms
  using      (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table members enable row level security;
alter table members force row level security;
create policy tenant_isolation on members
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table firm_domains enable row level security;
alter table firm_domains force row level security;
create policy tenant_isolation on firm_domains
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation on audit_log
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table idempotency_keys enable row level security;
alter table idempotency_keys force row level security;
create policy tenant_isolation on idempotency_keys
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Grants. Nothing is granted by default. `audit_log` is append-only for both runtime roles (SPEC 2.3).
-- The better-auth tables (user, session, account, verification) are outside RLS (D27).
grant select, insert, update on firms to duely_app, duely_system;
grant select, insert, update, delete on members, firm_domains to duely_app, duely_system;
grant select, insert on audit_log to duely_app, duely_system;
-- Both roles may delete a key: a failed attempt releases it so the client can retry.
grant select, insert, update, delete on idempotency_keys to duely_app, duely_system;
grant select, insert, update, delete on "user", session, account, verification to duely_app, duely_system;
--> statement-breakpoint

-- Pre-tenant lookups. RLS hides every row until a tenant is known, so these SECURITY DEFINER
-- functions (owned by the BYPASSRLS role) return only the minimum the caller needs.

-- Platform subdomain or `active` custom domain -> tenant (D20).
create function resolve_tenant_by_host(h text, platform_root text)
returns table (tenant_id uuid, source text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select f.id, 'platform'::text
    from firms f
   where h like '%.' || platform_root
     and f.platform_slug = substr(h, 1, length(h) - length(platform_root) - 1)
  union all
  select d.tenant_id, 'custom'::text
    from firm_domains d
   where d.hostname = h::citext and d.status = 'active'
$$;
--> statement-breakpoint

-- Staff tenant comes from the members row (D20).
create function resolve_membership(p_user_id text)
returns table (tenant_id uuid, member_id uuid, role text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.tenant_id, m.id, m.role from members m where m.user_id = p_user_id
$$;
--> statement-breakpoint

create function firm_slug_exists(p_slug text)
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (select 1 from firms where platform_slug = p_slug)
$$;
--> statement-breakpoint

-- ALTER ... OWNER needs the new owner to hold CREATE on the schema. Grant it for these statements only,
-- so the BYPASSRLS role never keeps schema-create rights.
grant create on schema public to duely_system;
alter function resolve_tenant_by_host(text, text) owner to duely_system;
alter function resolve_membership(text) owner to duely_system;
alter function firm_slug_exists(text) owner to duely_system;
revoke create on schema public from duely_system;
revoke all on function resolve_tenant_by_host(text, text), resolve_membership(text), firm_slug_exists(text) from public;
grant execute on function resolve_tenant_by_host(text, text), resolve_membership(text), firm_slug_exists(text)
  to duely_app, duely_system;
