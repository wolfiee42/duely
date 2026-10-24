import { addDays, realNow } from "@repo/clock";
import { uniqueViolation, withTenant, type Db, type Tx } from "@repo/db";
import { disputes, invoices, promises } from "@repo/db/schema";
import { DomainError, transition, type InvoiceStatus } from "@repo/domain";
import { and, eq, sql } from "drizzle-orm";

import { audit, type Actor } from "./audit";
import { firmClock } from "./firm-clock";
import { baseContext } from "./invoices";

const MAX_PROMISE_DAYS = 90;

/** Where a promise or dispute came from. Portal actions are scoped to the contact's own client. */
export interface Origin {
  actor: Actor;
  source: "portal" | "manual";
  /** Portal callers: the invoice must belong to this client. */
  clientId?: string;
}

async function loadInvoice(tx: Tx, invoiceId: string, origin: Origin) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  const hidden =
    !invoice ||
    invoice.status === "draft" ||
    (origin.clientId && invoice.clientId !== origin.clientId);
  if (hidden) throw new DomainError("invoice.not_found", "not_found", "Invoice not found.");
  return invoice;
}

async function holds(tx: Tx, invoiceId: string) {
  const [promise] = await tx
    .select({ id: promises.id })
    .from(promises)
    .where(and(eq(promises.invoiceId, invoiceId), eq(promises.status, "active")));
  const [dispute] = await tx
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.invoiceId, invoiceId), eq(disputes.status, "open")));
  return { hasActivePromise: Boolean(promise), hasOpenDispute: Boolean(dispute) };
}

export async function createPromise(
  db: Db,
  origin: Origin,
  invoiceId: string,
  promisedDate: string,
) {
  return withTenant(db, origin.actor.tenantId, async (tx) => {
    const invoice = await loadInvoice(tx, invoiceId, origin);
    const { today } = await firmClock(tx, origin.actor.tenantId);
    if (promisedDate < today)
      throw new DomainError(
        "promise.date_in_past",
        "validation",
        "Choose a date from today onwards.",
      );
    if (promisedDate > addDays(today, MAX_PROMISE_DAYS)) {
      throw new DomainError(
        "promise.date_too_far",
        "validation",
        `Choose a date within ${MAX_PROMISE_DAYS} days.`,
      );
    }

    const held = await holds(tx, invoiceId);
    const next = transition({ status: invoice.status }, "PROMISE_CREATED", {
      ...baseContext(invoice, today),
      ...held,
    });
    try {
      await tx.insert(promises).values({
        tenantId: origin.actor.tenantId,
        invoiceId,
        promisedDate,
        source: origin.source,
        priorStatus: invoice.status,
      });
    } catch (error) {
      if (uniqueViolation(error))
        throw new DomainError("promise.exists", "conflict", "There is already an active promise.");
      throw error;
    }
    await tx
      .update(invoices)
      .set({ status: next.state.status, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoiceId));
    await audit(
      tx,
      origin.actor,
      "promise.created",
      { type: "invoice", id: invoiceId },
      { after: { promisedDate, source: origin.source, priorStatus: invoice.status } },
    );
    return { promisedDate };
  });
}

/** Staff only. The invoice goes back to the status its dates imply (SPEC 3.1). */
export async function cancelPromise(db: Db, actor: Actor, promiseId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [promise] = await tx
      .select()
      .from(promises)
      .where(eq(promises.id, promiseId))
      .for("update");
    if (!promise || promise.status !== "active")
      throw new DomainError("promise.not_found", "not_found", "Promise not found.");
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, promise.invoiceId))
      .for("update");
    const { today } = await firmClock(tx, actor.tenantId);
    const next = transition({ status: invoice!.status }, "PROMISE_CANCELLED", {
      ...baseContext(invoice!, today),
      ...(await holds(tx, invoice!.id)),
    });
    await tx
      .update(promises)
      .set({ status: "cancelled", resolvedAt: realNow() })
      .where(eq(promises.id, promiseId));
    await tx
      .update(invoices)
      .set({ status: next.state.status, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice!.id));
    await audit(
      tx,
      actor,
      "promise.cancelled",
      { type: "invoice", id: invoice!.id },
      { after: { restoredTo: next.state.status } },
    );
  });
}

export async function openDispute(
  db: Db,
  origin: Origin,
  invoiceId: string,
  input: { reason: string; detail?: string | null },
) {
  return withTenant(db, origin.actor.tenantId, async (tx) => {
    const invoice = await loadInvoice(tx, invoiceId, origin);
    const { today } = await firmClock(tx, origin.actor.tenantId);
    const held = await holds(tx, invoiceId);
    const next = transition({ status: invoice.status }, "DISPUTE_OPENED", {
      ...baseContext(invoice, today),
      ...held,
    });

    // A disputed invoice keeps its promise on record; the promise is paused, not cancelled.
    const priorStatus: InvoiceStatus = invoice.status;
    let id: string;
    try {
      const [row] = await tx
        .insert(disputes)
        .values({
          tenantId: origin.actor.tenantId,
          invoiceId,
          reason: input.reason,
          detail: input.detail ?? null,
          source: origin.source,
          priorStatus,
        })
        .returning({ id: disputes.id });
      id = row!.id;
    } catch (error) {
      if (uniqueViolation(error))
        throw new DomainError("invoice.dispute_exists", "conflict", "A dispute is already open.");
      throw error;
    }
    await tx
      .update(invoices)
      .set({ status: next.state.status, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoiceId));
    await audit(
      tx,
      origin.actor,
      "dispute.opened",
      { type: "invoice", id: invoiceId },
      { after: { reason: input.reason, source: origin.source, priorStatus } },
    );
    return { id };
  });
}

/** Staff only. Either outcome releases the hold; `upheld` records that the firm agrees (it can then void). */
export async function resolveDispute(
  db: Db,
  actor: Actor,
  disputeId: string,
  input: { outcome: "resolved" | "upheld"; note: string },
) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [dispute] = await tx
      .select()
      .from(disputes)
      .where(eq(disputes.id, disputeId))
      .for("update");
    if (!dispute || dispute.status !== "open" || dispute.stripeDisputeId) {
      // Stripe chargebacks are closed by Stripe's own event, not by hand.
      throw new DomainError("dispute.not_found", "not_found", "Dispute not found.");
    }
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, dispute.invoiceId))
      .for("update");
    const { today } = await firmClock(tx, actor.tenantId);
    const next = transition({ status: invoice!.status }, "DISPUTE_RESOLVED", {
      ...baseContext(invoice!, today),
      ...(await holds(tx, invoice!.id)),
    });
    await tx
      .update(disputes)
      .set({ status: input.outcome, resolutionNote: input.note, resolvedAt: realNow() })
      .where(eq(disputes.id, disputeId));
    await tx
      .update(invoices)
      .set({ status: next.state.status, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice!.id));
    await audit(
      tx,
      actor,
      `dispute.${input.outcome}`,
      { type: "invoice", id: invoice!.id },
      { after: { restoredTo: next.state.status, note: input.note } },
    );
  });
}
