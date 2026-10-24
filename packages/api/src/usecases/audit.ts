import type { Tx } from "@repo/db";
import { auditLog } from "@repo/db/schema";
import type { AuditActorType } from "@repo/db/schema";

/** Who is doing it, and in which tenant. Every mutation takes one (FR-15.1). */
export interface Actor {
  tenantId: string;
  type: AuditActorType;
  id: string | null;
  requestId?: string;
}

export interface AuditEntity {
  type: string;
  id: string | null;
}

/**
 * Appends to `audit_log` inside the mutation's own transaction, so a change and its audit entry
 * commit or roll back together. `summary` is before/after; never put secrets or tokens in it.
 */
export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  entity: AuditEntity,
  summary?: Record<string, unknown>,
) {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    entityType: entity.type,
    entityId: entity.id,
    summary: summary ?? null,
    requestId: actor.requestId ?? null,
  });
}
