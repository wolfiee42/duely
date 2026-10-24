import { realNow } from "@repo/clock";
import { withTenant, type Db } from "@repo/db";
import {
  clients,
  contacts,
  firms,
  messages,
  portalSessions,
  portalTokens,
  rateLimitEvents,
} from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";

import { audit } from "./audit";
import { newToken, sha256Hex } from "./tokens";

export const LOGIN_LINK_MINUTES = 15;
export const SESSION_DAYS = 14;
const WINDOW_MINUTES = 15;
const LIMIT_PER_EMAIL = 3;
const LIMIT_PER_IP = 10;

const days = (n: number) => n * 86_400_000;

async function overLimit(db: Db, scope: string, keyHash: string, limit: number) {
  const [row] = await db
    .select({ n: count() })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.scope, scope),
        eq(rateLimitEvents.keyHash, keyHash),
        gt(rateLimitEvents.createdAt, sql`now() - make_interval(mins => ${WINDOW_MINUTES})`),
      ),
    );
  return (row?.n ?? 0) >= limit;
}

/**
 * Always looks the same to the caller (SPEC 6.3): a link is sent only if a contact exists, but whether
 * one does is never revealed. Every attempt counts toward the limits, known address or not.
 */
export async function requestLogin(db: Db, tenantId: string, email: string, ip: string) {
  const address = email.trim().toLowerCase();
  const emailKey = await sha256Hex(`${tenantId}:${address}`);
  const ipKey = await sha256Hex(`${tenantId}:${ip}`);

  if (
    (await overLimit(db, "portal_login_email", emailKey, LIMIT_PER_EMAIL)) ||
    (await overLimit(db, "portal_login_ip", ipKey, LIMIT_PER_IP))
  ) {
    throw new DomainError(
      "portal.rate_limited",
      "rate_limited",
      "Too many requests. Try again in a few minutes.",
    );
  }
  await db.insert(rateLimitEvents).values([
    { scope: "portal_login_email", keyHash: emailKey },
    { scope: "portal_login_ip", keyHash: ipKey },
  ]);

  // The link itself is minted by the outbox consumer, so no token is ever stored in the message.
  return withTenant(db, tenantId, async (tx) => {
    const matches = await tx
      .select({ id: contacts.id, clientId: contacts.clientId })
      .from(contacts)
      .innerJoin(
        clients,
        and(eq(clients.tenantId, contacts.tenantId), eq(clients.id, contacts.clientId)),
      )
      .where(
        and(
          eq(contacts.email, address),
          eq(contacts.emailStatus, "ok"),
          isNull(clients.archivedAt),
        ),
      );
    const ids: string[] = [];
    for (const contact of matches) {
      const [message] = await tx
        .insert(messages)
        .values({
          tenantId,
          clientId: contact.clientId,
          contactId: contact.id,
          direction: "out",
          kind: "notification",
          status: "queued",
          dedupeKey: `login:${contact.id}:${crypto.randomUUID()}`,
        })
        .returning({ id: messages.id });
      ids.push(message!.id);
    }
    return ids;
  });
}

export interface PortalIdentity {
  sessionId: string;
  contactId: string;
  clientId: string;
  name: string;
  email: string;
}

/** Trades a magic link for a session. `null` for unknown, expired or already-used links (indistinguishable). */
export async function consumeLink(db: Db, tenantId: string, rawToken: string) {
  const tokenHash = await sha256Hex(rawToken);
  const now = realNow();
  return withTenant(db, tenantId, async (tx) => {
    const [token] = await tx
      .select()
      .from(portalTokens)
      .where(eq(portalTokens.tokenHash, tokenHash))
      .for("update");
    if (!token || token.expiresAt <= now) return null;

    if (token.purpose === "login") {
      // Single use: the conditional update is the lock.
      const claimed = await tx
        .update(portalTokens)
        .set({ usedAt: now })
        .where(and(eq(portalTokens.id, token.id), isNull(portalTokens.usedAt)))
        .returning({ id: portalTokens.id });
      if (!claimed.length) return null;
    }

    const [contact] = await tx
      .select({ id: contacts.id, clientId: contacts.clientId, archived: clients.archivedAt })
      .from(contacts)
      .innerJoin(
        clients,
        and(eq(clients.tenantId, contacts.tenantId), eq(clients.id, contacts.clientId)),
      )
      .where(eq(contacts.id, token.contactId));
    if (!contact || contact.archived) return null;

    // A fresh random session on every login (rotation); the browser's old session is replaced by the caller.
    const sessionToken = newToken();
    const expiresAt = new Date(now.getTime() + days(SESSION_DAYS));
    await tx.insert(portalSessions).values({
      tenantId,
      contactId: contact.id,
      sessionHash: await sha256Hex(sessionToken),
      expiresAt,
    });
    await audit(
      tx,
      { tenantId, type: "contact", id: contact.id },
      "portal.login",
      { type: "contact", id: contact.id },
      { via: token.purpose },
    );
    return { sessionToken, expiresAt, invoiceId: token.invoiceId };
  });
}

export async function loadSession(
  db: Db,
  tenantId: string,
  rawSession: string,
): Promise<PortalIdentity | null> {
  const sessionHash = await sha256Hex(rawSession);
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        sessionId: portalSessions.id,
        expiresAt: portalSessions.expiresAt,
        contactId: contacts.id,
        clientId: contacts.clientId,
        name: contacts.name,
        email: contacts.email,
        archived: clients.archivedAt,
      })
      .from(portalSessions)
      .innerJoin(
        contacts,
        and(
          eq(contacts.tenantId, portalSessions.tenantId),
          eq(contacts.id, portalSessions.contactId),
        ),
      )
      .innerJoin(
        clients,
        and(eq(clients.tenantId, contacts.tenantId), eq(clients.id, contacts.clientId)),
      )
      .where(eq(portalSessions.sessionHash, sessionHash));
    if (!row || row.expiresAt <= realNow() || row.archived) return null;
    return {
      sessionId: row.sessionId,
      contactId: row.contactId,
      clientId: row.clientId,
      name: row.name,
      email: row.email,
    };
  });
}

export async function endSession(db: Db, tenantId: string, rawSession: string) {
  const sessionHash = await sha256Hex(rawSession);
  await withTenant(db, tenantId, (tx) =>
    tx.delete(portalSessions).where(eq(portalSessions.sessionHash, sessionHash)),
  );
}

export async function portalBranding(db: Db, tenantId: string) {
  const [firm] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        displayName: firms.displayName,
        brandPrimary: firms.brandPrimary,
        hasLogo: sql<boolean>`${firms.logoUrl} is not null`,
      })
      .from(firms)
      .where(eq(firms.id, tenantId)),
  );
  return firm ?? null;
}
