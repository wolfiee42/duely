alter table collection_policies enable row level security;
alter table collection_policies force row level security;
create policy tenant_isolation on collection_policies
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table policy_steps enable row level security;
alter table policy_steps force row level security;
create policy tenant_isolation on policy_steps
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table reminder_jobs enable row level security;
alter table reminder_jobs force row level security;
create policy tenant_isolation on reminder_jobs
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table review_items enable row level security;
alter table review_items force row level security;
create policy tenant_isolation on review_items
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

grant select, insert, update, delete on collection_policies, policy_steps to duely_app, duely_system;
-- Jobs and review items are history: cancelled or resolved, never deleted.
grant select, insert, update on reminder_jobs, review_items to duely_app, duely_system;
--> statement-breakpoint

-- A reminder that was sent or cancelled never comes back (FR-8.3, FR-9.6). Replanning only moves
-- jobs that are still waiting, so a stale worker cannot resurrect one.
create function reminder_jobs_guard() returns trigger language plpgsql as $$
begin
  if old.status in ('sent', 'cancelled', 'dead') and new.status is distinct from old.status then
    raise exception 'reminder job % is % and cannot change', old.id, old.status using errcode = 'check_violation';
  end if;
  new.updated_at = now();
  return new;
end $$;
--> statement-breakpoint
create trigger reminder_jobs_guard before update on reminder_jobs
  for each row execute function reminder_jobs_guard();
--> statement-breakpoint

