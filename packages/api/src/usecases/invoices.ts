import { withTenant, type Db, type Tx } from "@repo/db";
import {
  auditLog,
  clients,
  disputes,
  invoiceItems,
  invoices,
  messages,
  payments,
  promises,
} from "@repo/db/schema";
import {
  DomainError,
  effectiveStatus,
  invoiceTotals,
  parseQuantity,
  transition,
  type InvoiceStatus,
} from "@repo/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { audit, type Actor } from "./audit";
import { firmClock } from "./firm-clock";
import { applyJobEffects } from "./reminders";

export interface ItemInput {
  description: string;
  /** User text such as "2" or "1.5"; parsed to thousandths. */
  quantity: string;
  unitAmountMinor: number;
}

export interface DraftInput {
  clientId: string;
  dueDate?: string | null;
  notes?: string | null;
  items: ItemInput[];
}

const MAX_ITEMS = 100;
const MAX_UNIT_MINOR = 100_000_000_00; // $100M

const notFound = () => new DomainError("invoice.not_found", "not_found", "Invoice not found.");

function priceItems(items: ItemInput[]) {
  if (items.length > MAX_ITEMS)
    throw new DomainError("invoice.too_many_items", "validation", "Too many line items.");
  const lines = items.map((item, i) => {
    const quantityMilli = parseQuantity(item.quantity);
    if (quantityMilli === null) {
      throw new DomainError(
        "invoice.invalid_quantity",
        "validation",
        `Line ${i + 1}: enter a quantity above zero, up to 3 decimals.`,
      );
    }
    if (
      !Number.isSafeInteger(item.unitAmountMinor) ||
      item.unitAmountMinor < 0 ||
      item.unitAmountMinor > MAX_UNIT_MINOR
    ) {
      throw new DomainError(
        "invoice.invalid_amount",
        "validation",
        `Line ${i + 1}: enter a valid price.`,
      );
    }
    return { quantityMilli, unitAmountMinor: item.unitAmountMinor };
  });
  const totals = invoiceTotals(lines);
  return { lines, totals };
}

async function requireClient(tx: Tx, clientId: string) {
  const [client] = await tx
    .select({ id: clients.id, archivedAt: clients.archivedAt })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!client) throw new DomainError("client.not_found", "not_found", "Client not found.");
  if (client.archivedAt)
    throw new DomainError("client.archived", "unprocessable", "That client is archived.");
}

async function writeItems(tx: Tx, tenantId: string, invoiceId: string, items: ItemInput[]) {
  const { lines, totals } = priceItems(items);
  await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
  if (items.length) {
    await tx.insert(invoiceItems).values(
      items.map((item, i) => ({
        tenantId,
        invoiceId,
        position: i + 1,
        description: item.description,
        quantity: (lines[i]!.quantityMilli / 1000).toFixed(3),
        unitAmountMinor: item.unitAmountMinor,
        amountMinor: totals.lineAmounts[i]!,
      })),
    );
  }
  return totals;
}

export async function createDraft(db: Db, actor: Actor, input: DraftInput) {
  return withTenant(db, actor.tenantId, async (tx) => {
    await requireClient(tx, input.clientId);
    const [invoice] = await tx
      .insert(invoices)
      .values({
        tenantId: actor.tenantId,
        clientId: input.clientId,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: invoices.id });
    const totals = await writeItems(tx, actor.tenantId, invoice!.id, input.items);
    await tx
      .update(invoices)
      .set({ subtotalMinor: totals.subtotalMinor, totalMinor: totals.totalMinor })
      .where(eq(invoices.id, invoice!.id));
    await audit(
      tx,
      actor,
      "invoice.created",
      { type: "invoice", id: invoice!.id },
      { after: { clientId: input.clientId, totalMinor: totals.totalMinor } },
    );
    return { id: invoice!.id, totalMinor: totals.totalMinor };
  });
}

export async function updateDraft(db: Db, actor: Actor, invoiceId: string, input: DraftInput) {
  return withTenant(db, actor.tenantId, async (tx) => {
    // Lock the row so two edits cannot interleave their delete-and-reinsert of items.
    const [before] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");
    if (!before) throw notFound();
    if (before.status !== "draft")
      throw new DomainError("invoice.not_draft", "conflict", "Only drafts can be edited.");
    await requireClient(tx, input.clientId);
    const totals = await writeItems(tx, actor.tenantId, invoiceId, input.items);
    await tx
      .update(invoices)
      .set({
        clientId: input.clientId,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
        subtotalMinor: totals.subtotalMinor,
        totalMinor: totals.totalMinor,
        updatedAt: sql`now()`,
      })
      .where(eq(invoices.id, invoiceId));
    await audit(
      tx,
      actor,
      "invoice.updated",
      { type: "invoice", id: invoiceId },
      {
        before: { totalMinor: before.totalMinor, clientId: before.clientId },
        after: { totalMinor: totals.totalMinor, clientId: input.clientId },
      },
    );
    return { id: invoiceId, totalMinor: totals.totalMinor };
  });
}

export async function deleteDraft(db: Db, actor: Actor, invoiceId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [row] = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");
    if (!row) throw notFound();
    if (row.status !== "draft")
      throw new DomainError(
        "invoice.not_draft",
        "conflict",
        "Only drafts can be deleted. Void it instead.",
      );
    await tx.delete(invoices).where(eq(invoices.id, invoiceId));
    await audit(tx, actor, "invoice.deleted", { type: "invoice", id: invoiceId });
  });
}

export async function getInvoice(db: Db, tenantId: string, invoiceId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const { today } = await firmClock(tx, tenantId);
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice) throw notFound();
    const [client] = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.id, invoice.clientId));
    const items = await tx
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceItems.position));
    const ledger = await tx
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId))
      .orderBy(asc(payments.createdAt));
    const [activePromise] = await tx
      .select()
      .from(promises)
      .where(and(eq(promises.invoiceId, invoiceId), eq(promises.status, "active")));
    const [openDispute] = await tx
      .select()
      .from(disputes)
      .where(and(eq(disputes.invoiceId, invoiceId), eq(disputes.status, "open")));
    return {
      ...invoice,
      effectiveStatus: effectiveStatus(invoice.status, { today, dueDate: invoice.dueDate }),
      client: client!,
      items,
      payments: ledger,
      activePromise: activePromise ?? null,
      openDispute: openDispute ?? null,
    };
  });
}

export async function listInvoices(
  db: Db,
  tenantId: string,
  opts: { status?: InvoiceStatus; clientId?: string; limit?: number } = {},
) {
  return withTenant(db, tenantId, async (tx) => {
    const { today } = await firmClock(tx, tenantId);
    const rows = await tx
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
        dueDate: invoices.dueDate,
        totalMinor: invoices.totalMinor,
        paidMinor: invoices.paidMinor,
        clientId: invoices.clientId,
        clientName: clients.name,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(
        clients,
        and(eq(clients.tenantId, invoices.tenantId), eq(clients.id, invoices.clientId)),
      )
      .where(and(opts.clientId ? eq(invoices.clientId, opts.clientId) : undefined))
      .orderBy(desc(invoices.createdAt))
      .limit(Math.min(opts.limit ?? 200, 500));
    const withEffective = rows.map((r) => ({
      ...r,
      effectiveStatus: effectiveStatus(r.status, { today, dueDate: r.dueDate }),
    }));
    // Filter on the effective status so "overdue" includes invoices the sweep has not reached yet.
    return opts.status
      ? withEffective.filter((r) => r.effectiveStatus === opts.status)
      : withEffective;
  });
}

export async function voidInvoice(db: Db, actor: Actor, invoiceId: string, reason: string) {
  return withTenant(db, actor.tenantId, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");
    if (!invoice) throw notFound();
    const { now, today } = await firmClock(tx, actor.tenantId);
    const next = transition({ status: invoice.status }, "VOID", baseContext(invoice, today));
    await tx
      .update(invoices)
      .set({ status: "void", voidedAt: now, voidReason: reason, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoiceId));
    await applyJobEffects(tx, actor.tenantId, invoiceId, next.effects);
    await audit(
      tx,
      actor,
      "invoice.voided",
      { type: "invoice", id: invoiceId },
      { before: { status: invoice.status }, after: { reason } },
    );
  });
}

/** The pieces of `InvoiceContext` that come straight from the invoice row; callers add the rest. */
export function baseContext(invoice: typeof invoices.$inferSelect, today: string) {
  return {
    today,
    dueDate: invoice.dueDate,
    firstViewedAt: invoice.firstViewedAt,
    totalMinor: invoice.totalMinor,
    paidMinor: invoice.paidMinor,
    itemCount: 0,
    chargesEnabled: false,
    hasInvoiceContact: false,
    hasActivePromise: false,
    hasOpenDispute: false,
  };
}

/** Audit trail and messages for one invoice, newest first (SPEC 6.2 `invoices.timeline`). */
export async function invoiceTimeline(db: Db, tenantId: string, invoiceId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [exists] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    if (!exists) throw notFound();
    const events = await tx
      .select({
        at: auditLog.createdAt,
        action: auditLog.action,
        actorType: auditLog.actorType,
        summary: auditLog.summary,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, invoiceId)));
    const mail = await tx
      .select({
        at: messages.createdAt,
        kind: messages.kind,
        status: messages.status,
        subject: messages.subject,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(eq(messages.invoiceId, invoiceId));
    return {
      events: events.sort((a, b) => b.at.getTime() - a.at.getTime()),
      messages: mail.sort((a, b) => b.at.getTime() - a.at.getTime()),
    };
  });
}
