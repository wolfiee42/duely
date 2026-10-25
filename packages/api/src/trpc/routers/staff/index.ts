import { router } from "../../init";
import { aiRouter } from "./ai";
import { clientsRouter, contactsRouter } from "./clients";
import { dashboardRouter } from "./dashboard";
import { demoRouter } from "./demo";
import { domainsRouter } from "./domains";
import { firmRouter } from "./firm";
import { importsRouter } from "./imports";
import { invoicesRouter } from "./invoices";
import { membersRouter } from "./members";
import { policiesRouter } from "./policies";
import { disputesRouter, promisesRouter } from "./promises-disputes";
import { reviewRouter } from "./review";
import { stripeRouter } from "./stripe";

export const staffRouter = router({
  ai: aiRouter,
  clients: clientsRouter,
  contacts: contactsRouter,
  dashboard: dashboardRouter,
  demo: demoRouter,
  disputes: disputesRouter,
  domains: domainsRouter,
  firm: firmRouter,
  imports: importsRouter,
  invoices: invoicesRouter,
  members: membersRouter,
  policies: policiesRouter,
  promises: promisesRouter,
  review: reviewRouter,
  stripe: stripeRouter,
});

export type StaffRouter = typeof staffRouter;
