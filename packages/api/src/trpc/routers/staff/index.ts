import { router } from "../../init";
import { clientsRouter, contactsRouter } from "./clients";
import { domainsRouter } from "./domains";
import { firmRouter } from "./firm";
import { invoicesRouter } from "./invoices";
import { membersRouter } from "./members";
import { policiesRouter } from "./policies";
import { disputesRouter, promisesRouter } from "./promises-disputes";
import { reviewRouter } from "./review";
import { stripeRouter } from "./stripe";

export const staffRouter = router({
  clients: clientsRouter,
  contacts: contactsRouter,
  disputes: disputesRouter,
  domains: domainsRouter,
  firm: firmRouter,
  invoices: invoicesRouter,
  members: membersRouter,
  policies: policiesRouter,
  promises: promisesRouter,
  review: reviewRouter,
  stripe: stripeRouter,
});

export type StaffRouter = typeof staffRouter;
