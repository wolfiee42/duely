-- Run as a superuser against an empty database. Mirrors SPEC section 2.1 and D4.
create role duely_app login nosuperuser nobypassrls;
create role duely_system login nosuperuser bypassrls;
-- D4: the system role "drops into" tenant context by assuming the app role per unit of work.
grant duely_app to duely_system;

create table firms (id uuid primary key default gen_random_uuid(), name text not null);
create table invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references firms(id),
  label text not null
);

alter table invoices enable row level security;
alter table invoices force row level security;
create policy tenant_isolation on invoices
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on invoices to duely_app;
grant select on firms to duely_app;

insert into firms (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B');
insert into invoices (tenant_id, label)
  select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A-' || g from generate_series(1, 30) g;
insert into invoices (tenant_id, label)
  select 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B-' || g from generate_series(1, 20) g;
