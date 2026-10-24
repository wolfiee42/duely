import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { citext } from "./citext";
import { firms, members } from "./tenancy";
import type { MemberRole } from "./types";

// FR-1.6. The token itself is never stored, only its sha256 (SPEC 7).
export const memberInvites = pgTable(
  "member_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => firms.id),
    email: citext("email").notNull(),
    role: text("role").$type<MemberRole>().notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: text("accepted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.invitedBy],
      foreignColumns: [members.tenantId, members.id],
    }),
    index("member_invites_tenant_idx").on(t.tenantId),
    // One open invite per address per firm; re-inviting replaces it.
    uniqueIndex("member_invites_pending_email")
      .on(t.tenantId, t.email)
      .where(sql`${t.acceptedAt} is null`),
    check("member_invites_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);
