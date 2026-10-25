import { withTenant, type Db, type Tx } from "@repo/db";
import {
  auditLog,
  clients,
  contacts,
  disputes,
  documents,
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

export async function createDraft(
  db: Db,
  actor: Actor,
  input: DraftInput,
  /** Set when the draft was read from an uploaded file rather than typed in. */
  provenance?:
    | { source: "ai_extraction"; documentId: string }
    | { source: "csv_import"; externalRef: string },
) {
  return withTenant(db, actor.tenantId, async (tx) => {
    await requireClient(tx, input.clientId);
    const [invoice] = await tx
      .insert(invoices)
      .values({
        tenantId: actor.tenantId,
        clientId: input.clientId,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
        source: provenance?.source ?? "manual",
        externalRef: provenance?.source === "csv_import" ? provenance.externalRef : null,
      })
      .returning({ id: invoices.id });
    if (provenance?.source === "ai_extraction") {
      await tx
        .update(documents)
        .set({ invoiceId: invoice!.id })
        .where(eq(documents.id, provenance.documentId));
    }
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
        riskLevel: invoices.riskLevel,
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
export interface TimelineEntry {
  at: Date;
  kind: "invoice" | "email" | "reply" | "promise" | "dispute" | "payment";
  title: string;
  detail: string | null;
}

const usd = (minor: unknown) =>
  typeof minor === "number"
    ? `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : null;

type Summary = { after?: Record<string, unknown>; before?: Record<string, unknown> } | null;

/** Plain-language lines for the audit actions that matter to someone following an invoice. Others stay out of sight. */
function auditEntry(action: string, summary: Summary): Omit<TimelineEntry, "at"> | null {
  const after = summary?.after ?? {};
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (action) {
    case "invoice.created":
      return { kind: "invoice", title: "Draft created", detail: null };
    case "invoice.sent":
      return { kind: "invoice", title: "Invoice sent", detail: usd(after.totalMinor) };
    case "invoice.viewed":
      return { kind: "invoice", title: "Client opened the invoice", detail: null };
    case "invoice.voided":
      return { kind: "invoice", title: "Invoice voided", detail: text(after.reason) };
    case "promise.created":
      return {
        kind: "promise",
        title: `Promise to pay by ${text(after.promisedDate) ?? "a set date"}`,
        detail:
          text(after.source) === "ai_reply"
            ? "From the client's reply"
            : text(after.source) === "portal"
              ? "From the client portal"
              : "Recorded by your team",
      };
    case "promise.cancelled":
      return { kind: "promise", title: "Promise cancelled", detail: null };
    case "promise.broken":
      return { kind: "promise", title: "Promise broken", detail: "Reminders resume" };
    case "dispute.opened":
      return { kind: "dispute", title: "Dispute opened", detail: text(after.reason) };
    case "dispute.resolved":
      return { kind: "dispute", title: "Dispute resolved", detail: text(after.note) };
    case "dispute.upheld":
      return { kind: "dispute", title: "Dispute upheld", detail: text(after.note) };
    case "payment.succeeded":
      return { kind: "payment", title: "Payment received", detail: usd(after.amountMinor) };
    case "payment.failed":
      return { kind: "payment", title: "Payment failed", detail: text(after.reason) };
    case "payment.refunded":
      return { kind: "payment", title: "Refund issued", detail: usd(after.amountMinor) };
    case "reminder.escalated":
      return { kind: "email", title: "Escalated step reached", detail: null };
    default:
      return null;
  }
}

/** One ordered story of an invoice: what happened, what we sent, what they said, oldest first (FR-12.4). */
export async function invoiceTimeline(db: Db, tenantId: string, invoiceId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice) throw notFound();
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
        direction: messages.direction,
        kind: messages.kind,
        status: messages.status,
        subject: messages.subject,
        sentAt: messages.sentAt,
        stripped: messages.bodyStripped,
        to: contacts.email,
      })
      .from(messages)
      .leftJoin(contacts, eq(contacts.id, messages.contactId))
      .where(eq(messages.invoiceId, invoiceId));

    const entries: TimelineEntry[] = [];
    for (const e of events) {
      const line = auditEntry(e.action, e.summary as Summary);
      if (line) entries.push({ at: e.at, ...line });
    }
    if (invoice.firstViewedAt && !events.some((e) => e.action === "invoice.viewed")) {
      entries.push({
        at: invoice.firstViewedAt,
        kind: "invoice",
        title: "Client opened the invoice",
        detail: null,
      });
    }
    for (const m of mail) {
      const at = m.sentAt ?? m.at;
      const who = m.to ?? "the client";
      if (m.direction === "in") {
        entries.push({
          at,
          kind: "reply",
          title: "Client replied",
          detail: m.stripped?.slice(0, 400) ?? null,
        });
      } else if (m.kind === "reminder") {
        if (m.status === "draft")
          entries.push({
            at,
            kind: "email",
            title: "Reminder drafted",
            detail: "Waiting for your approval",
          });
        else if (m.status === "bounced")
          entries.push({
            at,
            kind: "email",
            title: `Reminder to ${who} bounced`,
            detail: m.subject,
          });
        else if (["sent", "delivered", "complained"].includes(m.status))
          entries.push({ at, kind: "email", title: `Reminder sent to ${who}`, detail: m.subject });
      } else if (m.kind === "invoice" && ["sent", "delivered"].includes(m.status)) {
        entries.push({ at, kind: "email", title: `Invoice emailed to ${who}`, detail: null });
      } else if (m.kind === "receipt" && ["sent", "delivered"].includes(m.status)) {
        entries.push({ at, kind: "email", title: `Receipt emailed to ${who}`, detail: null });
      }
    }
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      entries,
      // Kept for callers that want the raw audit trail.
      events: events.sort((a, b) => b.at.getTime() - a.at.getTime()),
      messages: mail
        .map((m) => ({
          at: m.at,
          kind: m.kind,
          status: m.status,
          subject: m.subject,
          sentAt: m.sentAt,
        }))
        .sort((a, b) => b.at.getTime() - a.at.getTime()),
    };
  });
}
