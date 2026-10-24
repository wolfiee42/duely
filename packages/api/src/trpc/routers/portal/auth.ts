import { z } from "zod";

import { endSession, portalBranding, requestLogin } from "../../../usecases/portal-auth";
import { portalProcedure, portalPublicProcedure, portalRouterFactory } from "../../portal-init";

export const portalAuthRouter = portalRouterFactory({
  // Always succeeds from the caller's point of view (SPEC 6.3). The queue is told after the commit.
  requestLink: portalPublicProcedure
    .input(z.object({ email: z.email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const messageIds = await ctx.withDb((db) =>
        requestLogin(db, ctx.tenantId, input.email, ctx.ip),
      );
      for (const messageId of messageIds)
        await ctx.services.queue.send({ type: "send_message", messageId });
      return { ok: true as const };
    }),

  // Signed-out callers get `null` rather than an error, so the login page can render branding.
  me: portalPublicProcedure.query(async ({ ctx }) => {
    const [contact, firm] = await Promise.all([
      ctx.getIdentity(),
      ctx.withDb((db) => portalBranding(db, ctx.tenantId)),
    ]);
    return { firm, contact: contact ? { name: contact.name, email: contact.email } : null };
  }),

  logout: portalProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) await ctx.withDb((db) => endSession(db, ctx.tenantId, ctx.sessionToken!));
    return { ok: true as const };
  }),
});
