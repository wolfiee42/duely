import { RISK_SYSTEM, RiskExplainOutput, riskContent, type ModelClient } from "@repo/ai";
import { localDate } from "@repo/clock";
import type { Tx } from "@repo/db";
import { invoices, promises } from "@repo/db/schema";
import {
  DomainError,
  computeRiskFactors,
  riskLevel,
  type InvoiceStatus,
  type RiskFactors,
} from "@repo/domain";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { runAi } from "./ai";
import type { TenantScope } from "./domains";
import { firmClock } from "./firm-clock";

// SPEC 5.4. The score is rules over a client's history. The model only puts the numbers into words, and
// nothing about the score ever blocks a send (FR-11.17).

const OPEN: InvoiceStatus[] = ["sent", "viewed", "overdue", "promised", "disputed"];

// jsonb does not keep key order, so compare with the keys sorted.
const stable = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/** Recomputes and stores the factors and level. Clears the explanation if the numbers it described changed. */
export async function refreshRisk(tx: Tx, tenantId: string, invoiceId: string) {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice) throw new DomainError("invoice.not_found", "not_found");
  if (!OPEN.includes(invoice.status)) return null; // drafts have no history yet; paid and void are done

  const { firm, today } = await firmClock(tx, tenantId);
  const others = await tx
    .select({
      dueDate: invoices.dueDate,
      paidAt: invoices.paidAt,
      status: invoices.status,
      clientId: invoices.clientId,
      totalMinor: invoices.totalMinor,
    })
    .from(invoices)
    .where(and(ne(invoices.id, invoiceId), ne(invoices.status, "draft")));

  const history = others
    .filter((o) => o.clientId === invoice.clientId)
    .map((o) => ({
      dueDate: o.dueDate,
      paidDate: o.paidAt ? localDate(o.paidAt, firm.timezone) : null,
      status: o.status,
    }));
  const [{ n }] = await tx
    .select({ n: sql<string>`count(*)` })
    .from(promises)
    .innerJoin(invoices, eq(invoices.id, promises.invoiceId))
    .where(and(eq(promises.status, "broken"), eq(invoices.clientId, invoice.clientId)));

  const factors = computeRiskFactors({
    today,
    invoice: {
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      totalMinor: invoice.totalMinor,
    },
    history,
    brokenPromises: Number(n),
    firmTotals: others.map((o) => o.totalMinor),
  });
  const level = riskLevel(factors);
  const changed = stable(invoice.riskFactors) !== stable(factors);
  await tx
    .update(invoices)
    .set({
      riskLevel: level,
      riskFactors: factors,
      ...(changed ? { riskExplanation: null } : {}),
    })
    .where(eq(invoices.id, invoiceId));
  return { level, factors, explanation: changed ? null : invoice.riskExplanation };
}

/** A plain sentence built from the factors alone, for when no model can be used (FR-11.20). */
export function describeFactors(f: RiskFactors): string {
  const parts: string[] = [];
  if (f.late_rate !== null)
    parts.push(
      `${Math.round(f.late_rate * 100)}% of this client's past invoices were paid late or are still overdue`,
    );
  if (f.avg_days_late !== null)
    parts.push(
      `late ones were paid ${Math.round(f.avg_days_late)} days after the due date on average`,
    );
  if (f.broken_promises > 0)
    parts.push(`${f.broken_promises} broken promise${f.broken_promises === 1 ? "" : "s"} to pay`);
  if (f.days_overdue > 0) parts.push(`this invoice is ${f.days_overdue} days past due`);
  if (f.amount_percentile !== null && f.amount_percentile >= 90)
    parts.push("it is among your largest invoices");
  return parts.length
    ? `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase())
    : "There is no payment history for this client yet.";
}

/**
 * The risk badge's explanation. Recomputes the score first, so it is never stale. Uses the stored sentence
 * if the factors have not moved; otherwise asks the model, with only the factors as input (FR-11.16). If
 * the model is unavailable or answers badly, the rule-based sentence is shown instead.
 */
export async function explainRisk(
  scope: TenantScope,
  model: ModelClient | null,
  tenantId: string,
  invoiceId: string,
) {
  const current = await scope(tenantId, (tx) => refreshRisk(tx, tenantId, invoiceId));
  if (!current) return { level: null, explanation: null, by: "none" as const };
  if (current.explanation)
    return { level: current.level, explanation: current.explanation, by: "ai" as const };

  const result = await runAi(scope, model, {
    tenantId,
    purpose: "risk_explain",
    system: RISK_SYSTEM,
    content: riskContent(current.factors, current.level),
    hashText: JSON.stringify(current.factors),
    schema: RiskExplainOutput,
    invoiceId,
    maxTokens: 250,
  });
  const sentences = result.ok ? result.output.explanation.split(/(?<=[.!?])\s+/).length : 0;
  if (!result.ok || sentences > 2 || /\$|\d{4}-\d{2}-\d{2}/.test(result.output.explanation)) {
    return {
      level: current.level,
      explanation: describeFactors(current.factors),
      by: "rules" as const,
    };
  }
  await scope(tenantId, (tx) =>
    tx
      .update(invoices)
      .set({ riskExplanation: result.output.explanation })
      .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, OPEN))),
  );
  return { level: current.level, explanation: result.output.explanation, by: "ai" as const };
}
