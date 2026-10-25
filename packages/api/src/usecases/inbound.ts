import { withSystemTenant, withTenant, type Db } from "@repo/db";
import { contacts, invoices, messages, reviewItems, unroutedInbound } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { parseAddress, replyTokenFrom, stripQuoted } from "@repo/email";
import { and, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";

import { audit, type Actor } from "./audit";

export interface InboundEmail {
  /** The provider's id for this message; the dedupe key. */
  providerId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** When it arrived. Defaults to now; a demo firm passes its own simulated time. */
  receivedAt?: Date;
}

export type InboundResult =
  | { outcome: "duplicate" | "unrouted" }
  | { outcome: "matched" | "unmatched"; messageId: string };

interface Match {
  tenantId: string;
  clientId: string | null;
  invoiceId: string | null;
  contactId: string | null;
}

/**
 * SPEC 4.4 steps 1 to 4. Every inbound mail ends up somewhere a person can see it: attached to an invoice, in a
 * firm's review queue, or (when no firm can be told) in `unrouted_inbound`. Nothing is dropped (FR-8.8).
 */
export async function receiveInboundEmail(
  systemDb: Db,
  mail: InboundEmail,
): Promise<InboundResult> {
  const from = parseAddress(mail.from);
  const stripped = stripQuoted(mail.text);

  const [seen] = await systemDb
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.providerMessageId, mail.providerId));
  if (seen) return { outcome: "duplicate" };

  const match = await findMatch(systemDb, mail, from);
  if (!match) {
    const inserted = await systemDb
      .insert(unroutedInbound)
      .values({
        providerMessageId: mail.providerId,
        fromEmail: from,
        subject: mail.subject,
        bodyText: mail.text,
      })
      .onConflictDoNothing()
      .returning({ id: unroutedInbound.id });
    return { outcome: inserted.length ? "unrouted" : "duplicate" };
  }

  const matched = Boolean(match.invoiceId);
  return withSystemTenant(systemDb, match.tenantId, async (tx): Promise<InboundResult> => {
    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: match.tenantId,
        clientId: match.clientId,
        invoiceId: match.invoiceId,
        contactId: match.contactId,
        direction: "in",
        kind: "reply",
        status: matched ? "received" : "unmatched",
        subject: mail.subject,
        bodyText: mail.text,
        bodyStripped: stripped,
        providerMessageId: mail.providerId,
        ...(mail.receivedAt ? { createdAt: mail.receivedAt } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!message) return { outcome: "duplicate" }; // a concurrent delivery of the same webhook won

    // Until replies are read automatically, a person reads each one (FR-12.1).
    await tx.insert(reviewItems).values({
      tenantId: match.tenantId,
      kind: matched ? "low_confidence_reply" : "unmatched_inbound",
      invoiceId: match.invoiceId,
      messageId: message.id,
      payload: { from, reason: matched ? "awaiting_review" : "no_match" },
    });
    await audit(
      tx,
      { tenantId: match.tenantId, type: "contact", id: match.contactId },
      "message.received",
      { type: "message", id: message.id },
      { after: { matched } },
    );
    return { outcome: matched ? "matched" : "unmatched", messageId: message.id };
  });
}

async function findMatch(systemDb: Db, mail: InboundEmail, from: string): Promise<Match | null> {
  // 1. The tokenized reply address names the reminder this answers (FR-8.5).
  const token = replyTokenFrom(mail.to);
  if (token) {
    const [out] = await systemDb
      .select({
        tenantId: messages.tenantId,
        clientId: messages.clientId,
        invoiceId: messages.invoiceId,
        contactId: messages.contactId,
      })
      .from(messages)
      .where(and(eq(messages.replyToken, token), eq(messages.direction, "out")));
    if (out) return out;
  }

  // 2. Otherwise the sender must be a known contact and the subject must name one of their invoices.
  const known = await systemDb
    .select({
      tenantId: contacts.tenantId,
      contactId: contacts.id,
      clientId: contacts.clientId,
    })
    .from(contacts)
    .where(eq(contacts.email, from));
  if (!known.length) return null;

  const named = await systemDb
    .select({
      tenantId: invoices.tenantId,
      invoiceId: invoices.id,
      clientId: invoices.clientId,
    })
    .from(invoices)
    .where(
      and(
        isNotNull(invoices.number),
        inArray(
          invoices.clientId,
          known.map((k) => k.clientId),
        ),
        sql`position(lower(${invoices.number}) in lower(${mail.subject})) > 0`,
      ),
    );
  if (named.length === 1) {
    const hit = named[0]!;
    return {
      tenantId: hit.tenantId,
      clientId: hit.clientId,
      invoiceId: hit.invoiceId,
      contactId: known.find((k) => k.clientId === hit.clientId)?.contactId ?? null,
    };
  }

  // 3. Known sender, no single invoice: it still belongs in that firm's queue, but only if one firm knows them.
  const tenants = new Set(known.map((k) => k.tenantId));
  if (tenants.size === 1) {
    const only = known.length === 1 ? known[0]! : null;
    return {
      tenantId: known[0]!.tenantId,
      clientId: only?.clientId ?? null,
      invoiceId: null,
      contactId: only?.contactId ?? null,
    };
  }
  return null;
}

/** Staff attach an unmatched reply to an invoice (FR-12.2 reassign). The reply then reads like any other. */
export async function assignInbound(db: Db, actor: Actor, itemId: string, invoiceId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [item] = await tx
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.id, itemId))
      .for("update");
    if (!item || item.status !== "open" || item.kind !== "unmatched_inbound" || !item.messageId) {
      throw new DomainError("review.not_found", "not_found", "That item is gone.");
    }
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice || invoice.status === "draft") {
      throw new DomainError("invoice.not_found", "not_found", "Invoice not found.");
    }
    const [message] = await tx.select().from(messages).where(eq(messages.id, item.messageId));
    // Prefer the sender's own contact record at that client.
    const sender = String((item.payload as { from?: string }).from ?? "");
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.clientId, invoice.clientId), ilike(contacts.email, sender)));
    await tx
      .update(messages)
      .set({
        status: "received",
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        contactId: contact?.id ?? message?.contactId ?? null,
      })
      .where(eq(messages.id, item.messageId));
    await tx
      .update(reviewItems)
      .set({
        kind: "low_confidence_reply",
        invoiceId: invoice.id,
        payload: { ...(item.payload as object), reason: "assigned_by_staff" },
      })
      .where(eq(reviewItems.id, itemId));
    await audit(
      tx,
      actor,
      "review.inbound_assigned",
      { type: "message", id: item.messageId },
      {
        after: { invoiceId: invoice.id },
      },
    );
  });
}
