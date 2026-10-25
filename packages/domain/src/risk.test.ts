import { describe, expect, it } from "vite-plus/test";

import { computeRiskFactors, riskLevel, type HistoryInvoice } from "./risk";

const today = "2026-06-30";
const base = { issueDate: "2026-06-01", dueDate: "2026-06-15", totalMinor: 100_000 };
const paid = (due: string, paidDate: string): HistoryInvoice => ({
  dueDate: due,
  paidDate,
  status: "paid",
});

describe("computeRiskFactors", () => {
  it("has nothing to say about a new client", () => {
    const f = computeRiskFactors({
      today,
      invoice: base,
      history: [],
      brokenPromises: 0,
      firmTotals: [],
    });
    expect(f).toEqual({
      late_rate: null,
      avg_days_late: null,
      broken_promises: 0,
      invoice_age_days: 29,
      days_overdue: 15,
      amount_percentile: null,
    });
    expect(riskLevel(f)).toBe("low"); // 15 days overdue is one point; nothing else is known
  });

  it("counts late payments and unpaid overdue invoices", () => {
    const f = computeRiskFactors({
      today,
      invoice: base,
      history: [
        paid("2026-01-10", "2026-01-10"), // on time
        paid("2026-02-10", "2026-02-20"), // 10 days late
        paid("2026-03-10", "2026-03-30"), // 20 days late
        { dueDate: "2026-04-10", paidDate: null, status: "overdue" }, // still unpaid
      ],
      brokenPromises: 1,
      firmTotals: [],
    });
    expect(f.late_rate).toBe(0.75);
    expect(f.avg_days_late).toBe(15);
    expect(riskLevel(f)).toBe("high");
  });

  it("ignores voided invoices and ones without a due date", () => {
    const f = computeRiskFactors({
      today,
      invoice: base,
      history: [
        { dueDate: "2026-01-10", paidDate: null, status: "void" },
        { dueDate: null, paidDate: null, status: "sent" },
        paid("2026-02-10", "2026-02-09"),
      ],
      brokenPromises: 0,
      firmTotals: [],
    });
    expect(f.late_rate).toBe(0);
  });

  it("places the amount among the firm's other invoices", () => {
    const f = computeRiskFactors({
      today,
      invoice: { ...base, totalMinor: 500_000 },
      history: [],
      brokenPromises: 0,
      firmTotals: [10_000, 20_000, 30_000, 40_000, 600_000],
    });
    expect(f.amount_percentile).toBe(80);
  });

  it("is not overdue before the due date", () => {
    const f = computeRiskFactors({
      today: "2026-06-10",
      invoice: base,
      history: [],
      brokenPromises: 0,
      firmTotals: [],
    });
    expect(f.days_overdue).toBe(0);
    expect(riskLevel(f)).toBe("low");
  });
});

describe("riskLevel", () => {
  const f = (over: Partial<Parameters<typeof riskLevel>[0]>) => ({
    late_rate: null,
    avg_days_late: null,
    broken_promises: 0,
    invoice_age_days: 0,
    days_overdue: 0,
    amount_percentile: null,
    ...over,
  });
  it("adds up plain thresholds", () => {
    expect(riskLevel(f({}))).toBe("low");
    expect(riskLevel(f({ broken_promises: 1 }))).toBe("low");
    expect(riskLevel(f({ broken_promises: 1, days_overdue: 10 }))).toBe("medium");
    expect(riskLevel(f({ late_rate: 0.6, avg_days_late: 20 }))).toBe("high");
    expect(riskLevel(f({ broken_promises: 2, days_overdue: 40 }))).toBe("high");
    expect(riskLevel(f({ amount_percentile: 95, days_overdue: 10 }))).toBe("medium");
  });
});
