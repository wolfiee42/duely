import { realNow } from "@repo/clock";
import type { Db, Tx } from "@repo/db";
import {
  contacts,
  disputes,
  firms,
  invoices,
  messages,
  payments,
  promises,
  refunds,
  stripeEvents,
} from "@repo/db/schema";
import { transition } from "@repo/domain";
import type { StripeEvent } from "@repo/stripe";
import { and, eq, sql } from "drizzle-orm";

import { audit, type Actor } from "./audit";
import { firmClock } from "./firm-clock";
import { baseContext } from "./invoices";

/** Thrown when an event depends on one that has not arrived yet. Stripe will retry, and it converges. */
export class EventNotReady extends Error {}

export interface WebhookOutcome {
  status: "processed" | "duplicate" | "ignored";
  /** Outbox messages to enqueue now that the transaction has committed (D22). */
  messageIds: string[];
}

const OPEN_STATUSES = ["sent", "viewed", "overdue", "promised", "disputed"] as const;

/**
 * D12. Safe to call any number of times, concurrently, in any order:
 *   - the event id is the dedupe key;
 *   - the event row is locked for the whole unit of work, so a duplicate waits and then sees `processed_at`;
 *   - the work runs as `duely_app` inside the firm's tenant, in one short transaction;
 *   - on failure the transaction rolls back and `processed_at` stays null so the next delivery reprocesses.
 */
export async function processStripeEvent(
  systemDb: Db,
  event: StripeEvent,
): Promise<WebhookOutcome> {
  await systemDb
    .insert(stripeEvents)
    .values({
      id: event.id,
      type: event.type,
      stripeAccountId: event.account ?? null,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();

  try {
    return await systemDb.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(stripeEvents)
        .where(eq(stripeEvents.id, event.id))
        .for("update");
      if (row!.processedAt) return { status: "duplicate" as const, messageIds: [] };

      const [firm] = event.account
        ? await tx
            .select({ id: firms.id })
            .from(firms)
            .where(eq(firms.stripeAccountId, event.account))
        : [];
      if (!firm) {
        await tx
          .update(stripeEvents)
          .set({
            processedAt: realNow(),
            error: "unknown_account",
            attempts: sql`${stripeEvents.attempts} + 1`,
          })
          .where(eq(stripeEvents.id, event.id));
        return { status: "ignored" as const, messageIds: [] };
      }

      // Confine the handler to this firm like any request, then step back out to record the result.
      await tx.execute(sql`set local role duely_app`);
      await tx.execute(sql`select set_config('app.tenant_id', ${firm.id}, true)`);
      const messageIds = await handleEvent(tx, firm.id, event);
      await tx.execute(sql`reset role`);

      await tx
        .update(stripeEvents)
        .set({
          tenantId: firm.id,
          processedAt: realNow(),
          error: null,
          attempts: sql`${stripeEvents.attempts} + 1`,
        })
        .where(eq(stripeEvents.id, event.id));
      return { status: "processed" as const, messageIds };
    });
  } catch (error) {
    await systemDb
      .update(stripeEvents)
      .set({
        error: error instanceof Error ? error.message.slice(0, 500) : "error",
        attempts: sql`${stripeEvents.attempts} + 1`,
      })
      .where(eq(stripeEvents.id, event.id));
    throw error;
  }
}

async function handleEvent(tx: Tx, tenantId: string, event: StripeEvent): Promise<string[]> {
  const object = event.data.object;
  const actor: Actor = { tenantId, type: "stripe", id: event.id };
  switch (event.type) {
    case "account.updated": {
      await tx
        .update(firms)
        .set({
          stripeChargesEnabled: Boolean(object.charges_enabled),
          stripePayoutsEnabled: Boolean(object.payouts_enabled),
          stripeDetailsSubmitted: Boolean(object.details_submitted),
          updatedAt: realNow(),
        })
        .where(eq(firms.id, tenantId));
      await audit(
        tx,
        actor,
        "stripe.account_updated",
        { type: "firm", id: tenantId },
        { after: { chargesEnabled: Boolean(object.charges_enabled) } },
      );
      return [];
    }
    case "payment_intent.processing":
      return paymentProcessing(tx, actor, object);
    case "payment_intent.succeeded":
      return paymentSucceeded(tx, actor, object);
    case "payment_intent.payment_failed":
      return paymentFailed(tx, actor, object);
    case "refund.created":
      return refundCreated(tx, actor, object);
    case "charge.dispute.created":
      return disputeCreated(tx, actor, object);
    case "charge.dispute.closed":
      return disputeClosed(tx, actor, object);
    default:
      return []; // recorded, nothing to do
  }
}

async function findPayment(tx: Tx, intentId: string) {
  const [p] = await tx.select().from(payments).where(eq(payments.stripePaymentIntentId, intentId));
  return p;
}

async function lockInvoice(tx: Tx, invoiceId: unknown) {
  if (typeof invoiceId !== "string") return undefined;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  return inv;
}

/** ACH is the only method that passes through `processing`. */
async function paymentProcessing(tx: Tx, actor: Actor, pi: Record<string, any>) {
  const invoice = await lockInvoice(tx, pi.metadata?.invoice_id);
  if (!invoice) return [];
  if (await findPayment(tx, pi.id)) return []; // out of order or repeated: never downgrade
  await tx.insert(payments).values({
    tenantId: actor.tenantId,
    invoiceId: invoice.id,
    stripePaymentIntentId: pi.id,
    method: "ach",
    status: "processing",
    amountMinor: pi.amount,
    applicationFeeMinor: pi.application_fee_amount ?? 0,
  });
  if ((OPEN_STATUSES as readonly string[]).includes(invoice.status)) {
    await tx.update(invoices).set({ paymentProcessing: true }).where(eq(invoices.id, invoice.id));
  }
  await audit(
    tx,
    actor,
    "payment.processing",
    { type: "invoice", id: invoice.id },
    { after: { intent: pi.id } },
  );
  return [];
}

async function paymentSucceeded(tx: Tx, actor: Actor, pi: Record<string, any>) {
  const invoice = await lockInvoice(tx, pi.metadata?.invoice_id);
  if (!invoice) return [];
  const existing = await findPayment(tx, pi.id);
  if (existing?.status === "succeeded") return [];

  const amount: number = pi.amount_received ?? pi.amount;
  const now = realNow();
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : null;
  let paymentId: string;
  if (existing) {
    await tx
      .update(payments)
      .set({ status: "succeeded", succeededAt: now, stripeChargeId: chargeId })
      .where(eq(payments.id, existing.id));
    paymentId = existing.id;
  } else {
    const types: string[] = pi.payment_method_types ?? ["card"];
    const [p] = await tx
      .insert(payments)
      .values({
        tenantId: actor.tenantId,
        invoiceId: invoice.id,
        stripePaymentIntentId: pi.id,
        method: types.length === 1 && types[0] === "us_bank_account" ? "ach" : "card",
        status: "succeeded",
        amountMinor: amount,
        applicationFeeMinor: pi.application_fee_amount ?? 0,
        stripeChargeId: chargeId,
        succeededAt: now,
      })
      .returning({ id: payments.id });
    paymentId = p!.id;
  }

  const paidMinor = invoice.paidMinor + amount;
  await tx
    .update(invoices)
    .set({ paidMinor, paymentProcessing: false, updatedAt: sql`now()` })
    .where(eq(invoices.id, invoice.id));

  if (!(OPEN_STATUSES as readonly string[]).includes(invoice.status)) {
    // Money arrived for an invoice that is already paid or void. The ledger keeps it; a person decides what to do.
    await audit(
      tx,
      actor,
      "payment.unexpected",
      { type: "invoice", id: invoice.id },
      { after: { status: invoice.status, amountMinor: amount, intent: pi.id } },
    );
    return [];
  }

  const { now: firmNow, today } = await firmClock(tx, actor.tenantId);
  const [promise] = await tx
    .select({ id: promises.id })
    .from(promises)
    .where(and(eq(promises.invoiceId, invoice.id), eq(promises.status, "active")));
  transition({ status: invoice.status }, "PAYMENT_SUCCEEDED", {
    ...baseContext(invoice, today),
    paidMinor,
    hasActivePromise: Boolean(promise),
  });
  await tx
    .update(invoices)
    .set({ status: "paid", paidAt: firmNow })
    .where(eq(invoices.id, invoice.id));
  if (promise)
    await tx
      .update(promises)
      .set({ status: "kept", resolvedAt: now })
      .where(eq(promises.id, promise.id));
  await audit(
    tx,
    actor,
    "payment.succeeded",
    { type: "invoice", id: invoice.id },
    { after: { amountMinor: amount, intent: pi.id, paidMinor } },
  );

  // send_receipt effect (D22): outbox rows now, queue after commit.
  const recipients = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, invoice.clientId),
        eq(contacts.receivesInvoices, true),
        eq(contacts.emailStatus, "ok"),
      ),
    );
  const ids: string[] = [];
  for (const contact of recipients) {
    const [m] = await tx
      .insert(messages)
      .values({
        tenantId: actor.tenantId,
        clientId: invoice.clientId,
        invoiceId: invoice.id,
        contactId: contact.id,
        direction: "out",
        kind: "receipt",
        status: "queued",
        dedupeKey: `receipt:${paymentId}:${contact.id}`,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (m) ids.push(m.id);
  }
  return ids;
}

async function paymentFailed(tx: Tx, actor: Actor, pi: Record<string, any>) {
  const invoice = await lockInvoice(tx, pi.metadata?.invoice_id);
  if (!invoice) return [];
  const existing = await findPayment(tx, pi.id);
  if (existing?.status === "succeeded") return []; // a late failure event never undoes a success
  const reason: string =
    pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? "payment_failed";
  if (existing) {
    if (existing.status === "failed") return [];
    await tx
      .update(payments)
      .set({ status: "failed", failureReason: reason })
      .where(eq(payments.id, existing.id));
  } else {
    await tx.insert(payments).values({
      tenantId: actor.tenantId,
      invoiceId: invoice.id,
      stripePaymentIntentId: pi.id,
      method:
        (pi.payment_method_types ?? ["card"]).length === 1 &&
        pi.payment_method_types?.[0] === "us_bank_account"
          ? "ach"
          : "card",
      status: "failed",
      amountMinor: pi.amount,
      applicationFeeMinor: pi.application_fee_amount ?? 0,
      failureReason: reason,
    });
  }
  await tx.update(invoices).set({ paymentProcessing: false }).where(eq(invoices.id, invoice.id));
  await audit(
    tx,
    actor,
    "payment.failed",
    { type: "invoice", id: invoice.id },
    { after: { intent: pi.id, reason } },
  );
  return [];
}

async function refundCreated(tx: Tx, actor: Actor, refund: Record<string, any>) {
  if (refund.status === "failed" || refund.status === "canceled") return [];
  const payment =
    typeof refund.payment_intent === "string"
      ? await findPayment(tx, refund.payment_intent)
      : undefined;
  if (!payment || payment.status !== "succeeded")
    throw new EventNotReady("refund before its payment");

  const [inserted] = await tx
    .insert(refunds)
    .values({
      tenantId: actor.tenantId,
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      stripeRefundId: refund.id,
      amountMinor: refund.amount,
      reason: refund.reason ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: refunds.id });
  if (!inserted) return []; // already applied
  // Refunds adjust `refunded_minor` only; the invoice stays paid in v1 (SPEC 3.1).
  await tx
    .update(invoices)
    .set({ refundedMinor: sql`${invoices.refundedMinor} + ${refund.amount}` })
    .where(eq(invoices.id, payment.invoiceId));
  await audit(
    tx,
    actor,
    "payment.refunded",
    { type: "invoice", id: payment.invoiceId },
    { after: { amountMinor: refund.amount, refund: refund.id } },
  );
  return [];
}

async function disputeCreated(tx: Tx, actor: Actor, dispute: Record<string, any>) {
  const payment =
    typeof dispute.payment_intent === "string"
      ? await findPayment(tx, dispute.payment_intent)
      : undefined;
  if (!payment) throw new EventNotReady("dispute before its payment");
  const invoice = await lockInvoice(tx, payment.invoiceId);
  const [inserted] = await tx
    .insert(disputes)
    .values({
      tenantId: actor.tenantId,
      invoiceId: payment.invoiceId,
      reason: String(dispute.reason ?? "chargeback"),
      source: "stripe",
      stripeDisputeId: dispute.id,
      // A chargeback happens on a paid invoice, which stays paid; the dispute row and audit trail carry it.
      priorStatus: invoice!.status,
    })
    .onConflictDoNothing()
    .returning({ id: disputes.id });
  if (!inserted) return [];
  await audit(
    tx,
    actor,
    "dispute.opened",
    { type: "invoice", id: payment.invoiceId },
    { after: { source: "stripe", dispute: dispute.id, amountMinor: dispute.amount } },
  );
  return [];
}

async function disputeClosed(tx: Tx, actor: Actor, dispute: Record<string, any>) {
  const [row] = await tx.select().from(disputes).where(eq(disputes.stripeDisputeId, dispute.id));
  if (!row) throw new EventNotReady("dispute close before open");
  if (row.status !== "open") return [];
  const won = dispute.status === "won";
  await tx
    .update(disputes)
    .set({
      status: won ? "resolved" : "upheld",
      resolvedAt: realNow(),
      resolutionNote: `Stripe: ${String(dispute.status)}`,
    })
    .where(eq(disputes.id, row.id));
  await audit(
    tx,
    actor,
    won ? "dispute.resolved" : "dispute.upheld",
    { type: "invoice", id: row.invoiceId },
    { after: { dispute: dispute.id, outcome: dispute.status } },
  );
  return [];
}
