import { realNow } from "@repo/clock";
import { withSystemTenant, type Db } from "@repo/db";
import {
  clients,
  contacts,
  firms,
  invoices,
  messages,
  payments,
  portalTokens,
} from "@repo/db/schema";
import {
  EmailSendError,
  invoiceEmail,
  magicLinkEmail,
  receiptEmail,
  type EmailClient,
} from "@repo/email";
import { and, eq, lt, sql } from "drizzle-orm";

import { type AppConfig, type QueuePort } from "../services";
import { firmPortalOrigin } from "./domains";
import { LOGIN_LINK_MINUTES } from "./portal-auth";
import { newToken, sha256Hex } from "./tokens";

const INVOICE_LINK_DAYS = 7;

export type DeliverResult = "sent" | "noop" | "cancelled" | "retry";

interface Prepared {
  tenantId: string;
  subject: string;
  html: string;
  text: string;
  to: string;
  from: string;
  replyTo: string | undefined;
  isDemo: boolean;
  idempotencyKey: string;
  /** Rendered with a placeholder link so no live token is kept in the message row. */
  record: { html: string; text: string };
}

/**
 * The `send_message` consumer (D13, D22). Runs as `duely_system`: it reads the message to find its tenant,
 * then does each unit of work inside that tenant. Safe to run twice for the same message:
 *   1. read + re-check + mint link  (transaction)
 *   2. provider call                (no transaction; idempotency key = message id)
 *   3. mark sent                    (transaction)
 * A crash after 2 retries 2 with the same key, so the provider delivers once.
 */
export async function deliverMessage(
  systemDb: Db,
  deps: { email: EmailClient; config: AppConfig },
  messageId: string,
): Promise<DeliverResult> {
  const [found] = await systemDb
    .select({ tenantId: messages.tenantId })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!found) return "noop";
  const tenantId = found.tenantId;

  const prepared = await withSystemTenant(
    systemDb,
    tenantId,
    async (tx): Promise<Prepared | "noop" | "cancelled"> => {
      const [message] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .for("update");
      if (!message || message.status !== "queued") return "noop"; // duplicate delivery of the queue message

      const [firm] = await tx.select().from(firms).where(eq(firms.id, tenantId));
      const [contact] = message.contactId
        ? await tx.select().from(contacts).where(eq(contacts.id, message.contactId))
        : [];
      const [invoice] = message.invoiceId
        ? await tx.select().from(invoices).where(eq(invoices.id, message.invoiceId))
        : [];
      const [client] = message.clientId
        ? await tx.select().from(clients).where(eq(clients.id, message.clientId))
        : [];

      const isLogin =
        message.kind === "notification" && Boolean(message.dedupeKey?.startsWith("login:"));
      // `receipt:{paymentId}:{contactId}`. The amount comes from the ledger, not from the message.
      const paymentId = message.kind === "receipt" ? message.dedupeKey?.split(":")[1] : undefined;
      const [payment] = paymentId
        ? await tx.select().from(payments).where(eq(payments.id, paymentId))
        : [];

      // FR-9.9: re-check at send time. A void invoice or an address that bounced since queueing is dropped.
      const stale =
        !firm ||
        !contact ||
        contact.emailStatus !== "ok" ||
        (message.kind === "receipt" && !payment) ||
        (!isLogin &&
          (!invoice ||
            invoice.status === "void" ||
            (message.kind !== "receipt" && invoice.status === "paid")));
      if (stale) {
        await tx.update(messages).set({ status: "cancelled" }).where(eq(messages.id, messageId));
        return "cancelled";
      }

      const token = newToken();
      await tx.insert(portalTokens).values({
        tenantId,
        contactId: contact.id,
        tokenHash: await sha256Hex(token),
        purpose: isLogin ? "login" : "invoice_link",
        invoiceId: isLogin ? null : invoice!.id,
        expiresAt: new Date(
          realNow().getTime() +
            (isLogin ? LOGIN_LINK_MINUTES * 60_000 : INVOICE_LINK_DAYS * 86_400_000),
        ),
      });

      const origin = await firmPortalOrigin(tx, deps.config.appOrigin, firm);
      const brand = { firmName: firm.displayName, brandColor: firm.brandPrimary };
      const render = (url: string) =>
        isLogin
          ? magicLinkEmail({ ...brand, url, minutes: LOGIN_LINK_MINUTES })
          : message.kind === "receipt"
            ? receiptEmail({
                ...brand,
                clientName: client?.name ?? contact.name,
                number: invoice!.number ?? "",
                amountMinor: payment!.amountMinor,
                portalUrl: url,
              })
            : invoiceEmail({
                ...brand,
                clientName: client?.name ?? contact.name,
                number: invoice!.number ?? "",
                totalMinor: invoice!.totalMinor,
                dueDate: invoice!.dueDate,
                portalUrl: url,
              });
      const live = render(`${origin}/api/portal/auth/${token}`);
      const redacted = render(
        isLogin ? `${origin}/portal/login` : `${origin}/portal/invoices/${invoice!.id}`,
      );

      return {
        tenantId,
        subject: live.subject,
        html: live.html,
        text: live.text,
        to: contact.email,
        from: `${firm.displayName.replace(/[<>"\r\n]/g, "")} <${deps.config.emailFromAddress}>`,
        replyTo: firm.replyToEmail ?? undefined,
        isDemo: firm.isDemo,
        idempotencyKey: message.dedupeKey ?? message.id,
        record: { html: redacted.html, text: redacted.text },
      };
    },
  );
  if (prepared === "noop" || prepared === "cancelled") return prepared;

  let providerMessageId: string;
  if (prepared.isDemo) {
    // FR-14.3: demo firms never send real email; the in-app outbox shows the stored message.
    providerMessageId = `demo:${messageId}`;
  } else {
    try {
      ({ providerMessageId } = await deps.email.send({
        to: prepared.to,
        from: prepared.from,
        replyTo: prepared.replyTo,
        subject: prepared.subject,
        html: prepared.html,
        text: prepared.text,
        idempotencyKey: prepared.idempotencyKey,
      }));
    } catch (error) {
      if (error instanceof EmailSendError && !error.retryable) {
        await withSystemTenant(systemDb, tenantId, (tx) =>
          tx
            .update(messages)
            .set({ status: "bounced" })
            .where(and(eq(messages.id, messageId), eq(messages.status, "queued"))),
        );
        return "cancelled";
      }
      throw error; // the queue retries
    }
  }

  await withSystemTenant(systemDb, tenantId, (tx) =>
    tx
      .update(messages)
      .set({
        status: "sent",
        sentAt: realNow(),
        providerMessageId,
        subject: prepared.subject,
        bodyHtml: prepared.record.html,
        bodyText: prepared.record.text,
      })
      .where(and(eq(messages.id, messageId), eq(messages.status, "queued"))),
  );
  return "sent";
}

/** Safety net for a crash between commit and enqueue: re-enqueue messages stuck in `queued`. Run from the tick. */
export async function requeueStaleMessages(systemDb: Db, queue: QueuePort, olderThanSeconds = 60) {
  const stale = await systemDb
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.status, "queued"),
        lt(messages.createdAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    )
    .limit(100);
  for (const { id } of stale) await queue.send({ type: "send_message", messageId: id });
  return stale.length;
}
