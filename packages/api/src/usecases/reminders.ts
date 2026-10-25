import type { Tx } from "@repo/db";
import {
  clients,
  disputes,
  invoices,
  messages,
  policySteps,
  promises,
  reminderJobs,
  reviewItems,
} from "@repo/db/schema";
import { DomainError, plan, type InvoiceEffect } from "@repo/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import { firmClock } from "./firm-clock";
import { policyFor } from "./policies";

// Reminder jobs follow the invoice (SPEC 3.1 effects, 3.2). Everything here runs inside the
// transaction that changes the invoice, so the schedule and the status can never disagree.

const MOVABLE = ["scheduled", "skipped"] as const;
const IN_FLIGHT = ["scheduled", "claimed", "enqueued", "awaiting_approval"] as const;
const NOT_FINAL = [...IN_FLIGHT, "skipped", "failed"] as const;
const UNSENT_MESSAGE = ["draft", "approved", "queued"] as const;

async function load(tx: Tx, tenantId: string, invoiceId: string) {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice) throw new DomainError("invoice.not_found", "not_found");
  const [client] = await tx.select().from(clients).where(eq(clients.id, invoice.clientId));
  const { firm, now } = await firmClock(tx, tenantId);
  return { invoice, client: client!, firm, now };
}

/** Called when an invoice is sent. Idempotent: planning twice leaves the same jobs. */
export async function planInvoiceJobs(tx: Tx, tenantId: string, invoiceId: string) {
  const { invoice, client, firm, now } = await load(tx, tenantId, invoiceId);
  if (!invoice.dueDate) return;
  const { policy, steps } = await policyFor(tx, tenantId, client.policyId);
  const plans = plan({
    dueDate: invoice.dueDate,
    steps: steps.map((s) => ({ id: s.id, offsetDays: s.offsetDays })),
    window: policy,
    timeZone: client.timezone ?? firm.timezone,
    now,
  });
  if (!plans.length) return;
  await tx
    .insert(reminderJobs)
    .values(
      plans.map((p) => ({
        tenantId,
        invoiceId,
        stepId: p.stepId,
        status: p.action === "skip" ? ("skipped" as const) : ("scheduled" as const),
        plannedFor: p.plannedFor,
        nextRunAt: p.nextRunAt,
      })),
    )
    .onConflictDoNothing();
}

async function onHold(tx: Tx, invoiceId: string) {
  const [promise] = await tx
    .select({ id: promises.id })
    .from(promises)
    .where(and(eq(promises.invoiceId, invoiceId), eq(promises.status, "active")));
  const [dispute] = await tx
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.invoiceId, invoiceId), eq(disputes.status, "open")));
  return Boolean(promise || dispute);
}

/**
 * Recomputes timing for jobs that are still waiting (or were paused), after a hold ends or a promise breaks.
 * Sent, cancelled and in-flight jobs are untouched; if another hold is still open, nothing moves.
 */
export async function replanInvoiceJobs(tx: Tx, tenantId: string, invoiceId: string) {
  const { invoice, client, firm, now } = await load(tx, tenantId, invoiceId);
  if (!invoice.dueDate || !["sent", "viewed", "overdue"].includes(invoice.status)) return;
  if (await onHold(tx, invoiceId)) return;

  const jobs = await tx
    .select({ job: reminderJobs, step: policySteps })
    .from(reminderJobs)
    .innerJoin(policySteps, eq(policySteps.id, reminderJobs.stepId))
    .where(and(eq(reminderJobs.invoiceId, invoiceId), inArray(reminderJobs.status, [...MOVABLE])));
  if (!jobs.length) return;

  const { policy } = await policyFor(tx, tenantId, client.policyId);
  const plans = plan({
    dueDate: invoice.dueDate,
    steps: jobs.map(({ step }) => ({ id: step.id, offsetDays: step.offsetDays })),
    window: policy,
    timeZone: client.timezone ?? firm.timezone,
    now,
  });
  for (const p of plans) {
    await tx
      .update(reminderJobs)
      .set({
        status: p.action === "skip" ? "skipped" : "scheduled",
        plannedFor: p.plannedFor,
        nextRunAt: p.nextRunAt,
        pauseReason: null,
      })
      .where(
        and(
          eq(reminderJobs.invoiceId, invoiceId),
          eq(reminderJobs.stepId, p.stepId),
          inArray(reminderJobs.status, [...MOVABLE]),
        ),
      );
  }
}

/** Drops anything that has not left yet for these jobs: unsent messages and open approval items. */
async function withdraw(tx: Tx, jobIds: string[]) {
  if (!jobIds.length) return;
  await tx
    .update(messages)
    .set({ status: "cancelled" })
    .where(and(inArray(messages.jobId, jobIds), inArray(messages.status, [...UNSENT_MESSAGE])));
  await tx
    .update(reviewItems)
    .set({ status: "dismissed", resolvedAt: sql`now()` })
    .where(and(inArray(reviewItems.jobId, jobIds), eq(reviewItems.status, "open")));
}

/** A promise or dispute is holding the schedule: nothing is sent until it ends (FR-9.7). */
export async function pauseInvoiceJobs(
  tx: Tx,
  invoiceId: string,
  reason: "promise" | "dispute" | "already_paid_review",
) {
  const paused = await tx
    .update(reminderJobs)
    .set({ status: "skipped", pauseReason: reason })
    .where(and(eq(reminderJobs.invoiceId, invoiceId), inArray(reminderJobs.status, [...IN_FLIGHT])))
    .returning({ id: reminderJobs.id });
  await withdraw(
    tx,
    paused.map((j) => j.id),
  );
}

/** Payment, void or a hard bounce: the invoice needs no more reminders (FR-9.6). Final. */
export async function cancelInvoiceJobs(tx: Tx, invoiceId: string) {
  const cancelled = await tx
    .update(reminderJobs)
    .set({ status: "cancelled", pauseReason: null })
    .where(and(eq(reminderJobs.invoiceId, invoiceId), inArray(reminderJobs.status, [...NOT_FINAL])))
    .returning({ id: reminderJobs.id });
  await withdraw(
    tx,
    cancelled.map((j) => j.id),
  );
}

/** Runs the job effects a state-machine transition asked for. */
export async function applyJobEffects(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  effects: readonly InvoiceEffect[],
  holdReason: "promise" | "dispute" = "promise",
) {
  for (const effect of effects) {
    if (effect.type === "plan_jobs") await planInvoiceJobs(tx, tenantId, invoiceId);
    if (effect.type === "pause_jobs") await pauseInvoiceJobs(tx, invoiceId, holdReason);
    if (effect.type === "replan_jobs") await replanInvoiceJobs(tx, tenantId, invoiceId);
    if (effect.type === "cancel_jobs") await cancelInvoiceJobs(tx, invoiceId);
  }
}
