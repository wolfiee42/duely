import { withTenant } from "@repo/db";
import { members } from "@repo/db/schema";
import { asc } from "drizzle-orm";
import { z } from "zod";

import {
  acceptInvite,
  inviteMember,
  listInvites,
  previewInvite,
  revokeInvite,
} from "../../../usecases/invites";
import {
  newUserProcedure,
  ownerProcedure,
  publicProcedure,
  router,
  staffProcedure,
} from "../../init";

const token = z.string().min(20).max(100);

export const membersRouter = router({
  list: staffProcedure.query(({ ctx }) =>
    ctx.withDb(async (db) => ({
      members: await withTenant(db, ctx.tenantId, (tx) =>
        tx
          .select({ id: members.id, email: members.email, name: members.name, role: members.role })
          .from(members)
          .orderBy(asc(members.createdAt)),
      ),
      invites: ctx.member.role === "owner" ? await listInvites(db, ctx.tenantId) : [],
    })),
  ),

  invite: ownerProcedure
    .input(z.object({ email: z.email(), role: z.enum(["owner", "member"]).default("member") }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        inviteMember(
          db,
          { tenantId: ctx.tenantId, type: "member", id: ctx.member.id, requestId: ctx.requestId },
          input.email,
          input.role,
        ),
      ),
    ),

  revokeInvite: ownerProcedure
    .input(z.object({ inviteId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        revokeInvite(
          db,
          { tenantId: ctx.tenantId, type: "member", id: ctx.member.id, requestId: ctx.requestId },
          input.inviteId,
        ),
      ),
    ),

  // Signed out is fine: the join page shows the firm before asking the invitee to sign in.
  previewInvite: publicProcedure
    .input(z.object({ token }))
    .query(({ ctx, input }) => ctx.withDb((db) => previewInvite(db, input.token))),

  acceptInvite: newUserProcedure
    .input(z.object({ token }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => acceptInvite(db, ctx.user, input.token, ctx.requestId)),
    ),
});
