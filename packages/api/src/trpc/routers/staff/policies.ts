import { TEMPLATE_KEYS } from "@repo/domain";
import { z } from "zod";

import {
  createPolicy,
  deletePolicy,
  listPolicies,
  previewPolicy,
  setDefaultPolicy,
  updatePolicy,
} from "../../../usecases/policies";
import { ownerProcedure, router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const settings = z.object({
  name: z.string().trim().min(1).max(80),
  quietStart: time,
  quietEnd: time,
  sendWeekends: z.boolean(),
  promiseGraceDays: z.number().int().min(0).max(30),
});

const step = z.object({
  id: z.uuid().optional(),
  offsetDays: z.number().int().min(-60).max(365),
  templateKey: z.enum(TEMPLATE_KEYS),
  tone: z.enum(["friendly", "neutral", "firm"]),
  sendMode: z.enum(["draft", "auto"]),
  escalateNotifyFirm: z.boolean(),
});

const policyId = z.object({ policyId: z.uuid() });

export const policiesRouter = router({
  list: staffProcedure.query(({ ctx }) => ctx.withDb((db) => listPolicies(db, ctx.tenantId))),

  preview: staffProcedure
    .input(
      z.object({
        settings,
        steps: z.array(step.omit({ id: true })).max(12),
        dueDate: z.iso.date().optional(),
        timezone: z.string().trim().max(64).nullish(),
      }),
    )
    .query(({ ctx, input }) => ctx.withDb((db) => previewPolicy(db, ctx.tenantId, input))),

  create: ownerProcedure
    .input(z.object({ settings, steps: z.array(step.omit({ id: true })).max(12) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => createPolicy(db, actorOf(ctx), input.settings, input.steps)),
    ),

  update: ownerProcedure
    .input(z.object({ policyId: z.uuid(), settings, steps: z.array(step).max(12) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        updatePolicy(db, actorOf(ctx), input.policyId, input.settings, input.steps),
      ),
    ),

  setDefault: ownerProcedure
    .input(policyId)
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => setDefaultPolicy(db, actorOf(ctx), input.policyId)),
    ),

  delete: ownerProcedure
    .input(policyId)
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => deletePolicy(db, actorOf(ctx), input.policyId)),
    ),
});
