import { DomainError, type DomainErrorKind } from "@repo/domain";
import type { TRPCError } from "@trpc/server";

// SPEC 6.1: how a domain failure surfaces. Shared by the staff and portal routers.
export const CODE_FOR_KIND = {
  validation: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  unprocessable: "UNPROCESSABLE_CONTENT",
  rate_limited: "TOO_MANY_REQUESTS",
} as const satisfies Record<DomainErrorKind, TRPCError["code"]>;

export function formatError({
  shape,
  error,
}: {
  shape: { message: string; data: Record<string, unknown> };
  error: TRPCError;
}) {
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
}
