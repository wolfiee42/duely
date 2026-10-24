CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"source" text NOT NULL,
	"source_message_id" uuid,
	"stripe_dispute_id" text UNIQUE,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"prior_status" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_source_check" CHECK ("source" in ('portal', 'ai_reply', 'manual', 'stripe')),
	CONSTRAINT "disputes_status_check" CHECK ("status" in ('open', 'resolved', 'upheld'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"invoice_id" uuid,
	"contact_id" uuid,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"body_stripped" text,
	"reply_token" text UNIQUE,
	"provider_message_id" text UNIQUE,
	"job_id" uuid UNIQUE,
	"dedupe_key" text UNIQUE,
	"generated_by" text DEFAULT 'template' NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "messages_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "messages_direction_check" CHECK ("direction" in ('out', 'in')),
	CONSTRAINT "messages_kind_check" CHECK ("kind" in ('invoice', 'reminder', 'receipt', 'notification', 'reply')),
	CONSTRAINT "messages_status_check" CHECK ("status" in ('draft', 'approved', 'queued', 'sent', 'delivered', 'bounced', 'complained', 'received', 'unmatched', 'cancelled')),
	CONSTRAINT "messages_generated_by_check" CHECK ("generated_by" in ('template', 'ai', 'human'))
);
--> statement-breakpoint
CREATE TABLE "portal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"session_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"purpose" text NOT NULL,
	"invoice_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_tokens_purpose_check" CHECK ("purpose" in ('login', 'invoice_link')),
	CONSTRAINT "portal_tokens_invoice_link_check" CHECK ("purpose" <> 'invoice_link' or "invoice_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"promised_date" date NOT NULL,
	"source" text NOT NULL,
	"source_message_id" uuid,
	"source_quote" text,
	"confidence" numeric(4,3),
	"status" text DEFAULT 'active' NOT NULL,
	"prior_status" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promises_source_check" CHECK ("source" in ('portal', 'ai_reply', 'manual')),
	CONSTRAINT "promises_status_check" CHECK ("status" in ('active', 'kept', 'broken', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_id" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_dispute" ON "disputes" ("invoice_id") WHERE "status" = 'open' and "stripe_dispute_id" is null;--> statement-breakpoint
CREATE INDEX "messages_invoice" ON "messages" ("tenant_id","invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_queued" ON "messages" ("created_at") WHERE "status" = 'queued';--> statement-breakpoint
CREATE INDEX "portal_tokens_contact_idx" ON "portal_tokens" ("tenant_id","contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_promise" ON "promises" ("invoice_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "rate_limit_lookup" ON "rate_limit_events" ("scope","key_hash","created_at");--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_tenant_id_source_message_id_messages_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","source_message_id") REFERENCES "messages"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_client_id_clients_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","client_id") REFERENCES "clients"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_contact_id_contacts_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "contacts"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_approved_by_members_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "members"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_tenant_id_contact_id_contacts_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "contacts"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "portal_tokens" ADD CONSTRAINT "portal_tokens_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "portal_tokens" ADD CONSTRAINT "portal_tokens_tenant_id_contact_id_contacts_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "contacts"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "portal_tokens" ADD CONSTRAINT "portal_tokens_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_tenant_id_source_message_id_messages_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","source_message_id") REFERENCES "messages"("tenant_id","id");