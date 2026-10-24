import { router } from "../../init";
import { clientsRouter, contactsRouter } from "./clients";
import { firmRouter } from "./firm";
import { invoicesRouter } from "./invoices";
import { membersRouter } from "./members";
import { disputesRouter, promisesRouter } from "./promises-disputes";
import { stripeRouter } from "./stripe";

export const staffRouter = router({
  clients: clientsRouter,
  contacts: contactsRouter,
  disputes: disputesRouter,
  firm: firmRouter,
  invoices: invoicesRouter,
  members: membersRouter,
  promises: promisesRouter,
  stripe: stripeRouter,
});

export type StaffRouter = typeof staffRouter;
