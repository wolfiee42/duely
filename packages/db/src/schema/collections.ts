import { sql } from "drizzle-orm";
import {
  check,
  bigint,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { invoices } from "./billing";
import { policySteps } from "./policies";
import { messages } from "./portal";
import { firms, members } from "./tenancy";
import type {
  AiPurpose,
  AiRunStatus,
  JobPauseReason,
  JobStatus,
  ReviewKind,
  ReviewStatus,
} from "./types";

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => firms.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const reminderJobs = pgTable(
  "reminder_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    invoiceId: uuid("invoice_id").notNull(),
    stepId: uuid("step_id").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("scheduled"),
    // `due_date + offset`, a calendar date in the client's timezone.
    plannedFor: date("planned_for", { mode: "string" }).notNull(),
    // A real UTC instant, after quiet-hour adjustment.
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    messageId: uuid("message_id"),
    pauseReason: text("pause_reason").$type<JobPauseReason>(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.stepId],
      foreignColumns: [policySteps.tenantId, policySteps.id],
    }),
    unique("reminder_jobs_tenant_id_id").on(t.tenantId, t.id),
    // Planning is idempotent: replanning upserts rather than duplicating.
    unique().on(t.invoiceId, t.stepId),
    index("reminder_jobs_due")
      .on(t.nextRunAt)
      .where(sql`${t.status} = 'scheduled'`),
    index("reminder_jobs_invoice").on(t.tenantId, t.invoiceId),
    check(
      "reminder_jobs_status_check",
      sql`${t.status} in ('scheduled', 'claimed', 'enqueued', 'awaiting_approval', 'sent', 'failed', 'dead', 'cancelled', 'skipped')`,
    ),
    check(
      "reminder_jobs_pause_check",
      sql`${t.pauseReason} in ('promise', 'dispute', 'already_paid_review')`,
    ),
  ],
);

// Every model call (FR-11.18). Only validated output is stored, never the prompt or the raw reply.
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    purpose: text("purpose").$type<AiPurpose>().notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    inputHash: text("input_hash").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    // Millionths of a dollar.
    costMicros: bigint("cost_micros", { mode: "number" }),
    latencyMs: integer("latency_ms"),
    status: text("status").$type<AiRunStatus>().notNull(),
    output: jsonb("output"),
    error: text("error"),
    invoiceId: uuid("invoice_id"),
    messageId: uuid("message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.messageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    unique("ai_runs_tenant_id_id").on(t.tenantId, t.id),
    index("ai_runs_tenant_month").on(t.tenantId, t.createdAt),
    check(
      "ai_runs_purpose_check",
      sql`${t.purpose} in ('extraction', 'draft', 'classify', 'risk_explain')`,
    ),
    check("ai_runs_status_check", sql`${t.status} in ('ok', 'schema_invalid', 'error', 'capped')`),
  ],
);

export const reviewItems = pgTable(
  "review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text("kind").$type<ReviewKind>().notNull(),
    invoiceId: uuid("invoice_id"),
    messageId: uuid("message_id"),
    jobId: uuid("job_id"),
    aiRunId: uuid("ai_run_id"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").$type<ReviewStatus>().notNull().default("open"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.messageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.jobId],
      foreignColumns: [reminderJobs.tenantId, reminderJobs.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.aiRunId],
      foreignColumns: [aiRuns.tenantId, aiRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.resolvedBy],
      foreignColumns: [members.tenantId, members.id],
    }),
    index("review_open").on(t.tenantId, t.status, t.createdAt),
    check(
      "review_items_kind_check",
      sql`${t.kind} in ('draft_approval', 'low_confidence_reply', 'unmatched_inbound', 'already_paid_claim', 'dead_job', 'extraction_review')`,
    ),
    check(
      "review_items_status_check",
      sql`${t.status} in ('open', 'approved', 'edited', 'rejected', 'dismissed')`,
    ),
  ],
);

// Inbound mail that cannot be tied to any firm (no valid reply token, sender unknown or ambiguous).
// Not tenant data, so no RLS: only the system role can reach it, and nothing is silently dropped (FR-8.8).
export const unroutedInbound = pgTable("unrouted_inbound", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerMessageId: text("provider_message_id").notNull().unique(),
  fromEmail: text("from_email").notNull(),
  subject: text("subject"),
  bodyText: text("body_text"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
