import { z } from "zod";

import { createPromise, openDispute } from "../../../usecases/promises-disputes";
import { portalProcedure, portalRouterFactory } from "../../portal-init";

const origin = (ctx: {
  tenantId: string;
  contact: { contactId: string; clientId: string };
  requestId: string;
}) => ({
  actor: {
    tenantId: ctx.tenantId,
    type: "contact" as const,
    id: ctx.contact.contactId,
    requestId: ctx.requestId,
  },
  source: "portal" as const,
  clientId: ctx.contact.clientId,
});

export const portalPromisesRouter = portalRouterFactory({
  create: portalProcedure
    .input(z.object({ invoiceId: z.uuid(), promisedDate: z.iso.date() }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => createPromise(db, origin(ctx), input.invoiceId, input.promisedDate)),
    ),
});

export const portalDisputesRouter = portalRouterFactory({
  open: portalProcedure
    .input(
      z.object({
        invoiceId: z.uuid(),
        reason: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(4000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => openDispute(db, origin(ctx), input.invoiceId, input)),
    ),
});
