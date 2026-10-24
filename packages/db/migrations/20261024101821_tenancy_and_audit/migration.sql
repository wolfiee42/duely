CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"summary" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" in ('member', 'contact', 'system', 'ai', 'stripe'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" uuid,
	"key" uuid,
	"procedure" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("tenant_id","key","procedure")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"hostname" citext NOT NULL UNIQUE,
	"cf_custom_hostname_id" text,
	"status" text NOT NULL,
	"ssl_status" text,
	"verification_errors" jsonb,
	"last_checked_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_domains_status_check" CHECK ("status" in ('pending', 'verifying', 'active', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"platform_slug" text NOT NULL UNIQUE,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"reply_to_email" text,
	"logo_url" text,
	"brand_primary" text DEFAULT '#1F4FD8' NOT NULL,
	"brand_accent" text,
	"default_terms_days" integer DEFAULT 14 NOT NULL,
	"invoice_prefix" text DEFAULT 'INV-' NOT NULL,
	"stripe_account_id" text UNIQUE,
	"stripe_charges_enabled" boolean DEFAULT false NOT NULL,
	"stripe_payouts_enabled" boolean DEFAULT false NOT NULL,
	"stripe_details_submitted" boolean DEFAULT false NOT NULL,
	"platform_fee_bps" integer DEFAULT 100 NOT NULL,
	"ai_monthly_cap_cents" integer DEFAULT 500 NOT NULL,
	"auto_send_allowed" boolean DEFAULT false NOT NULL,
	"auto_classify_actions" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"clock_offset_seconds" bigint DEFAULT 0 NOT NULL,
	"onboarding_state" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_clock_offset_demo_only" CHECK ("clock_offset_seconds" = 0 or "is_demo")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL CONSTRAINT "members_user_id_key" UNIQUE,
	"email" citext NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_tenant_id_user_id_unique" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "members_tenant_id_email_unique" UNIQUE("tenant_id","email"),
	CONSTRAINT "members_role_check" CHECK ("role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX "audit_entity" ON "audit_log" ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "firm_domains_tenant_idx" ON "firm_domains" ("tenant_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "firm_domains" ADD CONSTRAINT "firm_domains_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;