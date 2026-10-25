import { z } from "zod";

import { advanceClock, demoStatus, resetDemo, simulateReply } from "../../../usecases/demo";
import { listOutbox } from "../../../usecases/outbox-view";
import { ownerProcedure, router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const connectPayments = (ctx: {
  services: { stripe: unknown };
  config: { platformDomain: string };
}) => ctx.config.platformDomain === "localhost";

export const demoRouter = router({
  status: staffProcedure.query(({ ctx }) => ctx.withDb((db) => demoStatus(db, ctx.tenantId))),

  /** Fast-forward the firm's own clock and run the scheduler now (FR-14.2). Refused unless the firm is a demo. */
  advanceClock: staffProcedure
    .input(z.object({ days: z.number().int().min(1).max(90) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        ctx.withSystemDb((system) =>
          advanceClock(
            db,
            system,
            { queue: ctx.services.queue, model: ctx.services.model },
            actorOf(ctx),
            input.days,
          ),
        ),
      ),
    ),

  /** Type a reply as if from the client; it takes the real inbound path (FR-14.4). */
  simulateReply: staffProcedure
    .input(z.object({ invoiceId: z.uuid(), text: z.string().trim().min(1).max(2000) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        ctx.withSystemDb((system) =>
          simulateReply(db, system, { model: ctx.services.model }, actorOf(ctx), input),
        ),
      ),
    ),

  reset: ownerProcedure.mutation(({ ctx }) =>
    ctx.withDb((db) =>
      ctx.withSystemDb((system) =>
        resetDemo(db, system, { model: ctx.services.model }, actorOf(ctx), {
          connectPayments: connectPayments(ctx),
        }),
      ),
    ),
  ),

  /** Emails the demo "sent" instead of delivering them (FR-14.3). */
  outbox: staffProcedure.query(({ ctx }) => ctx.withDb((db) => listOutbox(db, ctx.tenantId))),
});
