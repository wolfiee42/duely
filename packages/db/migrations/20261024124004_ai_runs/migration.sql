CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" bigint,
	"latency_ms" integer,
	"status" text NOT NULL,
	"output" jsonb,
	"error" text,
	"invoice_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_runs_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_runs_purpose_check" CHECK ("purpose" in ('extraction', 'draft', 'classify', 'risk_explain')),
	CONSTRAINT "ai_runs_status_check" CHECK ("status" in ('ok', 'schema_invalid', 'error', 'capped'))
);
--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "ai_run_id" uuid;--> statement-breakpoint
CREATE INDEX "ai_runs_tenant_month" ON "ai_runs" ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenant_id_invoice_id_invoices_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "invoices"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenant_id_message_id_messages_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","message_id") REFERENCES "messages"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tenant_id_ai_run_id_ai_runs_tenant_id_id_fkey" FOREIGN KEY ("tenant_id","ai_run_id") REFERENCES "ai_runs"("tenant_id","id");