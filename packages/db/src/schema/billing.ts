import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { citext } from "./citext";
import { collectionPolicies } from "./policies";
import { firms } from "./tenancy";
import type {
  DocumentKind,
  EmailStatus,
  InvoiceSource,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  RiskLevel,
} from "./types";

// Money is bigint minor units mapped to a JS number (D8). RLS, grants and triggers live in the
// custom migration. `tenant_id` is on every table below except `stripe_events`.
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => firms.id);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const minor = (name: string) => bigint(name, { mode: "number" });

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    billingAddress: jsonb("billing_address"),
    timezone: text("timezone"),
    notes: text("notes"),
    policyId: uuid("policy_id"),
    externalRef: text("external_ref"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.policyId],
      foreignColumns: [collectionPolicies.tenantId, collectionPolicies.id],
    }),
    unique().on(t.tenantId, t.externalRef),
    unique("clients_tenant_id_id").on(t.tenantId, t.id),
    index("clients_tenant_idx").on(t.tenantId),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    clientId: uuid("client_id").notNull(),
    name: text("name").notNull(),
    email: citext("email").notNull(),
    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    receivesInvoices: boolean("receives_invoices").notNull().default(true),
    receivesReminders: boolean("receives_reminders").notNull().default(true),
    emailStatus: text("email_status").$type<EmailStatus>().notNull().default("ok"),
    createdAt: createdAt(),
  },
  (t) => [
    // Composite FKs tie a child to its parent's tenant: FK checks bypass RLS, so a plain
    // single-column FK would let one tenant attach rows to another tenant's parent.
    foreignKey({
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    unique().on(t.tenantId, t.clientId, t.email),
    unique("contacts_tenant_id_id").on(t.tenantId, t.id),
    uniqueIndex("one_primary_contact")
      .on(t.clientId)
      .where(sql`${t.isPrimary}`),
    check(
      "contacts_email_status_check",
      sql`${t.emailStatus} in ('ok', 'bounced', 'complained', 'unsubscribed')`,
    ),
  ],
);

export const invoiceSequences = pgTable("invoice_sequences", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => firms.id),
  nextNumber: bigint("next_number", { mode: "number" }).notNull().default(1),
});

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    clientId: uuid("client_id").notNull(),
    number: text("number"),
    status: text("status").$type<InvoiceStatus>().notNull().default("draft"),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    issueDate: date("issue_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    subtotalMinor: minor("subtotal_minor").notNull().default(0),
    totalMinor: minor("total_minor").notNull().default(0),
    paidMinor: minor("paid_minor").notNull().default(0),
    refundedMinor: minor("refunded_minor").notNull().default(0),
    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    paymentProcessing: boolean("payment_processing").notNull().default(false),
    riskLevel: text("risk_level").$type<RiskLevel>(),
    riskFactors: jsonb("risk_factors"),
    riskExplanation: text("risk_explanation"),
    source: text("source").$type<InvoiceSource>().notNull().default("manual"),
    externalRef: text("external_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    unique("invoices_tenant_id_id").on(t.tenantId, t.id),
    unique().on(t.tenantId, t.number),
    unique().on(t.tenantId, t.externalRef),
    index("invoices_tenant_status_due").on(t.tenantId, t.status, t.dueDate),
    index("invoices_client").on(t.tenantId, t.clientId),
    check(
      "invoices_status_check",
      sql`${t.status} in ('draft', 'sent', 'viewed', 'overdue', 'promised', 'disputed', 'paid', 'void')`,
    ),
    check("invoices_currency_check", sql`${t.currency} = 'USD'`),
    check("invoices_subtotal_check", sql`${t.subtotalMinor} >= 0`),
    check("invoices_total_check", sql`${t.totalMinor} >= 0`),
    check("invoices_paid_check", sql`${t.paidMinor} >= 0`),
    check("invoices_refunded_check", sql`${t.refundedMinor} >= 0`),
    check("invoices_source_check", sql`${t.source} in ('manual', 'ai_extraction', 'csv_import')`),
    check("invoices_risk_level_check", sql`${t.riskLevel} in ('low', 'medium', 'high')`),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    invoiceId: uuid("invoice_id").notNull(),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    // Thousandths in the domain layer (`parseQuantity`); numeric(12,3) here, read back as a string.
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    unitAmountMinor: minor("unit_amount_minor").notNull(),
    // Computed server-side by `lineAmount`, never taken from the client.
    amountMinor: minor("amount_minor").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete("cascade"),
    unique().on(t.invoiceId, t.position),
    index("invoice_items_tenant_idx").on(t.tenantId),
    check("invoice_items_quantity_check", sql`${t.quantity} > 0`),
    check("invoice_items_unit_check", sql`${t.unitAmountMinor} >= 0`),
    check("invoice_items_amount_check", sql`${t.amountMinor} >= 0`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    invoiceId: uuid("invoice_id"),
    kind: text("kind").$type<DocumentKind>().notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: minor("size_bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    index("documents_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
    check(
      "documents_kind_check",
      sql`${t.kind} in ('extraction_source', 'attachment', 'invoice_pdf')`,
    ),
  ],
);

// The ledger is immutable: the app role can insert, and only move a `processing` payment forward.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    invoiceId: uuid("invoice_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull().unique(),
    stripeChargeId: text("stripe_charge_id"),
    method: text("method").$type<PaymentMethod>().notNull(),
    status: text("status").$type<PaymentStatus>().notNull(),
    amountMinor: minor("amount_minor").notNull(),
    applicationFeeMinor: minor("application_fee_minor").notNull().default(0),
    failureReason: text("failure_reason"),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    unique("payments_tenant_id_id").on(t.tenantId, t.id),
    index("payments_invoice_idx").on(t.tenantId, t.invoiceId),
    check("payments_method_check", sql`${t.method} in ('card', 'ach')`),
    check("payments_status_check", sql`${t.status} in ('processing', 'succeeded', 'failed')`),
    check("payments_amount_check", sql`${t.amountMinor} > 0`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    paymentId: uuid("payment_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    stripeRefundId: text("stripe_refund_id").unique(),
    amountMinor: minor("amount_minor").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    check("refunds_amount_check", sql`${t.amountMinor} > 0`),
  ],
);

// Webhook ingress (D12). Not tenant-scoped: an event arrives with only a Stripe account id.
// Only `duely_system` can touch it.
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  stripeAccountId: text("stripe_account_id"),
  tenantId: uuid("tenant_id").references(() => firms.id),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
});
