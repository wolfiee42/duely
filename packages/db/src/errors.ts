/** Name of the violated unique constraint, or `null` if the error is not a unique violation. */
export function uniqueViolation(error: unknown): string | null {
  // Drizzle wraps the driver error as `cause`.
  const e = (error as { cause?: unknown } | null)?.cause ?? error;
  if (e && typeof e === "object" && (e as { code?: string }).code === "23505") {
    return (e as { constraint_name?: string }).constraint_name ?? "";
  }
  return null;
}
