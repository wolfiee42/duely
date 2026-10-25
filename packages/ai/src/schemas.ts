import { z } from "zod";

// SPEC 5. Strict on purpose: a reply that smuggles in an extra field such as `action` fails validation and
// takes the manual path, because the model may only choose among labels (FR-11.13).

const confidence = z.number().min(0).max(1);

export const ExtractionOutput = z
  .object({
    client_name: z.string().max(200).nullable(),
    invoice_number: z.string().max(80).nullable(),
    issue_date: z.iso.date().nullable(),
    due_date: z.iso.date().nullable(),
    currency: z.literal("USD"),
    items: z
      .array(
        z
          .object({
            description: z.string().min(1).max(500),
            quantity: z.number().positive().max(1_000_000),
            unit_amount_minor: z.number().int().min(0).max(1_000_000_000_00),
          })
          .strict(),
      )
      .max(100),
    stated_total_minor: z.number().int().min(0).nullable(),
    field_confidence: z.record(z.string(), confidence),
  })
  .strict();
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const DraftOutput = z
  .object({
    subject: z.string().min(1).max(150),
    body_text: z.string().min(1).max(3000),
  })
  .strict();
export type DraftOutput = z.infer<typeof DraftOutput>;

export const CLASSIFY_LABELS = [
  "promise",
  "dispute",
  "already_paid",
  "needs_human",
  "other",
] as const;
export const ClassifyOutput = z
  .object({
    label: z.enum(CLASSIFY_LABELS),
    confidence,
    rationale: z.string().max(200),
    promise_date_text: z.string().max(100).nullable(),
    promise_date_iso: z.iso.date().nullable(),
    source_quote: z.string().max(500).nullable(),
  })
  .strict();
export type ClassifyOutput = z.infer<typeof ClassifyOutput>;

export const RiskExplainOutput = z.object({ explanation: z.string().min(1).max(400) }).strict();
export type RiskExplainOutput = z.infer<typeof RiskExplainOutput>;
