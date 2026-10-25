import { ClassifyOutput, CLASSIFY_SYSTEM, classifyContent, type ModelClient } from "@repo/ai";
import { realNow } from "@repo/clock";
import { withSystemTenant, type Db } from "@repo/db";
import { clients, firms, invoices, messages, reviewItems } from "@repo/db/schema";
import { DomainError, localParts, resolveDateText, shiftDate } from "@repo/domain";
import { and, eq } from "drizzle-orm";

import { runAi } from "./ai";
import { audit, type Actor } from "./audit";
import { systemScope } from "./domains";
import { createPromise, openDispute } from "./promises-disputes";
import { pauseInvoiceJobs } from "./reminders";

// SPEC 5.3: read a client's reply and decide what, if anything, to do. The model only picks a label; this
// code checks what it claims and applies the decision table. It can never mark an invoice paid.

export const HIGH_CONFIDENCE = 0.85;
export const MID_CONFIDENCE = 0.6;
const MAX_PROMISE_DAYS = 90;

export type Decision =
  | "auto_promise"
  | "auto_dispute"
  | "paused_for_review"
  | "review"
  | "needs_human"
  | "failed"
  | "noop";

/** The classification as stored on the review item, for the reviewer and for the audit trail. */
export interface Classification {
  label: string;
  confidence: number;
  rationale: string;
  quote: string | null;
  promisedDate: string | null;
  /** Why a result was not trusted: a quote not in the message, or a date we could not confirm. */
  downgraded: string | null;
  decision: Decision;
  failure?: string;
}

const normalize = (s: string) => s.toLowerCase().replaceAll(/\s+/g, " ").trim();

/**
 * Pure: turns a validated model answer into a decision, after the code-side checks (FR-11.10, 11.11).
 * `autoActions` is the firm's opt-in to act without a person (FR-11.11).
 */
export function decide(input: {
  output: ClassifyOutput;
  rawMessage: string;
  receivedAt: Date;
  timeZone: string;
  autoActions: boolean;
}): Classification {
  const { output, rawMessage } = input;
  const result: Classification = {
    label: output.label,
    confidence: output.confidence,
    rationale: output.rationale,
    quote: output.source_quote,
    promisedDate: null,
    downgraded: null,
    decision: "review",
  };

  const acts =
    output.label === "promise" || output.label === "dispute" || output.label === "already_paid";
  if (acts) {
    // The model must be able to point at the words it relied on; otherwise it may be making it up.
    if (!output.source_quote || !normalize(rawMessage).includes(normalize(output.source_quote))) {
      result.downgraded = "quote_not_in_message";
    }
  }

  if (output.label === "promise") {
    const parsed = output.promise_date_text
      ? resolveDateText(output.promise_date_text, input.receivedAt, input.timeZone)
      : null;
    const today = localParts(input.receivedAt, input.timeZone).date;
    if (!result.downgraded) {
      if (!parsed) result.downgraded = "date_not_understood";
      else if (parsed !== output.promise_date_iso) result.downgraded = "date_mismatch";
      else if (parsed > shiftDate(today, MAX_PROMISE_DAYS)) result.downgraded = "date_too_far";
    }
    // The code's reading is what we show and use, never the model's if they disagree.
    result.promisedDate = parsed;
  }

  if (output.confidence < MID_CONFIDENCE && acts) {
    result.decision = "needs_human";
    return result;
  }
  if (!acts) return result; // needs_human / other: always a review item

  const trusted = !result.downgraded;
  const high = output.confidence >= HIGH_CONFIDENCE && trusted;
  if (output.label === "already_paid") {
    // Pause and flag when confident; never mark paid (FR-11.12). In the middle band only flag.
    result.decision = high ? "paused_for_review" : "review";
  } else if (high && input.autoActions) {
    result.decision = output.label === "promise" ? "auto_promise" : "auto_dispute";
  }
  return result;
}

/**
 * Classifies one inbound reply and acts on it. Safe to run twice: a message with a stored classification is
 * left alone. Any failure leaves the reply in the review queue for a person (FR-11.20).
 */
export async function classifyReply(
  systemDb: Db,
  deps: { model: ModelClient | null },
  messageId: string,
): Promise<Decision> {
  const [found] = await systemDb
    .select({ tenantId: messages.tenantId })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!found) return "noop";
  const tenantId = found.tenantId;

  const context = await withSystemTenant(systemDb, tenantId, async (tx) => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, messageId));
    if (!message || message.direction !== "in" || !message.invoiceId || !message.clientId)
      return null;
    const [item] = await tx
      .select()
      .from(reviewItems)
      .where(and(eq(reviewItems.messageId, messageId), eq(reviewItems.status, "open")));
    if (!item || (item.payload as { classification?: unknown }).classification) return null;
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, message.invoiceId));
    const [client] = await tx.select().from(clients).where(eq(clients.id, message.clientId));
    const [firm] = await tx.select().from(firms).where(eq(firms.id, tenantId));
    if (!invoice || !client || !firm) return null;
    return { message, item, invoice, client, firm };
  });
  if (!context) return "noop";
  const { message, item, invoice, client, firm } = context;
  const timeZone = client.timezone ?? firm.timezone;
  const body = message.bodyStripped?.trim() || message.bodyText || "";

  const result = await runAi(systemScope(systemDb), deps.model, {
    tenantId,
    purpose: "classify",
    system: CLASSIFY_SYSTEM,
    content: classifyContent({
      body,
      receivedAt: message.createdAt.toISOString(),
      timezone: timeZone,
    }),
    hashText: body,
    schema: ClassifyOutput,
    invoiceId: invoice.id,
    messageId,
    maxTokens: 500,
  });

  const system: Actor = { tenantId, type: "ai", id: null };
  const store = (c: Classification, extra: Partial<typeof reviewItems.$inferInsert> = {}) =>
    withSystemTenant(systemDb, tenantId, async (tx) => {
      await tx
        .update(reviewItems)
        .set({
          payload: { ...(item.payload as object), classification: c },
          aiRunId: result.runId,
          ...extra,
        })
        .where(eq(reviewItems.id, item.id));
      await audit(
        tx,
        system,
        "reply.classified",
        { type: "message", id: messageId },
        {
          after: {
            label: c.label,
            confidence: c.confidence,
            decision: c.decision,
            downgraded: c.downgraded,
          },
        },
      );
    });

  if (!result.ok) {
    await store({
      label: "unknown",
      confidence: 0,
      rationale: "",
      quote: null,
      promisedDate: null,
      downgraded: null,
      decision: "failed",
      failure: result.reason,
    });
    return "failed";
  }

  const c = decide({
    output: result.output,
    rawMessage: message.bodyText ?? body,
    receivedAt: message.createdAt,
    timeZone,
    autoActions: firm.autoClassifyActions,
  });

  const origin = {
    actor: system,
    source: "ai_reply" as const,
    clientId: invoice.clientId,
    provenance: { messageId, quote: c.quote, confidence: c.confidence },
  };
  const resolved = { status: "approved" as const, resolvedAt: realNow() };

  try {
    if (c.decision === "auto_promise" && c.promisedDate) {
      await createPromise(systemDb, origin, invoice.id, c.promisedDate);
      await store(c, resolved);
      return "auto_promise";
    }
    if (c.decision === "auto_dispute") {
      await openDispute(systemDb, origin, invoice.id, {
        reason: "Disputed by the client by email",
        detail: c.quote,
      });
      await store(c, resolved);
      return "auto_dispute";
    }
  } catch (error) {
    // E.g. a promise is already active. Leave it for a person, and say why.
    if (!(error instanceof DomainError)) throw error;
    c.decision = "review";
    c.downgraded = error.code;
  }

  if (c.decision === "paused_for_review") {
    await withSystemTenant(systemDb, tenantId, (tx) =>
      pauseInvoiceJobs(tx, invoice.id, "already_paid_review"),
    );
    await store(c, { kind: "already_paid_claim" });
    return c.decision;
  }
  if (c.label === "already_paid") {
    await store(c, { kind: "already_paid_claim" });
    return c.decision;
  }
  await store(c);
  return c.decision;
}
