import { withTenant, type Db } from "@repo/db";
import { disputes, firms, invoiceItems, invoices, payments, promises } from "@repo/db/schema";
import { DomainError, effectiveStatus, transition } from "@repo/domain";
import { and, asc, desc, eq, ne } from "drizzle-orm";

import { audit } from "./audit";
import { firmClock } from "./firm-clock";
import { baseContext } from "./invoices";
import type { PortalIdentity } from "./portal-auth";

const notFound = () => new DomainError("invoice.not_found", "not_found", "Invoice not found.");

/** Drafts are never visible to a client; everything is scoped to the contact's own client. */
const visibleTo = (clientId: string) =>
  and(eq(invoices.clientId, clientId), ne(invoices.status, "draft"));

export async function listPortalInvoices(db: Db, tenantId: string, contact: PortalIdentity) {
  return withTenant(db, tenantId, async (tx) => {
    const { today } = await firmClock(tx, tenantId);
    const rows = await tx
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
        dueDate: invoices.dueDate,
        issueDate: invoices.issueDate,
        totalMinor: invoices.totalMinor,
        paidMinor: invoices.paidMinor,
        paymentProcessing: invoices.paymentProcessing,
      })
      .from(invoices)
      .where(visibleTo(contact.clientId))
      .orderBy(desc(invoices.sentAt));
    return rows.map((r) => ({
      ...r,
      effectiveStatus: effectiveStatus(r.status, { today, dueDate: r.dueDate }),
    }));
  });
}

/** Opening an invoice is the "first view": it stamps `first_viewed_at` and moves `sent` to `viewed` (SPEC 3.1). */
export async function getPortalInvoice(
  db: Db,
  tenantId: string,
  contact: PortalIdentity,
  invoiceId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const { now, today } = await firmClock(tx, tenantId);
    const [found] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), visibleTo(contact.clientId)))
      .for("update");
    if (!found) throw notFound();
    let invoice = found;

    if (!invoice.firstViewedAt && invoice.status !== "paid" && invoice.status !== "void") {
      const next = transition({ status: invoice.status }, "VIEW", baseContext(invoice, today)).state
        .status;
      const [updated] = await tx
        .update(invoices)
        .set({ firstViewedAt: now, status: next })
        .where(eq(invoices.id, invoiceId))
        .returning();
      invoice = updated!;
      await audit(tx, { tenantId, type: "contact", id: contact.contactId }, "invoice.viewed", {
        type: "invoice",
        id: invoiceId,
      });
    }

    const items = await tx
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceItems.position));
    const [firm] = await tx
      .select({
        displayName: firms.displayName,
        legalName: firms.legalName,
        brandPrimary: firms.brandPrimary,
        chargesEnabled: firms.stripeChargesEnabled,
      })
      .from(firms)
      .where(eq(firms.id, tenantId));
    const [promise] = await tx
      .select({ promisedDate: promises.promisedDate })
      .from(promises)
      .where(and(eq(promises.invoiceId, invoiceId), eq(promises.status, "active")));
    const [dispute] = await tx
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.invoiceId, invoiceId), eq(disputes.status, "open")));
    const settled = await tx
      .select({
        id: payments.id,
        amountMinor: payments.amountMinor,
        method: payments.method,
        succeededAt: payments.succeededAt,
      })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "succeeded")))
      .orderBy(asc(payments.createdAt));

    return {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      effectiveStatus: effectiveStatus(invoice.status, { today, dueDate: invoice.dueDate }),
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      notes: invoice.notes,
      subtotalMinor: invoice.subtotalMinor,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      paymentProcessing: invoice.paymentProcessing,
      items: items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unitAmountMinor: i.unitAmountMinor,
        amountMinor: i.amountMinor,
      })),
      firm: {
        displayName: firm!.displayName,
        legalName: firm!.legalName,
        brandPrimary: firm!.brandPrimary,
      },
      canPay:
        firm!.chargesEnabled && ["sent", "viewed", "overdue", "promised"].includes(invoice.status),
      activePromise: promise ?? null,
      hasOpenDispute: Boolean(dispute),
      payments: settled,
    };
  });
}
