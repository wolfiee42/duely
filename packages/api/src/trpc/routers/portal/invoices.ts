import { z } from "zod";

import { createPayment, listReceipts } from "../../../usecases/payments";
import { getPortalInvoice, listPortalInvoices } from "../../../usecases/portal-invoices";
import { idempotencyKeyInput, runIdempotent } from "../../idempotency";
import { portalProcedure, portalRouterFactory } from "../../portal-init";

// No clientId or tenantId in any input: the client is the signed-in contact's, the tenant is the host's.
export const portalInvoicesRouter = portalRouterFactory({
  list: portalProcedure.query(({ ctx }) =>
    ctx.withDb((db) => listPortalInvoices(db, ctx.tenantId, ctx.contact)),
  ),

  get: portalProcedure
    .input(z.object({ invoiceId: z.uuid() }))
    .query(({ ctx, input }) =>
      ctx.withDb((db) => getPortalInvoice(db, ctx.tenantId, ctx.contact, input.invoiceId)),
    ),

  // Side-effecting (D29). The amount is the invoice balance, computed server-side; nothing about money is accepted as input.
  createPayment: portalProcedure
    .input(z.object({ invoiceId: z.uuid(), ...idempotencyKeyInput }))
    .mutation(async ({ ctx, input }) => {
      const result = await runIdempotent(
        ctx.withDb,
        ctx.tenantId,
        "portal.invoices.createPayment",
        input.idempotencyKey,
        () =>
          createPayment(
            ctx.withDb,
            ctx.services.stripe,
            ctx.tenantId,
            ctx.contact,
            input.invoiceId,
            input.idempotencyKey,
          ),
      );
      return { ...result, publishableKey: ctx.config.stripePublishableKey, tenantId: ctx.tenantId };
    }),

  receipts: portalProcedure.query(({ ctx }) =>
    ctx.withDb((db) => listReceipts(db, ctx.tenantId, ctx.contact)),
  ),
});
