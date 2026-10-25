import { getDashboard } from "../../../usecases/dashboard";
import { router, staffProcedure } from "../../init";

export const dashboardRouter = router({
  get: staffProcedure.query(({ ctx }) => ctx.withDb((db) => getDashboard(db, ctx.tenantId))),
});
