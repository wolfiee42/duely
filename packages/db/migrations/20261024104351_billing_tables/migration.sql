CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"billing_address" jsonb,
	"timezone" text,
	"notes" text,
	"policy_id" uuid,
	"external_ref" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_tenant_id_external_ref_unique" UNIQUE("tenant_id","external_ref"),
	CONSTRAINT "clients_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" citext NOT NULL,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"receives_invoices" boolean DEFAULT true NOT NULL,
	"receives_reminders" boolean DEFAULT true NOT NULL,
	"email_status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_tenant_id_client_id_email_unique" UNIQUE("tenant_id","client_id","email"),
	CONSTRAINT "contacts_email_status_check" CHECK ("email_status" in ('ok', 'bounced', 'complained', 'unsubscribed'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_kind_check" CHECK ("kind" in ('extraction_source', 'attachment', 'invoice_pdf'))
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12,3) NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "invoice_items_invoice_id_position_unique" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_items_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "invoice_items_unit_check" CHECK ("unit_amount_minor" >= 0),
	CONSTRAINT "invoice_items_amount_check" CHECK ("amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_sequences" (
	"tenant_id" uuid PRIMARY KEY,
	"next_number" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"paid_minor" bigint DEFAULT 0 NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"sent_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"payment_processing" boolean DEFAULT false NOT NULL,
	"risk_level" text,
	"risk_factors" jsonb,
	"risk_explanation" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_tenant_id_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "invoices_tenant_id_external_ref_unique" UNIQUE("tenant_id","external_ref"),
	CONSTRAINT "invoices_status_check" CHECK ("status" in ('draft', 'sent', 'viewed', 'overdue', 'promised', 'disputed', 'paid', 'void')),
	CONSTRAINT "invoices_currency_check" CHECK ("currency" = 'USD'),
	CONSTRAINT "invoices_subtotal_check" CHECK ("subtotal_minor" >= 0),
	CONSTRAINT "invoices_total_check" CHECK ("total_minor" >= 0),
	CONSTRAINT "invoices_paid_check" CHECK ("paid_minor" >= 0),
	CONSTRAINT "invoices_refunded_check" CHECK ("refunded_minor" >= 0),
	CONSTRAINT "invoices_source_check" CHECK ("source" in ('manual', 'ai_extraction', 'csv_import')),
	CONSTRAINT "invoices_risk_level_check" CHECK ("risk_level" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_payment_intent_id" text NOT NULL UNIQUE,
	"stripe_charge_id" text,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"application_fee_minor" bigint DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_method_check" CHECK ("method" in ('card', 'ach')),
	CONSTRAINT "payments_status_check" CHECK ("status" in ('processing', 'succeeded', 'failed')),
	CONSTRAINT "payments_amount_check" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_refund_id" text UNIQUE,
	"amount_minor" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_check" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"stripe_account_id" text,
	"tenant_id" uuid,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_invites" DROP CONSTRAINT "member_invites_invited_by_members_id_fkey";--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_id" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE INDEX "clients_tenant_idx" ON "clients" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_primary_contact" ON "contacts" ("client_id") WHERE "is_primary";--> statement-breakpoint
CREATE INDEX "documents_tenant_invoice_idx" ON "documents" ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_items_tenant_idx" ON "invoice_items" ("tenant_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_status_due" ON "invoices" ("tenant_id","status","due_date");--> statement-breakpoint
CREATE INDEX "invoices_client" ON "invoices" ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" ("tenant_id","invoice_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_client_id_clients_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","client_id") REFERENCES "clients"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_client_id_clients_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","client_id") REFERENCES "clients"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_payment_id_payments_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "payments"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_tenant_id_invited_by_members_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invited_by") REFERENCES "members"("tenant_id","id");