import { withTenant, type Db } from "@repo/db";
import { contacts, firms, messages } from "@repo/db/schema";
import { desc, eq } from "drizzle-orm";

import { assertDemo } from "./demo";

/** The in-app outbox of a demo firm: what would have been emailed, newest first. Refused for a real firm. */
export async function listOutbox(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [firm] = await tx
      .select({ demo: firms.isDemo })
      .from(firms)
      .where(eq(firms.id, tenantId));
    assertDemo(Boolean(firm?.demo));
    return tx
      .select({
        id: messages.id,
        direction: messages.direction,
        kind: messages.kind,
        status: messages.status,
        subject: messages.subject,
        body: messages.bodyText,
        at: messages.createdAt,
        to: contacts.email,
      })
      .from(messages)
      .leftJoin(contacts, eq(contacts.id, messages.contactId))
      .orderBy(desc(messages.createdAt))
      .limit(100);
  });
}
