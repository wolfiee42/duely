import {
  checkDraft,
  DRAFT_SYSTEM,
  draftContent,
  DraftOutput,
  fillDraft,
  type ModelClient,
} from "@repo/ai";
import { nowWithOffset, realNow } from "@repo/clock";
import { withSystemTenant, type Db, type Tx } from "@repo/db";
import {
  clients,
  collectionPolicies,
  contacts,
  disputes,
  firms,
  invoices,
  messages,
  policySteps,
  promises,
  reminderJobs,
  reviewItems,
} from "@repo/db/schema";
import { nextAllowedInstant, shiftDate, localParts } from "@repo/domain";
import { reminderDraft } from "@repo/email";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { runAi } from "./ai";
import { audit } from "./audit";
import { systemScope } from "./domains";
import { newToken } from "./tokens";

/** The model, when one is configured. Without it every reminder is the plain template (FR-11.20). */
export interface ProcessDeps {
  model: ModelClient | null;
}

export type ProcessResult =
  | { outcome: "noop" | "cancelled" | "paused" | "deferred" | "drafted" }
  | { outcome: "queued"; messageId: string };

const SYSTEM = (tenantId: string) => ({ tenantId, type: "system" as const, id: null });
const OPEN = ["sent", "viewed", "overdue"];

interface Ready {
  tenantId: string;
  job: typeof reminderJobs.$inferSelect;
  step: typeof policySteps.$inferSelect;
  invoice: typeof invoices.$inferSelect;
  client: typeof clients.$inferSelect;
  recipient: typeof contacts.$inferSelect;
  firmName: string;
  daysFromDue: number;
  template: { subject: string; body: string };
  recent: string[];
}

/**
 * `process_job` (SPEC 3.2): turns a claimed reminder job into an outbox message, or a draft awaiting
 * approval. Three steps so no transaction ever holds a model call (D22): check and gather (tx), write the
 * reminder with AI wording if available (outside any tx), then check again and save (tx). The caller
 * enqueues `send_message` after it commits. Every check is repeated because the world may have changed
 * since the tick claimed the job (FR-9.9).
 */
export async function processJob(
  systemDb: Db,
  jobId: string,
  deps: ProcessDeps = { model: null },
): Promise<ProcessResult> {
  const [found] = await systemDb
    .select({ tenantId: reminderJobs.tenantId })
    .from(reminderJobs)
    .where(eq(reminderJobs.id, jobId));
  if (!found) return { outcome: "noop" };
  const tenantId = found.tenantId;

  const first = await withSystemTenant(systemDb, tenantId, (tx) => evaluate(tx, tenantId, jobId));
  if (!("ready" in first)) return first;

  let wording: Wording = { ...first.ready.template, by: "template" };
  if (deps.model) wording = await aiWording(systemDb, deps.model, first.ready);

  return withSystemTenant(systemDb, tenantId, async (tx): Promise<ProcessResult> => {
    const again = await evaluate(tx, tenantId, jobId);
    if (!("ready" in again)) return again;
    return save(tx, again.ready, wording);
  });
}

interface Wording {
  subject: string;
  body: string;
  by: "template" | "ai";
  /** Why a generated draft was set aside, for the audit trail. */
  rejected?: string;
  runId?: string;
}

/**
 * Asks the model for the wording and checks it (FR-11.7). Amounts, dates and numbers are never the model's:
 * it writes around placeholders that are filled from the invoice. Anything that fails a check, or any
 * failure of the call itself, falls back to the plain template, visibly (FR-11.20).
 */
async function aiWording(systemDb: Db, model: ModelClient, ready: Ready): Promise<Wording> {
  const fallback: Wording = { ...ready.template, by: "template" };
  const result = await runAi(systemScope(systemDb), model, {
    tenantId: ready.tenantId,
    purpose: "draft",
    system: DRAFT_SYSTEM,
    content: draftContent({
      tone: ready.step.tone,
      clientName: ready.client.name,
      daysFromDue: ready.daysFromDue,
      recent: ready.recent,
    }),
    hashText: `${ready.step.tone}:${ready.daysFromDue}:${ready.recent.join("|")}`,
    schema: DraftOutput,
    invoiceId: ready.invoice.id,
    maxTokens: 700,
  });
  if (!result.ok) return { ...fallback, rejected: `ai_${result.reason}` };
  const problems = checkDraft(result.output);
  if (problems.length) {
    return {
      ...fallback,
      rejected: `guardrail: ${problems.join("; ")}`.slice(0, 300),
      runId: result.runId,
    };
  }
  const filled = fillDraft(result.output, {
    amountMinor: ready.invoice.totalMinor - ready.invoice.paidMinor,
    dueDate: ready.invoice.dueDate ?? "",
    invoiceNumber: ready.invoice.number ?? "",
  });
  return { ...filled, by: "ai", runId: result.runId };
}

/** Everything that decides whether and what to send. Reads, plus the terminal states a stale job ends in. */
async function evaluate(
  tx: Tx,
  tenantId: string,
  jobId: string,
): Promise<ProcessResult | { ready: Ready }> {
  const [job] = await tx
    .select()
    .from(reminderJobs)
    .where(eq(reminderJobs.id, jobId))
    .for("update");
  // A repeat delivery of the queue message finds the job already handled.
  if (!job || !["claimed", "enqueued"].includes(job.status)) return { outcome: "noop" };

  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, job.invoiceId));
  const [step] = await tx.select().from(policySteps).where(eq(policySteps.id, job.stepId));
  const setJob = (set: Partial<typeof reminderJobs.$inferInsert>) =>
    tx.update(reminderJobs).set(set).where(eq(reminderJobs.id, jobId));

  // Paid or void: the invoice needs nothing more.
  if (!invoice || ["paid", "void", "draft"].includes(invoice.status)) {
    await setJob({ status: "cancelled", pauseReason: null });
    return { outcome: "cancelled" };
  }
  // A promise or dispute holds the schedule; `replan` will wake the job when it ends.
  const [promise] = await tx
    .select({ id: promises.id })
    .from(promises)
    .where(and(eq(promises.invoiceId, invoice.id), eq(promises.status, "active")));
  const [dispute] = await tx
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.invoiceId, invoice.id), eq(disputes.status, "open")));
  if (!OPEN.includes(invoice.status) || promise || dispute) {
    await setJob({ status: "skipped", pauseReason: dispute ? "dispute" : "promise" });
    return { outcome: "paused" };
  }

  const [firm] = await tx.select().from(firms).where(eq(firms.id, tenantId));
  const [client] = await tx.select().from(clients).where(eq(clients.id, invoice.clientId));
  const eligible = await tx
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, invoice.clientId),
        eq(contacts.receivesReminders, true),
        eq(contacts.emailStatus, "ok"),
      ),
    )
    .orderBy(asc(sql`not ${contacts.isPrimary}`), asc(contacts.createdAt));
  const recipient = eligible[0];
  if (!firm || !client || !step || !recipient) {
    await setJob({ status: "cancelled", lastError: "no contact can receive reminders" });
    return { outcome: "cancelled" };
  }

  // Quiet hours and weekends are judged in the client's timezone; a miss is deferred, not dropped (FR-9.8).
  const [policy] = await tx
    .select()
    .from(collectionPolicies)
    .where(eq(collectionPolicies.id, step.policyId));
  const now = nowWithOffset(firm.clockOffsetSeconds, realNow());
  const timeZone = client.timezone ?? firm.timezone;
  const allowed = nextAllowedInstant(now, policy!, timeZone);
  if (allowed.getTime() > now.getTime()) {
    await setJob({ status: "scheduled", nextRunAt: allowed });
    return { outcome: "deferred" };
  }

  const today = localParts(now, timeZone).date;
  const daysFromDue = daysBetween(invoice.dueDate ?? today, today);
  const template = reminderDraft({
    clientName: client.name,
    number: invoice.number ?? "",
    amountDueMinor: invoice.totalMinor - invoice.paidMinor,
    dueDate: invoice.dueDate ?? shiftDate(today, 0),
    daysFromDue,
    templateKey: step.templateKey,
    tone: step.tone,
  });

  // The last three messages on this invoice, for context only (SPEC 5.2). Replies use the stripped text.
  const recentRows = await tx
    .select({
      stripped: messages.bodyStripped,
      text: messages.bodyText,
      direction: messages.direction,
    })
    .from(messages)
    .where(
      and(
        eq(messages.invoiceId, invoice.id),
        inArray(messages.status, ["sent", "delivered", "received"]),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(3);
  const recent = recentRows.map((m) => (m.stripped ?? m.text ?? "").slice(0, 800)).filter(Boolean);

  return {
    ready: {
      tenantId,
      job,
      step,
      invoice,
      client,
      recipient,
      firmName: firm.displayName,
      daysFromDue,
      template,
      recent,
    },
  };
}

/** Writes the reminder: a draft awaiting approval, or a queued message for an auto-send step. */
async function save(tx: Tx, ready: Ready, wording: Wording): Promise<ProcessResult> {
  const { tenantId, job, step, invoice, client, recipient } = ready;
  const setJob = (set: Partial<typeof reminderJobs.$inferInsert>) =>
    tx.update(reminderJobs).set(set).where(eq(reminderJobs.id, job.id));

  const auto = step.sendMode === "auto";
  const [message] = await tx
    .insert(messages)
    .values({
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      contactId: recipient.id,
      direction: "out",
      kind: "reminder",
      status: auto ? "queued" : "draft",
      subject: wording.subject,
      bodyText: wording.body,
      replyToken: newToken().slice(0, 24),
      jobId: job.id,
      dedupeKey: `job:${job.id}`,
      generatedBy: wording.by,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  if (!message) {
    // The message already exists (a retry after a partial failure): adopt it.
    const [existing] = await tx.select().from(messages).where(eq(messages.jobId, job.id));
    await setJob({
      status: existing?.status === "draft" ? "awaiting_approval" : "enqueued",
      messageId: existing?.id,
    });
    return existing && existing.status === "queued"
      ? { outcome: "queued", messageId: existing.id }
      : { outcome: "drafted" };
  }

  if (wording.rejected) {
    await audit(
      tx,
      SYSTEM(tenantId),
      "reminder.ai_draft_not_used",
      { type: "message", id: message.id },
      {
        after: { reason: wording.rejected },
      },
    );
  }
  if (step.escalateNotifyFirm) {
    await audit(
      tx,
      SYSTEM(tenantId),
      "reminder.escalated",
      { type: "invoice", id: invoice.id },
      {
        after: { step: step.offsetDays },
      },
    );
  }

  if (auto) {
    await setJob({ status: "enqueued", messageId: message.id });
    return { outcome: "queued", messageId: message.id };
  }
  await setJob({ status: "awaiting_approval", messageId: message.id });
  await tx.insert(reviewItems).values({
    tenantId,
    kind: "draft_approval",
    invoiceId: invoice.id,
    messageId: message.id,
    jobId: job.id,
    aiRunId: wording.runId ?? null,
    payload: {
      stepOffsetDays: step.offsetDays,
      tone: step.tone,
      to: recipient.email,
      by: wording.by,
    },
  });
  return { outcome: "drafted" };
}

function daysBetween(from: string, to: string): number {
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}
