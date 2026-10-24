import { withTenant } from "@repo/db";
import { idempotencyKeys } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { WithDb } from "../db";

/** Spread into the input of every side-effecting mutation (D29, SPEC 6.1). */
export const idempotencyKeyInput = { idempotencyKey: z.uuid() };

/**
 * Runs `fn` once per `(tenant, key, procedure)`. A repeat of a finished call returns the stored
 * result without running `fn` again; a repeat while the first is still running gets a conflict.
 * If `fn` throws, the key is released so the client can retry. The result must be JSON.
 *
 * Deliberately not one big transaction: `fn` may take its own short transactions (D22).
 */
export async function runIdempotent<T>(
  withDb: WithDb,
  tenantId: string,
  procedure: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const where = and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.procedure, procedure));

  const claim = await withDb((db) =>
    withTenant(db, tenantId, async (tx) => {
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({ tenantId, key, procedure })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (inserted.length) return { claimed: true as const };
      const [row] = await tx
        .select({ response: idempotencyKeys.response })
        .from(idempotencyKeys)
        .where(where);
      return {
        claimed: false as const,
        response: row?.response as { value: T } | null | undefined,
      };
    }),
  );

  if (!claim.claimed) {
    if (claim.response) return claim.response.value;
    throw new DomainError(
      "idempotency.in_progress",
      "conflict",
      "This request is already being processed.",
    );
  }

  try {
    const value = await fn();
    await withDb((db) =>
      withTenant(db, tenantId, (tx) =>
        // Wrapped so a `null` result is distinguishable from "not finished yet".
        tx
          .update(idempotencyKeys)
          .set({ response: { value: value ?? null } })
          .where(where),
      ),
    );
    return value;
  } catch (error) {
    await withDb((db) => withTenant(db, tenantId, (tx) => tx.delete(idempotencyKeys).where(where)));
    throw error;
  }
}
