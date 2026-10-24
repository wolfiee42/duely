import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { clients, contacts, invoices } from "./billing";
import { firms, members } from "./tenancy";
import type {
  DisputeSource,
  DisputeStatus,
  InvoiceStatus,
  MessageAuthor,
  MessageDirection,
  MessageKind,
  MessageStatus,
  PromiseSource,
  PromiseStatus,
  TokenPurpose,
} from "./types";

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => firms.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// The outbox (D22): a row is inserted `queued` in the same transaction as the change that causes it,
// and the queue is told only after commit. `job_id` references reminder_jobs, which arrives in Phase 4.
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    clientId: uuid("client_id"),
    invoiceId: uuid("invoice_id"),
    contactId: uuid("contact_id"),
    direction: text("direction").$type<MessageDirection>().notNull(),
    kind: text("kind").$type<MessageKind>().notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    bodyStripped: text("body_stripped"),
    replyToken: text("reply_token").unique(),
    providerMessageId: text("provider_message_id").unique(),
    jobId: uuid("job_id").unique(),
    dedupeKey: text("dedupe_key").unique(),
    generatedBy: text("generated_by").$type<MessageAuthor>().notNull().default("template"),
    approvedBy: uuid("approved_by"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contacts.tenantId, contacts.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [members.tenantId, members.id],
    }),
    unique("messages_tenant_id_id").on(t.tenantId, t.id),
    index("messages_invoice").on(t.tenantId, t.invoiceId, t.createdAt),
    index("messages_queued")
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    check("messages_direction_check", sql`${t.direction} in ('out', 'in')`),
    check(
      "messages_kind_check",
      sql`${t.kind} in ('invoice', 'reminder', 'receipt', 'notification', 'reply')`,
    ),
    check(
      "messages_status_check",
      sql`${t.status} in ('draft', 'approved', 'queued', 'sent', 'delivered', 'bounced', 'complained', 'received', 'unmatched', 'cancelled')`,
    ),
    check("messages_generated_by_check", sql`${t.generatedBy} in ('template', 'ai', 'human')`),
  ],
);

// SPEC 7: only the sha256 is stored. `login` tokens are single-use, `invoice_link` tokens are bound to
// one invoice and valid for 7 days.
export const portalTokens = pgTable(
  "portal_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    contactId: uuid("contact_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").$type<TokenPurpose>().notNull(),
    invoiceId: uuid("invoice_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contacts.tenantId, contacts.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    index("portal_tokens_contact_idx").on(t.tenantId, t.contactId, t.createdAt),
    check("portal_tokens_purpose_check", sql`${t.purpose} in ('login', 'invoice_link')`),
    check(
      "portal_tokens_invoice_link_check",
      sql`${t.purpose} <> 'invoice_link' or ${t.invoiceId} is not null`,
    ),
  ],
);

export const portalSessions = pgTable(
  "portal_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    contactId: uuid("contact_id").notNull(),
    sessionHash: text("session_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contacts.tenantId, contacts.id],
    }),
  ],
);

export const promises = pgTable(
  "promises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    invoiceId: uuid("invoice_id").notNull(),
    promisedDate: date("promised_date", { mode: "string" }).notNull(),
    source: text("source").$type<PromiseSource>().notNull(),
    sourceMessageId: uuid("source_message_id"),
    sourceQuote: text("source_quote"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    status: text("status").$type<PromiseStatus>().notNull().default("active"),
    priorStatus: text("prior_status").$type<InvoiceStatus>().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.sourceMessageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    uniqueIndex("one_active_promise")
      .on(t.invoiceId)
      .where(sql`${t.status} = 'active'`),
    check("promises_source_check", sql`${t.source} in ('portal', 'ai_reply', 'manual')`),
    check("promises_status_check", sql`${t.status} in ('active', 'kept', 'broken', 'cancelled')`),
  ],
);

export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    invoiceId: uuid("invoice_id").notNull(),
    reason: text("reason").notNull(),
    detail: text("detail"),
    source: text("source").$type<DisputeSource>().notNull(),
    sourceMessageId: uuid("source_message_id"),
    stripeDisputeId: text("stripe_dispute_id").unique(),
    status: text("status").$type<DisputeStatus>().notNull().default("open"),
    resolutionNote: text("resolution_note"),
    priorStatus: text("prior_status").$type<InvoiceStatus>().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.sourceMessageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    uniqueIndex("one_open_dispute")
      .on(t.invoiceId)
      .where(sql`${t.status} = 'open' and ${t.stripeDisputeId} is null`),
    check("disputes_source_check", sql`${t.source} in ('portal', 'ai_reply', 'manual', 'stripe')`),
    check("disputes_status_check", sql`${t.status} in ('open', 'resolved', 'upheld')`),
  ],
);

// Counts attempts for rate limits. Keys are hashed, so no email or IP is stored. Not tenant data,
// so no RLS; purged by the jobs worker.
export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("rate_limit_lookup").on(t.scope, t.keyHash, t.createdAt)],
);
