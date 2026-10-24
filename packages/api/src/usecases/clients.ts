import { realNow } from "@repo/clock";
import { uniqueViolation, withTenant, type Db } from "@repo/db";
import { clients, contacts } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { and, asc, eq, ilike, isNull } from "drizzle-orm";

import { audit, type Actor } from "./audit";

export interface ContactInput {
  name: string;
  email: string;
  role?: string | null;
  receivesInvoices?: boolean;
  receivesReminders?: boolean;
}

export interface ClientInput {
  name: string;
  timezone?: string | null;
  notes?: string | null;
  billingAddress?: Record<string, string> | null;
}

const notFound = () => new DomainError("client.not_found", "not_found", "Client not found.");
const duplicateEmail = () =>
  new DomainError(
    "contact.duplicate_email",
    "conflict",
    "That client already has a contact with this email.",
  );

export async function listClients(
  db: Db,
  tenantId: string,
  opts: { search?: string; archived?: boolean } = {},
) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: clients.id,
        name: clients.name,
        archivedAt: clients.archivedAt,
        timezone: clients.timezone,
      })
      .from(clients)
      .where(
        and(
          opts.archived ? undefined : isNull(clients.archivedAt),
          opts.search
            ? ilike(clients.name, `%${opts.search.replace(/[%_\\]/g, "\\$&")}%`)
            : undefined,
        ),
      )
      .orderBy(asc(clients.name)),
  );
}

export async function getClient(db: Db, tenantId: string, clientId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [client] = await tx.select().from(clients).where(eq(clients.id, clientId));
    if (!client) throw notFound();
    const clientContacts = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.clientId, clientId))
      .orderBy(asc(contacts.createdAt));
    return { ...client, contacts: clientContacts };
  });
}

/** A client always gets a primary contact so invoices have somewhere to go. */
export async function createClient(
  db: Db,
  actor: Actor,
  input: ClientInput,
  contact: ContactInput,
) {
  try {
    return await withTenant(db, actor.tenantId, async (tx) => {
      const [client] = await tx
        .insert(clients)
        .values({ tenantId: actor.tenantId, ...input })
        .returning({ id: clients.id });
      await tx.insert(contacts).values({
        tenantId: actor.tenantId,
        clientId: client!.id,
        ...contact,
        email: contact.email.trim().toLowerCase(),
        isPrimary: true,
      });
      await audit(
        tx,
        actor,
        "client.created",
        { type: "client", id: client!.id },
        { after: input },
      );
      return { id: client!.id };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw duplicateEmail();
    throw error;
  }
}

export async function updateClient(
  db: Db,
  actor: Actor,
  clientId: string,
  input: Partial<ClientInput>,
) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [before] = await tx.select().from(clients).where(eq(clients.id, clientId));
    if (!before) throw notFound();
    await tx
      .update(clients)
      .set({ ...input, updatedAt: realNow() })
      .where(eq(clients.id, clientId));
    await audit(
      tx,
      actor,
      "client.updated",
      { type: "client", id: clientId },
      {
        before: { name: before.name, timezone: before.timezone, notes: before.notes },
        after: input,
      },
    );
  });
}

/** Soft delete (D11): history, invoices and the ledger keep pointing at the client. */
export async function archiveClient(db: Db, actor: Actor, clientId: string, archived = true) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const done = await tx
      .update(clients)
      .set({ archivedAt: archived ? realNow() : null })
      .where(eq(clients.id, clientId))
      .returning({ id: clients.id });
    if (!done.length) throw notFound();
    await audit(tx, actor, archived ? "client.archived" : "client.restored", {
      type: "client",
      id: clientId,
    });
  });
}

export async function addContact(db: Db, actor: Actor, clientId: string, input: ContactInput) {
  try {
    return await withTenant(db, actor.tenantId, async (tx) => {
      const [client] = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, clientId));
      if (!client) throw notFound();
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: actor.tenantId,
          clientId,
          ...input,
          email: input.email.trim().toLowerCase(),
        })
        .returning({ id: contacts.id });
      await audit(
        tx,
        actor,
        "contact.added",
        { type: "contact", id: contact!.id },
        { after: { clientId, email: input.email } },
      );
      return { id: contact!.id };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw duplicateEmail();
    throw error;
  }
}

export async function updateContact(
  db: Db,
  actor: Actor,
  contactId: string,
  input: Partial<ContactInput>,
) {
  try {
    await withTenant(db, actor.tenantId, async (tx) => {
      const done = await tx
        .update(contacts)
        .set({ ...input, ...(input.email ? { email: input.email.trim().toLowerCase() } : {}) })
        .where(eq(contacts.id, contactId))
        .returning({ id: contacts.id });
      if (!done.length)
        throw new DomainError("contact.not_found", "not_found", "Contact not found.");
      await audit(
        tx,
        actor,
        "contact.updated",
        { type: "contact", id: contactId },
        { after: input },
      );
    });
  } catch (error) {
    if (uniqueViolation(error)) throw duplicateEmail();
    throw error;
  }
}

/** Moves the primary flag in one transaction; the unique index allows only one primary per client. */
export async function setPrimaryContact(db: Db, actor: Actor, contactId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [contact] = await tx
      .select({ clientId: contacts.clientId })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    if (!contact) throw new DomainError("contact.not_found", "not_found", "Contact not found.");
    await tx
      .update(contacts)
      .set({ isPrimary: false })
      .where(eq(contacts.clientId, contact.clientId));
    await tx.update(contacts).set({ isPrimary: true }).where(eq(contacts.id, contactId));
    await audit(tx, actor, "contact.set_primary", { type: "contact", id: contactId });
  });
}

export async function removeContact(db: Db, actor: Actor, contactId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!contact) throw new DomainError("contact.not_found", "not_found", "Contact not found.");
    const siblings = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.clientId, contact.clientId));
    if (siblings.length === 1) {
      throw new DomainError(
        "contact.last_contact",
        "unprocessable",
        "A client needs at least one contact.",
      );
    }
    await tx.delete(contacts).where(eq(contacts.id, contactId));
    // Keep a primary: hand the flag to the oldest remaining contact.
    if (contact.isPrimary) {
      const [next] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.clientId, contact.clientId))
        .orderBy(asc(contacts.createdAt))
        .limit(1);
      await tx.update(contacts).set({ isPrimary: true }).where(eq(contacts.id, next!.id));
    }
    await audit(
      tx,
      actor,
      "contact.removed",
      { type: "contact", id: contactId },
      { before: { email: contact.email } },
    );
  });
}
