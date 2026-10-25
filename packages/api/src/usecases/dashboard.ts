import { addDays } from "@repo/clock";
import { withTenant, type Db } from "@repo/db";
import { clients, invoices, payments, promises, reviewItems } from "@repo/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

import { firmClock } from "./firm-clock";

const OPEN = ["sent", "viewed", "overdue", "promised", "disputed"] as const;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type AgingBucket = "current" | "1-30" | "31-60" | "61+";

/** Which aging bucket an open invoice falls in, by whole days past its due date in the firm's calendar. */
export function agingBucket(dueDate: string | null, today: string): AgingBucket {
  if (!dueDate || dueDate >= today) return "current";
  const late = daysBetween(dueDate, today);
  return late <= 30 ? "1-30" : late <= 60 ? "31-60" : "61+";
}

/** FR-12.3. Everything is read in one transaction on the firm's own clock, so a simulated date is honoured. */
export async function getDashboard(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const { today } = await firmClock(tx, tenantId);
    const open = await tx
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
        dueDate: invoices.dueDate,
        totalMinor: invoices.totalMinor,
        paidMinor: invoices.paidMinor,
        riskLevel: invoices.riskLevel,
        clientName: clients.name,
      })
      .from(invoices)
      .innerJoin(
        clients,
        and(eq(clients.tenantId, invoices.tenantId), eq(clients.id, invoices.clientId)),
      )
      .where(inArray(invoices.status, [...OPEN]));

    const aging: Record<AgingBucket, { count: number; amountMinor: number }> = {
      current: { count: 0, amountMinor: 0 },
      "1-30": { count: 0, amountMinor: 0 },
      "31-60": { count: 0, amountMinor: 0 },
      "61+": { count: 0, amountMinor: 0 },
    };
    let outstanding = 0;
    let overdue = 0;
    let overdueCount = 0;
    let highRisk = 0;
    for (const i of open) {
      const owed = i.totalMinor - i.paidMinor;
      const bucket = agingBucket(i.dueDate, today);
      aging[bucket].count++;
      aging[bucket].amountMinor += owed;
      outstanding += owed;
      if (bucket !== "current") {
        overdue += owed;
        overdueCount++;
      }
      if (i.riskLevel === "high") highRisk++;
    }

    const weekEnd = addDays(today, 7);
    const promisesDue = (
      await tx
        .select({
          id: promises.id,
          promisedDate: promises.promisedDate,
          invoiceId: promises.invoiceId,
          number: invoices.number,
          totalMinor: invoices.totalMinor,
          paidMinor: invoices.paidMinor,
          clientName: clients.name,
        })
        .from(promises)
        .innerJoin(invoices, eq(invoices.id, promises.invoiceId))
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(eq(promises.status, "active"))
    )
      .filter((p) => p.promisedDate >= today && p.promisedDate <= weekEnd)
      .sort((a, b) => a.promisedDate.localeCompare(b.promisedDate))
      .map((p) => ({ ...p, amountMinor: p.totalMinor - p.paidMinor }));

    const recentPayments = await tx
      .select({
        id: payments.id,
        amountMinor: payments.amountMinor,
        at: payments.succeededAt,
        invoiceId: payments.invoiceId,
        number: invoices.number,
        clientName: clients.name,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(eq(payments.status, "succeeded"))
      .orderBy(desc(payments.succeededAt))
      .limit(5);

    const waiting = await tx
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(eq(reviewItems.status, "open"));

    return {
      today,
      outstandingMinor: outstanding,
      overdueMinor: overdue,
      overdueCount,
      openCount: open.length,
      highRiskCount: highRisk,
      aging,
      promisesDue,
      recentPayments,
      waitingForReview: waiting.length,
    };
  });
}
