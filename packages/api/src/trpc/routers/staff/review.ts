import { z } from "zod";

import { assignInbound } from "../../../usecases/inbound";
import {
  approveDraft,
  countOpenReviewItems,
  dismissReviewItem,
  listReviewItems,
  rejectDraft,
} from "../../../usecases/review";
import { router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const itemId = z.object({ itemId: z.uuid() });

export const reviewRouter = router({
  list: staffProcedure
    .input(z.object({ status: z.enum(["open", "all"]).optional() }).optional())
    .query(({ ctx, input }) =>
      ctx.withDb((db) => listReviewItems(db, ctx.tenantId, input?.status)),
    ),

  count: staffProcedure.query(({ ctx }) =>
    ctx.withDb((db) => countOpenReviewItems(db, ctx.tenantId)),
  ),

  // The queue is told only after the approval commits (D22).
  approve: staffProcedure
    .input(
      itemId.extend({
        edits: z
          .object({
            subject: z.string().trim().min(1).max(200),
            body: z.string().trim().min(1).max(10_000),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { messageId } = await ctx.withDb((db) =>
        approveDraft(db, actorOf(ctx), input.itemId, input.edits),
      );
      await ctx.services.queue.send({ type: "send_message", messageId });
      return { messageId };
    }),

  reject: staffProcedure
    .input(itemId)
    .mutation(({ ctx, input }) => ctx.withDb((db) => rejectDraft(db, actorOf(ctx), input.itemId))),

  // Attach an unmatched reply to the invoice it is about.
  assign: staffProcedure
    .input(itemId.extend({ invoiceId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => assignInbound(db, actorOf(ctx), input.itemId, input.invoiceId)),
    ),

  dismiss: staffProcedure
    .input(itemId)
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => dismissReviewItem(db, actorOf(ctx), input.itemId)),
    ),
});
