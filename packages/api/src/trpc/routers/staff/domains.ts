import { z } from "zod";

import {
  addDomain,
  checkDomain,
  listDomains,
  removeDomain,
  requestScope,
} from "../../../usecases/domains";
import { idempotencyKeyInput, runIdempotent } from "../../idempotency";
import { ownerProcedure, router } from "../../init";
import { actorOf } from "./actor";

const domainId = z.object({ domainId: z.uuid() });

export const domainsRouter = router({
  list: ownerProcedure.query(({ ctx }) =>
    listDomains(requestScope(ctx.withDb), ctx.tenantId, ctx.config.cnameTarget),
  ),

  add: ownerProcedure
    .input(z.object({ hostname: z.string().max(300), ...idempotencyKeyInput }))
    .mutation(({ ctx, input }) =>
      runIdempotent(ctx.withDb, ctx.tenantId, "domains.add", input.idempotencyKey, () =>
        addDomain(
          requestScope(ctx.withDb),
          ctx.services.cloudflare,
          actorOf(ctx),
          input.hostname,
          ctx.config,
        ),
      ),
    ),

  check: ownerProcedure
    .input(domainId)
    .mutation(({ ctx, input }) =>
      checkDomain(
        requestScope(ctx.withDb),
        ctx.services.cloudflare,
        actorOf(ctx),
        input.domainId,
        ctx.config.cnameTarget,
      ),
    ),

  remove: ownerProcedure
    .input(domainId)
    .mutation(({ ctx, input }) =>
      removeDomain(requestScope(ctx.withDb), ctx.services.cloudflare, actorOf(ctx), input.domainId),
    ),
});
