import { portalRouterFactory } from "../../portal-init";
import { portalDisputesRouter, portalPromisesRouter } from "./actions";
import { portalAuthRouter } from "./auth";
import { portalInvoicesRouter } from "./invoices";

export const portalRouter = portalRouterFactory({
  auth: portalAuthRouter,
  disputes: portalDisputesRouter,
  invoices: portalInvoicesRouter,
  promises: portalPromisesRouter,
});

export type PortalRouter = typeof portalRouter;
