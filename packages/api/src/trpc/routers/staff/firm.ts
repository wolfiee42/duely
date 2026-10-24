import { z } from "zod";

import { createFirm, getFirm, slugAvailable } from "../../../usecases/firm";
import { newUserProcedure, router, sessionProcedure, staffProcedure } from "../../init";

const name = z.string().trim().min(2).max(120);

export const firmRouter = router({
  create: newUserProcedure
    .input(
      z.object({
        legalName: name,
        displayName: name,
        platformSlug: z.string().trim().toLowerCase(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => createFirm(db, ctx.user, input, ctx.requestId)),
    ),

  get: staffProcedure.query(({ ctx }) =>
    ctx.withDb(async (db) => ({
      firm: await getFirm(db, ctx.tenantId),
      role: ctx.member.role,
    })),
  ),

  // Used while onboarding, before the user has a firm.
  slugAvailable: sessionProcedure
    .input(z.object({ slug: z.string().trim().toLowerCase() }))
    .query(({ ctx, input }) => ctx.withDb((db) => slugAvailable(db, input.slug))),
});
