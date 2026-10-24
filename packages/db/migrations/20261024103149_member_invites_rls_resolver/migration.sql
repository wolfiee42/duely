alter table member_invites enable row level security;
alter table member_invites force row level security;
create policy tenant_isolation on member_invites
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

grant select, insert, update, delete on member_invites to duely_app, duely_system;
--> statement-breakpoint

-- An invitee has no tenant yet, so the invite is found by the hash of the token in their link.
-- Returns only what the join page needs.
create function resolve_invite(p_token_hash text)
returns table (invite_id uuid, tenant_id uuid, email text, role text, expires_at timestamptz,
               accepted_at timestamptz, firm_name text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select i.id, i.tenant_id, i.email::text, i.role, i.expires_at, i.accepted_at, f.display_name
    from member_invites i join firms f on f.id = i.tenant_id
   where i.token_hash = p_token_hash
$$;
--> statement-breakpoint

grant create on schema public to duely_system;
alter function resolve_invite(text) owner to duely_system;
revoke create on schema public from duely_system;
revoke all on function resolve_invite(text) from public;
grant execute on function resolve_invite(text) to duely_app, duely_system;
