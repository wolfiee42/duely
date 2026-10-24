import { localDate, nowWithOffset, realNow } from "@repo/clock";
import type { Tx } from "@repo/db";
import { firms } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { eq } from "drizzle-orm";

/** D6: the firm's "now" and its local "today". Call inside the transaction that uses them. */
export async function firmClock(tx: Tx, tenantId: string) {
  const [firm] = await tx.select().from(firms).where(eq(firms.id, tenantId));
  if (!firm) throw new DomainError("firm.not_found", "not_found");
  const now = nowWithOffset(firm.clockOffsetSeconds, realNow());
  return { firm, now, today: localDate(now, firm.timezone) };
}
