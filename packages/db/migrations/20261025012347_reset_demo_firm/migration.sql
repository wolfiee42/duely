-- Demo firms can be reset to a clean slate (FR-14.5). Sent invoices, the ledger and the audit log are otherwise
-- permanent, so this is a SECURITY DEFINER function owned by the table owner, and it refuses any firm that is
-- not a demo. It works inside one tenant: the RLS policies still apply to the owner, and the tenant is set here.

-- The delete guards step aside only for this function: the owner role is never a runtime role, so a
-- request can neither be that role nor reach this setting's effect.
create or replace function invoice_items_lock() returns trigger language plpgsql as $$
declare
  parent uuid := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
begin
  if current_user = 'duely_owner' and current_setting('app.demo_reset', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if exists (select 1 from invoices where id = parent and status <> 'draft') then
    raise exception 'invoice items are frozen once the invoice is sent' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
--> statement-breakpoint
create or replace function invoices_no_delete_sent() returns trigger language plpgsql as $$
begin
  if current_user = 'duely_owner' and current_setting('app.demo_reset', true) = 'on' then
    return old;
  end if;
  if old.status <> 'draft' then
    raise exception 'only draft invoices can be deleted' using errcode = 'check_violation';
  end if;
  return old;
end $$;
--> statement-breakpoint

create function reset_demo_firm(p_tenant uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  -- The caller must already be working inside this tenant, so one firm can never reset another.
  if coalesce(current_setting('app.tenant_id', true), '') <> p_tenant::text then
    raise exception 'reset must run inside the firm being reset' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from firms where id = p_tenant and is_demo) then
    raise exception 'only a demo firm can be reset' using errcode = 'check_violation';
  end if;
  perform set_config('app.demo_reset', 'on', true);

  -- Children first. The firm, its members, policies and domains stay.
  delete from review_items where tenant_id = p_tenant;
  delete from ai_runs where tenant_id = p_tenant;
  delete from promises where tenant_id = p_tenant;
  delete from disputes where tenant_id = p_tenant;
  delete from messages where tenant_id = p_tenant;
  delete from reminder_jobs where tenant_id = p_tenant;
  delete from refunds where tenant_id = p_tenant;
  delete from payments where tenant_id = p_tenant;
  delete from portal_tokens where tenant_id = p_tenant;
  delete from portal_sessions where tenant_id = p_tenant;
  delete from documents where tenant_id = p_tenant;
  delete from invoice_items where tenant_id = p_tenant;
  delete from invoices where tenant_id = p_tenant;
  delete from contacts where tenant_id = p_tenant;
  delete from clients where tenant_id = p_tenant;
  delete from invoice_sequences where tenant_id = p_tenant;
  delete from idempotency_keys where tenant_id = p_tenant;
  delete from audit_log where tenant_id = p_tenant;
  update firms set clock_offset_seconds = 0 where id = p_tenant;
end $$;
--> statement-breakpoint
revoke all on function reset_demo_firm(uuid) from public;
grant execute on function reset_demo_firm(uuid) to duely_app, duely_system;
