import { z } from "zod";

import { aiUsage, updateAiSettings } from "../../../usecases/ai";
import { requestScope } from "../../../usecases/domains";
import { ownerProcedure, router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

export const aiRouter = router({
  usage: staffProcedure.query(async ({ ctx }) => ({
    ...(await aiUsage(requestScope(ctx.withDb), ctx.tenantId)),
    /** False when the deployment has no model configured: the features then work by hand. */
    available: ctx.services.model !== null,
  })),

  updateSettings: ownerProcedure
    .input(
      z.object({
        // $0 turns the assistant off; $1,000 a month is the ceiling the form allows.
        capCents: z.number().int().min(0).max(100_000).optional(),
        autoActions: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateAiSettings(requestScope(ctx.withDb), actorOf(ctx), input)),
});
