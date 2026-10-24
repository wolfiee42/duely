import { nowWithOffset, realNow } from "@repo/clock";
import { withSystemTenant, type Db } from "@repo/db";
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
import { and, asc, eq, sql } from "drizzle-orm";

import { audit } from "./audit";
import { newToken } from "./tokens";

export type ProcessResult =
  | { outcome: "noop" | "cancelled" | "paused" | "deferred" | "drafted" }
  | { outcome: "queued"; messageId: string };

const SYSTEM = (tenantId: string) => ({ tenantId, type: "system" as const, id: null });
const OPEN = ["sent", "viewed", "overdue"];

/**
 * `process_job` (SPEC 3.2): turns a claimed reminder job into an outbox message, or a draft awaiting
 * approval. DB work only, in one transaction; the caller enqueues `send_message` after it commits.
 * Every check is repeated here because the world may have changed since the tick claimed the job (FR-9.9).
 */
export async function processJob(systemDb: Db, jobId: string): Promise<ProcessResult> {
  const [found] = await systemDb
    .select({ tenantId: reminderJobs.tenantId })
    .from(reminderJobs)
    .where(eq(reminderJobs.id, jobId));
  if (!found) return { outcome: "noop" };
  const tenantId = found.tenantId;

  return withSystemTenant(systemDb, tenantId, async (tx): Promise<ProcessResult> => {
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
    if (
      !invoice ||
      invoice.status === "paid" ||
      invoice.status === "void" ||
      invoice.status === "draft"
    ) {
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
    const draft = reminderDraft({
      clientName: client.name,
      number: invoice.number ?? "",
      amountDueMinor: invoice.totalMinor - invoice.paidMinor,
      dueDate: invoice.dueDate ?? shiftDate(today, 0),
      daysFromDue: daysBetween(invoice.dueDate ?? today, today),
      templateKey: step.templateKey as "pre_due" | "due" | "overdue" | "final",
      tone: step.tone,
    });

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
        subject: draft.subject,
        bodyText: draft.body,
        replyToken: newToken().slice(0, 24),
        jobId,
        dedupeKey: `job:${jobId}`,
        generatedBy: "template",
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!message) {
      // The message already exists (a retry after a partial failure): adopt it.
      const [existing] = await tx.select().from(messages).where(eq(messages.jobId, jobId));
      await setJob({
        status: existing?.status === "draft" ? "awaiting_approval" : "enqueued",
        messageId: existing?.id,
      });
      return existing && existing.status === "queued"
        ? { outcome: "queued", messageId: existing.id }
        : { outcome: "drafted" };
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
      jobId,
      payload: { stepOffsetDays: step.offsetDays, tone: step.tone, to: recipient.email },
    });
    return { outcome: "drafted" };
  });
}

function daysBetween(from: string, to: string): number {
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}
