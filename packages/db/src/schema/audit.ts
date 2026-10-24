import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { firms } from "./tenancy";
import type { AuditActorType } from "./types";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => firms.id),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    summary: jsonb("summary"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_entity").on(t.tenantId, t.entityType, t.entityId, t.createdAt),
    check(
      "audit_log_actor_type_check",
      sql`${t.actorType} in ('member', 'contact', 'system', 'ai', 'stripe')`,
    ),
  ],
);

// D29: rows older than 24h are purged by the jobs worker.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => firms.id),
    key: uuid("key").notNull(),
    procedure: text("procedure").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key, t.procedure] })],
);
