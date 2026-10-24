import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.schema";
import { citext } from "./citext";
import type { DomainStatus, MemberRole } from "./types";

// RLS policies and grants live in the custom migration (drizzle cannot express FORCE RLS).
// `firms` is the tenant root, so its policy uses `id` where other tables use `tenant_id`.
export const firms = pgTable(
  "firms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformSlug: text("platform_slug").notNull().unique(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    timezone: text("timezone").notNull().default("America/New_York"),
    replyToEmail: text("reply_to_email"),
    logoUrl: text("logo_url"),
    brandPrimary: text("brand_primary").notNull().default("#1F4FD8"),
    brandAccent: text("brand_accent"),
    defaultTermsDays: integer("default_terms_days").notNull().default(14),
    invoicePrefix: text("invoice_prefix").notNull().default("INV-"),
    stripeAccountId: text("stripe_account_id").unique(),
    stripeChargesEnabled: boolean("stripe_charges_enabled").notNull().default(false),
    stripePayoutsEnabled: boolean("stripe_payouts_enabled").notNull().default(false),
    stripeDetailsSubmitted: boolean("stripe_details_submitted").notNull().default(false),
    platformFeeBps: integer("platform_fee_bps").notNull().default(100),
    aiMonthlyCapCents: integer("ai_monthly_cap_cents").notNull().default(500),
    autoSendAllowed: boolean("auto_send_allowed").notNull().default(false),
    autoClassifyActions: boolean("auto_classify_actions").notNull().default(false),
    isDemo: boolean("is_demo").notNull().default(false),
    clockOffsetSeconds: bigint("clock_offset_seconds", { mode: "number" }).notNull().default(0),
    onboardingState: jsonb("onboarding_state").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FR-14.7: simulated time is impossible on non-demo firms, enforced in the DB too.
    check("firms_clock_offset_demo_only", sql`${t.clockOffsetSeconds} = 0 or ${t.isDemo}`),
  ],
);

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => firms.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    name: text("name"),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("members_tenant_id_id").on(t.tenantId, t.id),
    unique().on(t.tenantId, t.userId),
    unique().on(t.tenantId, t.email),
    // v1: a user belongs to exactly one firm (D27), and membership lookup is by user.
    unique("members_user_id_key").on(t.userId),
    check("members_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);

export const firmDomains = pgTable(
  "firm_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => firms.id),
    hostname: citext("hostname").notNull().unique(),
    cfCustomHostnameId: text("cf_custom_hostname_id"),
    status: text("status").$type<DomainStatus>().notNull(),
    sslStatus: text("ssl_status"),
    verificationErrors: jsonb("verification_errors"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // v1: one custom domain per firm. Replacing means removing first, which also releases the hostname.
    unique("firm_domains_tenant_key").on(t.tenantId),
    check(
      "firm_domains_status_check",
      sql`${t.status} in ('pending', 'verifying', 'active', 'failed')`,
    ),
  ],
);
