import { resolveMembership } from "@repo/db";
import { DomainError, type DomainErrorKind } from "@repo/domain";
import { initTRPC, TRPCError } from "@trpc/server";

import type { StaffContext } from "./context";

// SPEC 6.1: how a domain failure surfaces.
const CODE_FOR_KIND = {
  validation: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  unprocessable: "UNPROCESSABLE_CONTENT",
  rate_limited: "TOO_MANY_REQUESTS",
} as const satisfies Record<DomainErrorKind, TRPCError["code"]>;

const t = initTRPC.context<StaffContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      // Never leak driver or stack details from unexpected errors.
      message: error.code === "INTERNAL_SERVER_ERROR" ? "Internal error" : shape.message,
      data: {
        ...shape.data,
        stack: undefined,
        domainCode: error.cause instanceof DomainError ? error.cause.code : null,
      },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Turns a `DomainError` thrown anywhere below into the matching `TRPCError`. */
const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof DomainError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: CODE_FOR_KIND[cause.kind], message: cause.message, cause });
  }
  return result;
});

const requireAppHost = t.middleware(({ ctx, next }) => {
  if (ctx.host.hostKind !== "app") {
    throw new DomainError("host.wrong_kind", "forbidden", "Not available on this host.");
  }
  return next();
});

const requireSession = t.middleware(async ({ ctx, next }) => {
  const user = await ctx.getSession();
  if (!user) throw new DomainError("auth.unauthenticated", "unauthorized", "Sign in to continue.");
  return next({ ctx: { user } });
});

// SPEC 6.1 procedure builders. Hono also rejects wrong-kind hosts with a 404 before tRPC runs;
// the host check here covers the in-process SSR caller, which skips Hono.

/** Host kind matches the router. */
export const publicProcedure = t.procedure.use(mapDomainErrors).use(requireAppHost);
/** A signed-in user, with or without a firm. */
export const sessionProcedure = publicProcedure.use(requireSession);
/** A signed-in user who has no firm yet: used by `firm.create`. */
export const newUserProcedure = sessionProcedure.use(async ({ ctx, next }) => {
  if (await ctx.withDb((db) => resolveMembership(db, ctx.user.id))) {
    throw new DomainError("firm.already_member", "conflict", "You already belong to a firm.");
  }
  return next();
});
/** A member of a firm. Adds `tenantId` and `member` (the staff tenant comes from the members row, D20). */
export const staffProcedure = sessionProcedure.use(async ({ ctx, next }) => {
  const membership = await ctx.withDb((db) => resolveMembership(db, ctx.user.id));
  if (!membership) throw new DomainError("member.no_firm", "forbidden", "Create your firm first.");
  return next({
    ctx: {
      tenantId: membership.tenantId,
      member: { id: membership.memberId, role: membership.role },
    },
  });
});
export const ownerProcedure = staffProcedure.use(({ ctx, next }) => {
  if (ctx.member.role !== "owner") {
    throw new DomainError("member.owner_required", "forbidden", "Only an owner can do this.");
  }
  return next();
});
