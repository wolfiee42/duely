import { addDays } from "@repo/clock";
import { withTenant, type Db } from "@repo/db";
import { contacts, invoiceItems, invoiceSequences, invoices, messages } from "@repo/db/schema";
import { transition } from "@repo/domain";
import { DomainError } from "@repo/domain";
import { and, count, eq, sql } from "drizzle-orm";

import { audit, type Actor } from "./audit";
import { firmClock } from "./firm-clock";
import { baseContext } from "./invoices";
import { applyJobEffects } from "./reminders";
import { refreshRisk } from "./risk";
import { newToken } from "./tokens";

/**
 * SPEC 3.1 SEND, in one short transaction of DB work only (D22): number, freeze, status, and one
 * queued outbox message per contact that receives invoices. The caller enqueues `send_message`
 * for the returned ids after this commits.
 */
export async function sendInvoice(db: Db, actor: Actor, invoiceId: string) {
  return withTenant(db, actor.tenantId, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");
    if (!invoice) throw new DomainError("invoice.not_found", "not_found", "Invoice not found.");

    const { firm, now, today } = await firmClock(tx, actor.tenantId);
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
    const [{ n: itemCount } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId));

    // Throws invoice.invalid_transition (409) or a guard failure (422).
    const next = transition({ status: invoice.status }, "SEND", {
      ...baseContext(invoice, today),
      itemCount,
      chargesEnabled: firm.stripeChargesEnabled,
      hasInvoiceContact: recipients.length > 0,
    });

    await tx.insert(invoiceSequences).values({ tenantId: actor.tenantId }).onConflictDoNothing();
    const [seq] = await tx
      .update(invoiceSequences)
      .set({ nextNumber: sql`${invoiceSequences.nextNumber} + 1` })
      .where(eq(invoiceSequences.tenantId, actor.tenantId))
      .returning({ issued: sql<number>`${invoiceSequences.nextNumber} - 1` });
    const number = `${firm.invoicePrefix}${String(seq!.issued).padStart(4, "0")}`;
    const dueDate = invoice.dueDate ?? addDays(today, firm.defaultTermsDays);

    await tx
      .update(invoices)
      .set({
        status: "sent",
        number,
        issueDate: today,
        dueDate,
        sentAt: now,
        updatedAt: sql`now()`,
      })
      .where(eq(invoices.id, invoiceId));

    await applyJobEffects(tx, actor.tenantId, invoiceId, next.effects);
    await refreshRisk(tx, actor.tenantId, invoiceId);

    const messageIds: string[] = [];
    for (const contact of recipients) {
      const [message] = await tx
        .insert(messages)
        .values({
          tenantId: actor.tenantId,
          clientId: invoice.clientId,
          invoiceId,
          contactId: contact.id,
          direction: "out",
          kind: "invoice",
          status: "queued",
          replyToken: newToken().slice(0, 24),
          dedupeKey: `invoice:${invoiceId}:${contact.id}`,
        })
        .returning({ id: messages.id });
      messageIds.push(message!.id);
    }
    await audit(
      tx,
      actor,
      "invoice.sent",
      { type: "invoice", id: invoiceId },
      {
        after: { number, dueDate, totalMinor: invoice.totalMinor, recipients: recipients.length },
      },
    );
    return { number, dueDate, messageIds };
  });
}
