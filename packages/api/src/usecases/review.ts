import { realNow } from "@repo/clock";
import { withTenant, type Db } from "@repo/db";
import { clients, contacts, invoices, messages, reminderJobs, reviewItems } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { and, desc, eq } from "drizzle-orm";

import { audit, type Actor } from "./audit";
import type { Classification } from "./classify";
import { createPromise, openDispute } from "./promises-disputes";
import { replanInvoiceJobs } from "./reminders";

const notFound = () => new DomainError("review.not_found", "not_found", "That item is gone.");
const REMINDABLE = ["sent", "viewed", "overdue"];

/** The review queue (FR-12.1): everything waiting on a person, newest first. */
export async function listReviewItems(db: Db, tenantId: string, status: "open" | "all" = "open") {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        item: reviewItems,
        number: invoices.number,
        invoiceStatus: invoices.status,
        clientName: clients.name,
        subject: messages.subject,
        body: messages.bodyText,
        messageStatus: messages.status,
        to: contacts.email,
      })
      .from(reviewItems)
      .leftJoin(invoices, eq(invoices.id, reviewItems.invoiceId))
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .leftJoin(messages, eq(messages.id, reviewItems.messageId))
      .leftJoin(contacts, eq(contacts.id, messages.contactId))
      .where(status === "open" ? eq(reviewItems.status, "open") : undefined)
      .orderBy(desc(reviewItems.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.item.id,
      kind: r.item.kind,
      status: r.item.status,
      createdAt: r.item.createdAt,
      payload: r.item.payload,
      invoiceId: r.item.invoiceId,
      messageId: r.item.messageId,
      invoiceNumber: r.number,
      clientName: r.clientName,
      to: r.to,
      subject: r.subject,
      body: r.body,
    }));
  });
}

export async function countOpenReviewItems(db: Db, tenantId: string) {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select({ id: reviewItems.id }).from(reviewItems).where(eq(reviewItems.status, "open")),
  );
  return rows.length;
}

async function openDraftItem(tx: Parameters<Parameters<typeof withTenant>[2]>[0], itemId: string) {
  const [item] = await tx
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.id, itemId))
    .for("update");
  if (!item || item.status !== "open" || item.kind !== "draft_approval" || !item.messageId) {
    throw notFound();
  }
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, item.messageId))
    .for("update");
  if (!message || message.status !== "draft") throw notFound();
  return { item, message };
}

/**
 * Approve a drafted reminder, optionally with the reviewer's edits (FR-9.12, 12.2). The message moves to
 * `approved` and its job to `enqueued`; the caller puts `send_message` on the queue after this commits. The
 * send-time re-check still applies, so approving a reminder for an invoice that has since been paid sends nothing.
 */
export async function approveDraft(
  db: Db,
  actor: Actor,
  itemId: string,
  edits?: { subject: string; body: string },
) {
  const result = await withTenant(db, actor.tenantId, async (tx) => {
    const { item, message } = await openDraftItem(tx, itemId);
    const [invoice] = item.invoiceId
      ? await tx.select().from(invoices).where(eq(invoices.id, item.invoiceId))
      : [];
    if (!invoice || !REMINDABLE.includes(invoice.status)) {
      // Nothing left to remind about: close the item and the draft rather than failing the click.
      await tx.update(messages).set({ status: "cancelled" }).where(eq(messages.id, message.id));
      await tx
        .update(reviewItems)
        .set({ status: "dismissed", resolvedBy: actor.id, resolvedAt: realNow() })
        .where(eq(reviewItems.id, itemId));
      return { closed: true as const };
    }

    const edited = Boolean(
      edits && (edits.subject !== message.subject || edits.body !== message.bodyText),
    );
    await tx
      .update(messages)
      .set({
        status: "approved",
        approvedBy: actor.id,
        ...(edited ? { subject: edits!.subject, bodyText: edits!.body, generatedBy: "human" } : {}),
      })
      .where(eq(messages.id, message.id));
    if (message.jobId) {
      await tx
        .update(reminderJobs)
        .set({ status: "enqueued" })
        .where(
          and(eq(reminderJobs.id, message.jobId), eq(reminderJobs.status, "awaiting_approval")),
        );
    }
    await tx
      .update(reviewItems)
      .set({
        status: edited ? "edited" : "approved",
        resolvedBy: actor.id,
        resolvedAt: realNow(),
      })
      .where(eq(reviewItems.id, itemId));
    await audit(
      tx,
      actor,
      edited ? "review.draft_edited_approved" : "review.draft_approved",
      { type: "message", id: message.id },
      { after: { invoiceId: invoice.id } },
    );
    return { closed: false as const, messageId: message.id };
  });
  // Thrown after commit, so closing the stale item is kept.
  if (result.closed) {
    throw new DomainError(
      "review.no_longer_needed",
      "conflict",
      "That invoice no longer needs a reminder.",
    );
  }
  return { messageId: result.messageId };
}

/** Drop this reminder: the step is skipped for this invoice and nothing is sent. */
export async function rejectDraft(db: Db, actor: Actor, itemId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const { item, message } = await openDraftItem(tx, itemId);
    await tx.update(messages).set({ status: "cancelled" }).where(eq(messages.id, message.id));
    if (message.jobId) {
      await tx
        .update(reminderJobs)
        .set({ status: "cancelled" })
        .where(
          and(eq(reminderJobs.id, message.jobId), eq(reminderJobs.status, "awaiting_approval")),
        );
    }
    await tx
      .update(reviewItems)
      .set({ status: "rejected", resolvedBy: actor.id, resolvedAt: realNow() })
      .where(eq(reviewItems.id, item.id));
    await audit(tx, actor, "review.draft_rejected", { type: "message", id: message.id });
  });
}

/** Acknowledge an item that needs no further action (a dead job, a claim already looked into). */
export async function dismissReviewItem(db: Db, actor: Actor, itemId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [item] = await tx
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.id, itemId))
      .for("update");
    if (!item || item.status !== "open") throw notFound();
    if (item.kind === "draft_approval") {
      throw new DomainError(
        "review.use_approve_or_reject",
        "validation",
        "Approve or reject the draft.",
      );
    }
    await tx
      .update(reviewItems)
      .set({ status: "dismissed", resolvedBy: actor.id, resolvedAt: realNow() })
      .where(eq(reviewItems.id, itemId));
    // "They haven't paid after all": the pause that came with the claim ends and reminders resume.
    if (item.kind === "already_paid_claim" && item.invoiceId) {
      await replanInvoiceJobs(tx, actor.tenantId, item.invoiceId);
    }
    await audit(
      tx,
      actor,
      "review.dismissed",
      { type: "review_item", id: itemId },
      { after: { kind: item.kind } },
    );
  });
}

/**
 * Act on what the classifier read in a reply, after a person has looked at it (FR-12.2). The promise date
 * shown to the reviewer is the one the code verified; they can correct it. It is recorded as coming from
 * the reply, with the words that justified it.
 */
export async function acceptSuggestion(
  db: Db,
  actor: Actor,
  itemId: string,
  edits?: { promisedDate?: string },
) {
  const item = await withTenant(db, actor.tenantId, async (tx) => {
    const [i] = await tx.select().from(reviewItems).where(eq(reviewItems.id, itemId));
    if (
      !i ||
      i.status !== "open" ||
      i.kind !== "low_confidence_reply" ||
      !i.invoiceId ||
      !i.messageId
    ) {
      throw notFound();
    }
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, i.invoiceId));
    return { ...i, clientId: inv?.clientId ?? null };
  });
  const c = (item.payload as { classification?: Classification }).classification;
  if (!c || !["promise", "dispute"].includes(c.label) || !item.clientId) {
    throw new DomainError(
      "review.nothing_to_accept",
      "validation",
      "There is nothing to apply here.",
    );
  }
  const origin = {
    actor,
    source: "ai_reply" as const,
    clientId: item.clientId,
    provenance: { messageId: item.messageId!, quote: c.quote, confidence: c.confidence },
  };
  if (c.label === "promise") {
    const date = edits?.promisedDate ?? c.promisedDate;
    if (!date) {
      throw new DomainError("review.needs_date", "validation", "Choose the date they promised.");
    }
    await createPromise(db, origin, item.invoiceId!, date);
  } else {
    await openDispute(db, origin, item.invoiceId!, {
      reason: "Disputed by the client by email",
      detail: c.quote,
    });
  }
  await withTenant(db, actor.tenantId, async (tx) => {
    await tx
      .update(reviewItems)
      .set({ status: "approved", resolvedBy: actor.id, resolvedAt: realNow() })
      .where(eq(reviewItems.id, itemId));
    await audit(
      tx,
      actor,
      "review.suggestion_accepted",
      { type: "message", id: item.messageId },
      {
        after: { label: c.label, edited: Boolean(edits?.promisedDate) },
      },
    );
  });
}
