-- RLS: same template as every tenant table (SPEC 2.1).
alter table clients enable row level security;
alter table clients force row level security;
create policy tenant_isolation on clients
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table contacts enable row level security;
alter table contacts force row level security;
create policy tenant_isolation on contacts
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table invoice_sequences enable row level security;
alter table invoice_sequences force row level security;
create policy tenant_isolation on invoice_sequences
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table invoices enable row level security;
alter table invoices force row level security;
create policy tenant_isolation on invoices
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table invoice_items enable row level security;
alter table invoice_items force row level security;
create policy tenant_isolation on invoice_items
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table documents enable row level security;
alter table documents force row level security;
create policy tenant_isolation on documents
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table payments enable row level security;
alter table payments force row level security;
create policy tenant_isolation on payments
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
alter table refunds enable row level security;
alter table refunds force row level security;
create policy tenant_isolation on refunds
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- stripe_events has no tenant at arrival (only a Stripe account id), so it is not RLS-scoped.
-- Instead it is reachable by duely_system alone; duely_app gets no grant at all.

-- Grants. The ledger (payments, refunds) is insert-only apart from moving a `processing` payment on.
grant select, insert, update, delete on clients, contacts, invoices, invoice_items, documents to duely_app, duely_system;
grant select, insert, update on invoice_sequences to duely_app, duely_system;
grant select, insert on payments, refunds to duely_app, duely_system;
grant update (status, failure_reason, stripe_charge_id, succeeded_at) on payments to duely_app, duely_system;
grant select, insert, update, delete on stripe_events to duely_system;
--> statement-breakpoint

-- 2.3: a payment may only move forward, and `succeeded` is final. A `failed` payment can still succeed:
-- Stripe lets the payer retry the same PaymentIntent after a decline. Everything else on the ledger is final.
create function payments_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'succeeded' then
    raise exception 'payments are immutable once % (id %)', old.status, old.id using errcode = 'check_violation';
  end if;
  if new.status not in ('processing', 'succeeded', 'failed') then
    raise exception 'invalid payment status %', new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger payments_guard before update on payments for each row execute function payments_guard();
--> statement-breakpoint

-- 2.3: invoice items are locked once the invoice is no longer a draft. A missing parent is allowed
-- so a draft's items can cascade away when the draft itself is deleted.
create function invoice_items_lock() returns trigger language plpgsql as $$
declare
  parent uuid := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
begin
  if exists (select 1 from invoices where id = parent and status <> 'draft') then
    raise exception 'invoice items are frozen once the invoice is sent' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
--> statement-breakpoint
create trigger invoice_items_lock before insert or update or delete on invoice_items
  for each row execute function invoice_items_lock();
--> statement-breakpoint

-- 2.3: backstop for the domain state machine (SPEC 3.1). Only the status graph is checked here;
-- the guards live in packages/domain.
create function invoices_status_guard() returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'draft'    and new.status in ('sent', 'void')) or
    (old.status = 'sent'     and new.status in ('viewed', 'overdue', 'promised', 'disputed', 'paid', 'void')) or
    (old.status = 'viewed'   and new.status in ('overdue', 'promised', 'disputed', 'paid', 'void')) or
    (old.status = 'overdue'  and new.status in ('promised', 'disputed', 'paid', 'void')) or
    (old.status = 'promised' and new.status in ('sent', 'viewed', 'overdue', 'disputed', 'paid', 'void')) or
    (old.status = 'disputed' and new.status in ('sent', 'viewed', 'overdue', 'paid', 'void'))
  ) then
    raise exception 'invalid invoice transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger invoices_status_guard before update of status on invoices
  for each row execute function invoices_status_guard();
--> statement-breakpoint

-- Sent invoices are never deleted (D11); only drafts can go.
create function invoices_no_delete_sent() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'only draft invoices can be deleted' using errcode = 'check_violation';
  end if;
  return old;
end $$;
--> statement-breakpoint
create trigger invoices_no_delete_sent before delete on invoices
  for each row execute function invoices_no_delete_sent();
