// SPEC 5.4. A rule-based score from a client's payment history. The model only ever explains these
// numbers (FR-11.16); it never decides the level, and the level never gates sending (FR-11.17).

export interface HistoryInvoice {
  dueDate: string | null;
  /** Local date the invoice was paid, or null if unpaid. */
  paidDate: string | null;
  status: string;
}

export interface RiskFactors {
  /** Share of this client's past invoices that were paid late or are overdue. Null with no history. */
  late_rate: number | null;
  /** Average days late over the ones paid late. Null if none were. */
  avg_days_late: number | null;
  broken_promises: number;
  /** Days since the invoice was issued. */
  invoice_age_days: number;
  /** Days past due; 0 if not yet due. */
  days_overdue: number;
  /** 0 to 100: how this invoice's amount compares with the firm's other invoices. Null with no others. */
  amount_percentile: number | null;
}

export type RiskLevel = "low" | "medium" | "high";

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function computeRiskFactors(input: {
  today: string;
  invoice: { issueDate: string | null; dueDate: string | null; totalMinor: number };
  /** The client's other invoices, excluding drafts and this one. */
  history: readonly HistoryInvoice[];
  brokenPromises: number;
  /** Totals of the firm's other sent invoices, for the amount percentile. */
  firmTotals: readonly number[];
}): RiskFactors {
  const settled = input.history.filter((h) => h.dueDate && h.status !== "void");
  const lateDays = settled
    .filter((h) => h.paidDate && h.paidDate > h.dueDate!)
    .map((h) => daysBetween(h.dueDate!, h.paidDate!));
  const stillOverdue = settled.filter((h) => !h.paidDate && h.dueDate! < input.today).length;
  const late = lateDays.length + stillOverdue;

  const { issueDate, dueDate } = input.invoice;
  const below = input.firmTotals.filter((t) => t < input.invoice.totalMinor).length;
  return {
    late_rate: settled.length ? round(late / settled.length) : null,
    avg_days_late: lateDays.length
      ? round(lateDays.reduce((a, b) => a + b, 0) / lateDays.length)
      : null,
    broken_promises: input.brokenPromises,
    invoice_age_days: issueDate ? Math.max(0, daysBetween(issueDate, input.today)) : 0,
    days_overdue: dueDate && dueDate < input.today ? daysBetween(dueDate, input.today) : 0,
    amount_percentile: input.firmTotals.length
      ? Math.round((below / input.firmTotals.length) * 100)
      : null,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Points per factor, summed. Thresholds are deliberately plain so a firm can see why a score came out as it did. */
export function riskLevel(f: RiskFactors): RiskLevel {
  let points = 0;
  if (f.late_rate !== null) points += f.late_rate >= 0.5 ? 2 : f.late_rate >= 0.25 ? 1 : 0;
  if (f.avg_days_late !== null) points += f.avg_days_late >= 14 ? 2 : f.avg_days_late >= 5 ? 1 : 0;
  points += f.broken_promises >= 2 ? 2 : f.broken_promises === 1 ? 1 : 0;
  points += f.days_overdue > 30 ? 2 : f.days_overdue > 7 ? 1 : 0;
  if (f.amount_percentile !== null && f.amount_percentile >= 90) points += 1;
  return points >= 4 ? "high" : points >= 2 ? "medium" : "low";
}
