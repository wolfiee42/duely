import {
  ownerEmail,
  refreshConnectStatus,
  startConnectOnboarding,
} from "../../../usecases/stripe-connect";
import { ownerProcedure, router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

export const stripeRouter = router({
  connectLink: ownerProcedure.mutation(async ({ ctx }) => {
    const email = await ctx.withDb((db) => ownerEmail(db, ctx.tenantId, ctx.member.id));
    return startConnectOnboarding(
      ctx.withDb,
      ctx.services.stripe,
      actorOf(ctx),
      email,
      ctx.config.appOrigin,
    );
  }),

  status: staffProcedure.query(({ ctx }) =>
    refreshConnectStatus(ctx.withDb, ctx.services.stripe, actorOf(ctx)),
  ),
});
