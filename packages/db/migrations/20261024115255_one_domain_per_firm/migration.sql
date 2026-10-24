DROP INDEX "firm_domains_tenant_idx";--> statement-breakpoint
ALTER TABLE "firm_domains" ADD CONSTRAINT "firm_domains_tenant_key" UNIQUE("tenant_id");