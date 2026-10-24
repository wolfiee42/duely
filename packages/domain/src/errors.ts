/** How a domain failure should surface to a caller. The API layer maps each kind to a status (SPEC 6.1). */
export type DomainErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited";

/**
 * Use-cases throw these with a namespaced code such as `invoice.invalid_transition`.
 * Cross-tenant lookups throw `not_found`, never `forbidden`, so existence is not revealed.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly kind: DomainErrorKind,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}
