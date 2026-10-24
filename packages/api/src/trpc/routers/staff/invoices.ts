import { z } from "zod";

import {
  createDraft,
  deleteDraft,
  getInvoice,
  invoiceTimeline,
  listInvoices,
  updateDraft,
  voidInvoice,
} from "../../../usecases/invoices";
import { sendInvoice } from "../../../usecases/send-invoice";
import { idempotencyKeyInput, runIdempotent } from "../../idempotency";
import { router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const id = z.uuid();
const date = z.iso.date();

const draft = z.object({
  clientId: id,
  dueDate: date.nullish().transform((v) => v ?? null),
  notes: z
    .string()
    .trim()
    .max(4000)
    .nullish()
    .transform((v) => v || null),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(500),
        quantity: z.string().trim().max(14),
        unitAmountMinor: z.number().int().min(0),
      }),
    )
    .max(100),
});

export const invoicesRouter = router({
  list: staffProcedure
    .input(
      z
        .object({
          status: z
            .enum(["draft", "sent", "viewed", "overdue", "promised", "disputed", "paid", "void"])
            .optional(),
          clientId: id.optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.withDb((db) => listInvoices(db, ctx.tenantId, input ?? {}))),

  get: staffProcedure
    .input(z.object({ invoiceId: id }))
    .query(({ ctx, input }) => ctx.withDb((db) => getInvoice(db, ctx.tenantId, input.invoiceId))),

  timeline: staffProcedure
    .input(z.object({ invoiceId: id }))
    .query(({ ctx, input }) =>
      ctx.withDb((db) => invoiceTimeline(db, ctx.tenantId, input.invoiceId)),
    ),

  createDraft: staffProcedure
    .input(draft)
    .mutation(({ ctx, input }) => ctx.withDb((db) => createDraft(db, actorOf(ctx), input))),

  updateDraft: staffProcedure.input(draft.extend({ invoiceId: id })).mutation(({ ctx, input }) => {
    const { invoiceId, ...rest } = input;
    return ctx.withDb((db) => updateDraft(db, actorOf(ctx), invoiceId, rest));
  }),

  deleteDraft: staffProcedure
    .input(z.object({ invoiceId: id }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => deleteDraft(db, actorOf(ctx), input.invoiceId)),
    ),

  void: staffProcedure
    .input(z.object({ invoiceId: id, reason: z.string().trim().min(1).max(500) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => voidInvoice(db, actorOf(ctx), input.invoiceId, input.reason)),
    ),

  // Side-effecting: takes an idempotency key (D29). The queue is told only after the transaction commits.
  send: staffProcedure
    .input(z.object({ invoiceId: id, ...idempotencyKeyInput }))
    .mutation(({ ctx, input }) =>
      runIdempotent(ctx.withDb, ctx.tenantId, "invoices.send", input.idempotencyKey, async () => {
        const sent = await ctx.withDb((db) => sendInvoice(db, actorOf(ctx), input.invoiceId));
        for (const messageId of sent.messageIds)
          await ctx.services.queue.send({ type: "send_message", messageId });
        return { number: sent.number, dueDate: sent.dueDate };
      }),
    ),
});
