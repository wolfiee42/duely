import { withSystemTenant, type Db, type Tx } from "@repo/db";
import { clients, contacts, invoices, messages } from "@repo/db/schema";
import type { ResendEvent } from "@repo/email";
import { and, eq, inArray } from "drizzle-orm";

import { audit } from "./audit";
import { cancelInvoiceJobs } from "./reminders";

/** The provider reported something about a message we have not recorded as sent yet. Retry shortly. */
export class MessageNotReady extends Error {
  constructor() {
    super("message not recorded yet");
    this.name = "MessageNotReady";
  }
}

const OPEN = ["sent", "viewed", "overdue", "promised", "disputed"] as const;

/**
 * Stops reminders for a client once none of their contacts can receive them (FR-9.6, 8.4). Called after
 * a contact bounces, complains or unsubscribes. Cancelling is final, which is what a hard bounce should be.
 */
export async function stopRemindersIfUnreachable(tx: Tx, clientId: string) {
  const reachable = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.clientId, clientId),
        eq(contacts.receivesReminders, true),
        eq(contacts.emailStatus, "ok"),
      ),
    );
  if (reachable.length) return 0;
  const open = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), inArray(invoices.status, [...OPEN])));
  for (const invoice of open) await cancelInvoiceJobs(tx, invoice.id);
  return open.length;
}

/**
 * Applies a Resend delivery event (FR-8.4). Idempotent: a repeat finds the state already set. A permanent
 * bounce or a complaint marks the contact, so nothing more is sent to that address.
 */
export async function processEmailEvent(systemDb: Db, event: ResendEvent) {
  const providerId = event.data.email_id;
  const handled = ["email.delivered", "email.bounced", "email.complained"];
  if (!providerId || !handled.includes(event.type)) return "ignored" as const;

  const [found] = await systemDb
    .select({ tenantId: messages.tenantId })
    .from(messages)
    .where(eq(messages.providerMessageId, providerId));
  if (!found) throw new MessageNotReady();

  return withSystemTenant(systemDb, found.tenantId, async (tx) => {
    const actor = { tenantId: found.tenantId, type: "system" as const, id: null };
    const [message] = await tx
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, providerId))
      .for("update");
    if (!message) throw new MessageNotReady();

    if (event.type === "email.delivered") {
      // Delivered never overrides a worse outcome that arrived first.
      if (message.status === "sent") {
        await tx.update(messages).set({ status: "delivered" }).where(eq(messages.id, message.id));
      }
      return "applied" as const;
    }

    const permanent = event.type === "email.complained" || event.data.bounce?.type === "Permanent";
    if (!permanent) return "ignored" as const; // a soft bounce is the provider's to retry
    const status = event.type === "email.complained" ? "complained" : "bounced";
    await tx.update(messages).set({ status }).where(eq(messages.id, message.id));
    if (message.contactId) {
      const [contact] = await tx
        .select({ clientId: contacts.clientId })
        .from(contacts)
        .where(eq(contacts.id, message.contactId));
      await tx
        .update(contacts)
        .set({ emailStatus: status })
        .where(eq(contacts.id, message.contactId));
      if (contact) await stopRemindersIfUnreachable(tx, contact.clientId);
      await audit(
        tx,
        actor,
        `email.${status}`,
        { type: "contact", id: message.contactId },
        {
          after: { messageId: message.id },
        },
      );
    }
    return "applied" as const;
  });
}

/** What the unsubscribe page needs to say, from the token in the email's link. */
export async function unsubscribeTarget(systemDb: Db, token: string) {
  const [row] = await systemDb
    .select({
      tenantId: messages.tenantId,
      contactId: messages.contactId,
      clientName: clients.name,
    })
    .from(messages)
    .leftJoin(clients, eq(clients.id, messages.clientId))
    .where(and(eq(messages.replyToken, token), eq(messages.kind, "reminder")));
  return row?.contactId ? { ...row, contactId: row.contactId } : null;
}

/** FR-8.7: stop reminders to this contact, now. Visible to the firm on the contact and in the audit log. */
export async function unsubscribeFromReminders(systemDb: Db, token: string) {
  const target = await unsubscribeTarget(systemDb, token);
  if (!target) return false;
  await withSystemTenant(systemDb, target.tenantId, async (tx) => {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, target.contactId))
      .for("update");
    if (!contact || !contact.receivesReminders) return;
    await tx.update(contacts).set({ receivesReminders: false }).where(eq(contacts.id, contact.id));
    await stopRemindersIfUnreachable(tx, contact.clientId);
    await audit(
      tx,
      { tenantId: target.tenantId, type: "contact", id: contact.id },
      "contact.unsubscribed",
      { type: "contact", id: contact.id },
    );
  });
  return true;
}
