import { z } from "zod";

import { createFirm, getFirm, slugAvailable, updateFirmSettings } from "../../../usecases/firm";
import {
  newUserProcedure,
  ownerProcedure,
  router,
  sessionProcedure,
  staffProcedure,
} from "../../init";
import { actorOf } from "./actor";

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

  update: ownerProcedure
    .input(
      z.object({
        legalName: name.optional(),
        displayName: name.optional(),
        timezone: z.string().trim().min(1).max(64).optional(),
        replyToEmail: z
          .email()
          .max(254)
          .nullish()
          .transform((v) => v ?? null)
          .optional(),
        brandPrimary: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB color")
          .optional(),
        brandAccent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullish()
          .transform((v) => v ?? null)
          .optional(),
        defaultTermsDays: z.number().int().min(0).max(365).optional(),
        invoicePrefix: z
          .string()
          .trim()
          .min(1)
          .max(10)
          .regex(/^[A-Za-z0-9-]+$/)
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.withDb((db) => updateFirmSettings(db, actorOf(ctx), input))),
});
