alter table messages enable row level security;
alter table messages force row level security;
create policy tenant_isolation on messages
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table portal_tokens enable row level security;
alter table portal_tokens force row level security;
create policy tenant_isolation on portal_tokens
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table portal_sessions enable row level security;
alter table portal_sessions force row level security;
create policy tenant_isolation on portal_sessions
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table promises enable row level security;
alter table promises force row level security;
create policy tenant_isolation on promises
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

alter table disputes enable row level security;
alter table disputes force row level security;
create policy tenant_isolation on disputes
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Messages are never deleted; tokens and sessions are used up and expire.
grant select, insert, update on messages, portal_tokens, promises, disputes to duely_app, duely_system;
grant select, insert, update, delete on portal_sessions to duely_app, duely_system;
-- Hashed keys only; no tenant data, so no RLS.
grant select, insert, delete on rate_limit_events to duely_app, duely_system;
