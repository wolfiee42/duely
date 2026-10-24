import { sql } from "drizzle-orm";

import type { Db } from "./index";
import type { MemberRole } from "./schema/types";

// Pre-tenant lookups. Each calls a SECURITY DEFINER function that returns only what the caller
// needs, because RLS (correctly) hides every row until a tenant is known.

export type HostSource = "platform" | "custom";

/** Platform subdomain or `active` custom domain -> tenant. */
export async function resolveTenantByHost(db: Db, host: string, platformRoot: string) {
  const rows = await db.execute<{ tenant_id: string; source: HostSource }>(
    sql`select tenant_id, source from resolve_tenant_by_host(${host}, ${platformRoot})`,
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, source: row.source } : null;
}

/** Staff tenant comes from the members row (D20). */
export async function resolveMembership(db: Db, userId: string) {
  const rows = await db.execute<{ tenant_id: string; member_id: string; role: MemberRole }>(
    sql`select tenant_id, member_id, role from resolve_membership(${userId})`,
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, memberId: row.member_id, role: row.role } : null;
}

export async function firmSlugExists(db: Db, slug: string) {
  const rows = await db.execute<{ exists: boolean }>(
    sql`select firm_slug_exists(${slug}) as exists`,
  );
  return rows[0]?.exists ?? false;
}

/** Finds an invite by the sha256 of its token (the token is never stored). */
export async function resolveInvite(db: Db, tokenHash: string) {
  const rows = await db.execute<{
    invite_id: string;
    tenant_id: string;
    email: string;
    role: MemberRole;
    expires_at: Date;
    accepted_at: Date | null;
    firm_name: string;
  }>(sql`select * from resolve_invite(${tokenHash})`);
  const r = rows[0];
  return r
    ? {
        inviteId: r.invite_id,
        tenantId: r.tenant_id,
        email: r.email,
        role: r.role,
        expiresAt: new Date(r.expires_at),
        acceptedAt: r.accepted_at ? new Date(r.accepted_at) : null,
        firmName: r.firm_name,
      }
    : null;
}
