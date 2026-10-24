ALTER TABLE "policy_steps" DROP CONSTRAINT "policy_steps_policy_id_position_unique";--> statement-breakpoint
ALTER TABLE "policy_steps" DROP CONSTRAINT "policy_steps_policy_id_offset_days_unique";--> statement-breakpoint
ALTER TABLE "policy_steps" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_steps_position" ON "policy_steps" ("policy_id","position") WHERE "archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_steps_offset" ON "policy_steps" ("policy_id","offset_days") WHERE "archived_at" is null;