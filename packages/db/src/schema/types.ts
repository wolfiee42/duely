export type MemberRole = "owner" | "member";
export type DomainStatus = "pending" | "verifying" | "active" | "failed";
export type AuditActorType = "member" | "contact" | "system" | "ai" | "stripe";
export type { InvoiceStatus } from "@repo/domain";
export type InvoiceSource = "manual" | "ai_extraction" | "csv_import";
export type RiskLevel = "low" | "medium" | "high";
export type EmailStatus = "ok" | "bounced" | "complained" | "unsubscribed";
export type DocumentKind = "extraction_source" | "attachment" | "invoice_pdf";
export type PaymentMethod = "card" | "ach";
export type PaymentStatus = "processing" | "succeeded" | "failed";
export type MessageDirection = "out" | "in";
export type MessageKind = "invoice" | "reminder" | "receipt" | "notification" | "reply";
export type MessageStatus =
  | "draft"
  | "approved"
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "received"
  | "unmatched"
  | "cancelled";
export type MessageAuthor = "template" | "ai" | "human";
export type TokenPurpose = "login" | "invoice_link";
export type PromiseSource = "portal" | "ai_reply" | "manual";
export type PromiseStatus = "active" | "kept" | "broken" | "cancelled";
export type DisputeSource = "portal" | "ai_reply" | "manual" | "stripe";
export type DisputeStatus = "open" | "resolved" | "upheld";
export type { StepSendMode, StepTone, TemplateKey } from "@repo/domain";
export type JobStatus =
  | "scheduled"
  | "claimed"
  | "enqueued"
  | "awaiting_approval"
  | "sent"
  | "failed"
  | "dead"
  | "cancelled"
  | "skipped";
export type JobPauseReason = "promise" | "dispute" | "already_paid_review";
export type ReviewKind =
  | "draft_approval"
  | "low_confidence_reply"
  | "unmatched_inbound"
  | "already_paid_claim"
  | "dead_job"
  | "extraction_review";
export type ReviewStatus = "open" | "approved" | "edited" | "rejected" | "dismissed";
