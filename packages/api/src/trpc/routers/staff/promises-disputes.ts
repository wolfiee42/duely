import { z } from "zod";

import {
  cancelPromise,
  createPromise,
  openDispute,
  resolveDispute,
} from "../../../usecases/promises-disputes";
import { router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const id = z.uuid();

export const promisesRouter = router({
  create: staffProcedure
    .input(z.object({ invoiceId: id, promisedDate: z.iso.date() }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        createPromise(
          db,
          { actor: actorOf(ctx), source: "manual" },
          input.invoiceId,
          input.promisedDate,
        ),
      ),
    ),
  cancel: staffProcedure
    .input(z.object({ promiseId: id }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => cancelPromise(db, actorOf(ctx), input.promiseId)),
    ),
});

export const disputesRouter = router({
  open: staffProcedure
    .input(
      z.object({
        invoiceId: id,
        reason: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(4000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) =>
        openDispute(db, { actor: actorOf(ctx), source: "manual" }, input.invoiceId, input),
      ),
    ),
  resolve: staffProcedure
    .input(
      z.object({
        disputeId: id,
        outcome: z.enum(["resolved", "upheld"]),
        note: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => resolveDispute(db, actorOf(ctx), input.disputeId, input)),
    ),
});
