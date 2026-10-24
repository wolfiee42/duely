import type { Actor } from "../../../usecases/audit";

/** The acting staff member for audit entries and use-cases. */
export const actorOf = (ctx: {
  tenantId: string;
  member: { id: string };
  requestId: string;
}): Actor => ({
  tenantId: ctx.tenantId,
  type: "member",
  id: ctx.member.id,
  requestId: ctx.requestId,
});
