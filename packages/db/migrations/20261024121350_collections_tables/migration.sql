CREATE TABLE "reminder_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"planned_for" date NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"message_id" uuid,
	"pause_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_jobs_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "reminder_jobs_invoice_id_step_id_unique" UNIQUE("invoice_id","step_id"),
	CONSTRAINT "reminder_jobs_status_check" CHECK ("status" in ('scheduled', 'claimed', 'enqueued', 'awaiting_approval', 'sent', 'failed', 'dead', 'cancelled', 'skipped')),
	CONSTRAINT "reminder_jobs_pause_check" CHECK ("pause_reason" in ('promise', 'dispute', 'already_paid_review'))
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"invoice_id" uuid,
	"message_id" uuid,
	"job_id" uuid,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_items_kind_check" CHECK ("kind" in ('draft_approval', 'low_confidence_reply', 'unmatched_inbound', 'already_paid_claim', 'dead_job', 'extraction_review')),
	CONSTRAINT "review_items_status_check" CHECK ("status" in ('open', 'approved', 'edited', 'rejected', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "collection_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"quiet_start" time DEFAULT '08:00' NOT NULL,
	"quiet_end" time DEFAULT '19:00' NOT NULL,
	"send_weekends" boolean DEFAULT false NOT NULL,
	"promise_grace_days" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_policies_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "policies_quiet_check" CHECK ("quiet_start" < "quiet_end"),
	CONSTRAINT "policies_grace_check" CHECK ("promise_grace_days" between 0 and 30)
);
--> statement-breakpoint
CREATE TABLE "policy_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"offset_days" integer NOT NULL,
	"template_key" text NOT NULL,
	"tone" text NOT NULL,
	"send_mode" text DEFAULT 'draft' NOT NULL,
	"escalate_notify_firm" boolean DEFAULT false NOT NULL,
	CONSTRAINT "policy_steps_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "policy_steps_policy_id_position_unique" UNIQUE("policy_id","position"),
	CONSTRAINT "policy_steps_policy_id_offset_days_unique" UNIQUE("policy_id","offset_days"),
	CONSTRAINT "policy_steps_tone_check" CHECK ("tone" in ('friendly', 'neutral', 'firm')),
	CONSTRAINT "policy_steps_send_mode_check" CHECK ("send_mode" in ('draft', 'auto')),
	CONSTRAINT "policy_steps_offset_check" CHECK ("offset_days" between -60 and 365)
);
--> statement-breakpoint
CREATE INDEX "reminder_jobs_due" ON "reminder_jobs" ("next_run_at") WHERE "status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "reminder_jobs_invoice" ON "reminder_jobs" ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "review_open" ON "review_items" ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_default_policy" ON "collection_policies" ("tenant_id") WHERE "is_default";--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_bb8F8A0i6Eor_fkey" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "collection_policies"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_tenant_id_step_id_policy_steps_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","step_id") REFERENCES "policy_steps"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_message_id_messages_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","message_id") REFERENCES "messages"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_job_id_reminder_jobs_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "reminder_jobs"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_resolved_by_members_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "members"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "collection_policies" ADD CONSTRAINT "collection_policies_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "policy_steps" ADD CONSTRAINT "policy_steps_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "policy_steps" ADD CONSTRAINT "policy_steps_LlmlFcZXtwg7_fkey" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "collection_policies"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_job_id_reminder_jobs_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "reminder_jobs"("tenant_id","id");