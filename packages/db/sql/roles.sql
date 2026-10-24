-- Cluster-level roles (SPEC D4). Idempotent; run once per cluster by an admin, before migrations.
-- Requires PostgreSQL 16+ (GRANT ... WITH INHERIT/SET).
--   duely_owner  owns the schema and runs migrations. Subject to FORCE ROW LEVEL SECURITY.
--   duely_app    every request path. RLS enforced, no BYPASSRLS.
--   duely_system jobs worker and webhook ingress only. BYPASSRLS; drops into tenant context per unit of work.
do $$
begin
  if not exists (select from pg_roles where rolname = 'duely_owner') then
    create role duely_owner login nosuperuser nobypassrls nocreaterole nocreatedb;
  end if;
  if not exists (select from pg_roles where rolname = 'duely_app') then
    create role duely_app login nosuperuser nobypassrls nocreaterole nocreatedb;
  end if;
  if not exists (select from pg_roles where rolname = 'duely_system') then
    create role duely_system login nosuperuser bypassrls nocreaterole nocreatedb;
  end if;
end
$$;

-- D4: the system role assumes the app role (`set local role duely_app`) to work inside one tenant.
grant duely_app to duely_system;
-- Lets the migration owner hand the pre-tenant SECURITY DEFINER functions to duely_system.
-- `inherit false` means it never picks up BYPASSRLS implicitly.
grant duely_system to duely_owner with inherit false, set true;
