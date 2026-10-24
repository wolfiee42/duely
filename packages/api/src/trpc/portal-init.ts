import { DomainError } from "@repo/domain";
import { initTRPC, TRPCError } from "@trpc/server";

import { CODE_FOR_KIND, formatError } from "./errors";
import type { PortalContext } from "./portal-context";

const t = initTRPC.context<PortalContext>().create({ errorFormatter: formatError });

export const portalRouterFactory = t.router;
export const createPortalCallerFactory = t.createCallerFactory;

const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof DomainError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: CODE_FOR_KIND[cause.kind], message: cause.message, cause });
  }
  return result;
});

/** Portal hosts only; the tenant is the host's. A staff session means nothing here. */
export const portalPublicProcedure = t.procedure.use(mapDomainErrors).use(({ ctx, next }) => {
  if (ctx.host.hostKind !== "portal" || !ctx.host.tenantId) {
    throw new DomainError("host.wrong_kind", "forbidden", "Not available on this host.");
  }
  return next({ ctx: { tenantId: ctx.host.tenantId } });
});

/**
 * A signed-in contact. Adds `tenantId` (from the host) and `contact` (from the session). Procedures built on
 * this never take `clientId` or `tenantId` as input; every query is scoped by `contact.clientId` on top of RLS.
 */
export const portalProcedure = portalPublicProcedure.use(async ({ ctx, next }) => {
  const contact = await ctx.getIdentity();
  if (!contact)
    throw new DomainError("portal.unauthenticated", "unauthorized", "Sign in to continue.");
  return next({ ctx: { contact } });
});
