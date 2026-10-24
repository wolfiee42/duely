import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { firms } from "./tenancy";
import type { StepSendMode, StepTone, TemplateKey } from "./types";

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => firms.id);

// SPEC 2.2. Kept apart from the job tables so `clients` can point at a policy without an import cycle.
export const collectionPolicies = pgTable(
  "collection_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    // The allowed sending window is [quiet_start, quiet_end) in the client's timezone (FR-9.8).
    quietStart: time("quiet_start").notNull().default("08:00"),
    quietEnd: time("quiet_end").notNull().default("19:00"),
    sendWeekends: boolean("send_weekends").notNull().default(false),
    promiseGraceDays: integer("promise_grace_days").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("collection_policies_tenant_id_id").on(t.tenantId, t.id),
    uniqueIndex("one_default_policy")
      .on(t.tenantId)
      .where(sql`${t.isDefault}`),
    check("policies_quiet_check", sql`${t.quietStart} < ${t.quietEnd}`),
    check("policies_grace_check", sql`${t.promiseGraceDays} between 0 and 30`),
  ],
);

export const policySteps = pgTable(
  "policy_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    policyId: uuid("policy_id").notNull(),
    position: integer("position").notNull(),
    // Relative to the due date; negative means before.
    offsetDays: integer("offset_days").notNull(),
    templateKey: text("template_key").$type<TemplateKey>().notNull(),
    tone: text("tone").$type<StepTone>().notNull(),
    sendMode: text("send_mode").$type<StepSendMode>().notNull().default("draft"),
    escalateNotifyFirm: boolean("escalate_notify_firm").notNull().default(false),
    // A removed step stays so that jobs and messages that used it keep a valid reference.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.policyId],
      foreignColumns: [collectionPolicies.tenantId, collectionPolicies.id],
    }).onDelete("cascade"),
    unique("policy_steps_tenant_id_id").on(t.tenantId, t.id),
    uniqueIndex("policy_steps_position")
      .on(t.policyId, t.position)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex("policy_steps_offset")
      .on(t.policyId, t.offsetDays)
      .where(sql`${t.archivedAt} is null`),
    check("policy_steps_tone_check", sql`${t.tone} in ('friendly', 'neutral', 'firm')`),
    check("policy_steps_send_mode_check", sql`${t.sendMode} in ('draft', 'auto')`),
    check("policy_steps_offset_check", sql`${t.offsetDays} between -60 and 365`),
  ],
);
