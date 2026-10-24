import { withTenant, type Db } from "@repo/db";
import { firms, invoices, payments } from "@repo/db/schema";
import { DomainError, platformFee } from "@repo/domain";
import type { StripeClient } from "@repo/stripe";
import { and, desc, eq } from "drizzle-orm";

import type { WithDb } from "../db";
import type { PortalIdentity } from "./portal-auth";

const PAYABLE = ["sent", "viewed", "overdue", "promised", "disputed"];

/** What the payer owes now, and where it goes. DB work only; no network (D22). */
async function prepare(db: Db, tenantId: string, contact: PortalIdentity, invoiceId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.clientId, contact.clientId)));
    if (!invoice || invoice.status === "draft")
      throw new DomainError("invoice.not_found", "not_found", "Invoice not found.");
    if (!PAYABLE.includes(invoice.status)) {
      throw new DomainError(
        "invoice.not_payable",
        "conflict",
        invoice.status === "paid" ? "This invoice is already paid." : "This invoice can't be paid.",
      );
    }
    // An ACH payment already in flight: a second attempt would double-charge.
    if (invoice.paymentProcessing) {
      throw new DomainError(
        "invoice.payment_in_progress",
        "conflict",
        "A bank payment is already on its way.",
      );
    }
    const [firm] = await tx
      .select({
        accountId: firms.stripeAccountId,
        charges: firms.stripeChargesEnabled,
        feeBps: firms.platformFeeBps,
      })
      .from(firms)
      .where(eq(firms.id, tenantId));
    if (!firm?.accountId || !firm.charges) {
      throw new DomainError(
        "firm.payments_unavailable",
        "unprocessable",
        "Online payment isn't available for this invoice.",
      );
    }
    // D3: no partial payments in v1, so the amount is always the full balance, computed here and never taken from the client.
    const amountMinor = invoice.totalMinor - invoice.paidMinor;
    if (amountMinor <= 0)
      throw new DomainError("invoice.not_payable", "conflict", "Nothing is owed on this invoice.");
    return {
      accountId: firm.accountId,
      amountMinor,
      applicationFeeMinor: platformFee(amountMinor, firm.feeBps),
      number: invoice.number,
    };
  });
}

/**
 * SPEC 5.1/5.2. A PaymentIntent on the firm's connected account with the platform's application fee.
 * No ledger row is written here: the webhook is the only thing that records money (D12).
 */
export async function createPayment(
  withDb: WithDb,
  stripe: StripeClient,
  tenantId: string,
  contact: PortalIdentity,
  invoiceId: string,
  idempotencyKey: string,
) {
  const p = await withDb((db) => prepare(db, tenantId, contact, invoiceId));
  const intent = await stripe.createPaymentIntent({
    accountId: p.accountId,
    amountMinor: p.amountMinor,
    applicationFeeMinor: p.applicationFeeMinor,
    methods: ["card", "us_bank_account"],
    metadata: { invoice_id: invoiceId, tenant_id: tenantId, contact_id: contact.contactId },
    idempotencyKey: `${invoiceId}:${idempotencyKey}`,
  });
  return {
    clientSecret: intent.clientSecret,
    stripeAccountId: p.accountId,
    amountMinor: p.amountMinor,
  };
}

export async function listReceipts(db: Db, tenantId: string, contact: PortalIdentity) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        paymentId: payments.id,
        invoiceId: invoices.id,
        invoiceNumber: invoices.number,
        amountMinor: payments.amountMinor,
        method: payments.method,
        paidAt: payments.succeededAt,
      })
      .from(payments)
      .innerJoin(
        invoices,
        and(eq(invoices.tenantId, payments.tenantId), eq(invoices.id, payments.invoiceId)),
      )
      .where(and(eq(invoices.clientId, contact.clientId), eq(payments.status, "succeeded")))
      .orderBy(desc(payments.succeededAt)),
  );
}
