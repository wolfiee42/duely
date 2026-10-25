alter table ai_runs enable row level security;
alter table ai_runs force row level security;
create policy tenant_isolation on ai_runs
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- A call log: written once, read for usage and the cap, never edited or removed.
grant select, insert on ai_runs to duely_app, duely_system;
