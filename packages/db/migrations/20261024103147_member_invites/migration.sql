CREATE TABLE "member_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"email" citext NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_invites_role_check" CHECK ("role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX "member_invites_tenant_idx" ON "member_invites" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_invites_pending_email" ON "member_invites" ("tenant_id","email") WHERE "accepted_at" is null;--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_tenant_id_firms_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "firms"("id");--> statement-breakpoint
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_invited_by_members_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "members"("id");