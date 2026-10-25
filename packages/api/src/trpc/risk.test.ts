import { createScriptedModel } from "@repo/ai/fake";
import { addDays, localDate, realNow } from "@repo/clock";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { addClient, connectPayments, createHarness, sendInvoiceTo, type Harness } from "../testing";
import { overdueSweep } from "../usecases/scheduler";

let h: Harness;
let acme: string;
let n = 0;
const today = () => localDate(realNow(), "America/New_York");
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];
const explain = (invoiceId: string) =>
  h.staff("invoices.explainRisk", { cookie: acme, body: { invoiceId } });
const risk = async (id: string) =>
  (
    await q<{
      risk_level: string | null;
      risk_factors: Record<string, any> | null;
      risk_explanation: string | null;
    }>(`select risk_level, risk_factors, risk_explanation from invoices where id = '${id}'`)
  )[0]!;

/** A client with `late` invoices paid 20 days late and `onTime` paid on the day. */
async function clientWithHistory(late: number, onTime: number) {
  const clientId = await addClient(h, acme, `c${++n}@history.test`);
  const rows = [
    ...Array.from({ length: late }, (_, i) => ({
      due: addDays(today(), -100 + i * 3),
      lateBy: 20,
    })),
    ...Array.from({ length: onTime }, (_, i) => ({
      due: addDays(today(), -200 + i * 3),
      lateBy: 0,
    })),
  ];
  for (const r of rows) {
    await h.testDbAdmin(
      `insert into invoices (tenant_id, client_id, status, due_date, issue_date, total_minor, paid_minor, paid_at)
       select tenant_id, id, 'paid', '${r.due}', '${addDays(r.due, -14)}', 50000, 50000, ('${addDays(r.due, r.lateBy)}'::date + time '12:00') at time zone 'America/New_York' from clients where id = '${clientId}'`,
    );
  }
  return clientId;
}

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  await connectPayments(h, acme);
}, 60_000);
afterAll(() => h?.close());
beforeEach(() => h.testDbAdmin(`update firms set ai_monthly_cap_cents = 500`));

describe("risk score (P5-08)", () => {
  it("has no opinion about a client with no history", async () => {
    const clientId = await addClient(h, acme, `new${++n}@x.test`);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const r = await risk(id);
    expect(r.risk_level).toBe("low");
    expect(r.risk_factors).toMatchObject({
      late_rate: null,
      avg_days_late: null,
      broken_promises: 0,
      days_overdue: 0,
    });
  });

  it("scores a habitually late client high, from plain numbers", async () => {
    const clientId = await clientWithHistory(4, 0);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const r = await risk(id);
    expect(r.risk_factors).toMatchObject({ late_rate: 1, avg_days_late: 20 });
    expect(r.risk_level).toBe("high");
  });

  it("scores a reliable client low", async () => {
    const clientId = await clientWithHistory(0, 5);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const r = await risk(id);
    expect(r.risk_factors).toMatchObject({ late_rate: 0, avg_days_late: null });
    expect(r.risk_level).toBe("low");
  });

  it("counts broken promises, and never gates sending", async () => {
    const clientId = await clientWithHistory(1, 1);
    const old = await q<{ id: string }>(
      `select id from invoices where client_id = '${clientId}' limit 1`,
    );
    for (let i = 0; i < 2; i++) {
      await h.testDbAdmin(
        `insert into promises (tenant_id, invoice_id, promised_date, source, status, prior_status) select tenant_id, id, '2026-01-0${i + 1}', 'manual', 'broken', 'sent' from invoices where id = '${old[0]!.id}'`,
      );
    }
    // Even a high-risk client's next invoice goes out.
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const r = await risk(id);
    expect(r.risk_factors!.broken_promises).toBe(2);
    expect(
      (await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } })).data.status,
    ).toBe("sent");
  });

  it("shows up in the invoice list", async () => {
    const list = (await h.staff("invoices.list", { cookie: acme })).data as Array<{
      riskLevel: string | null;
    }>;
    expect(list.some((i) => i.riskLevel === "high")).toBe(true);
  });

  it("moves when the invoice goes overdue", async () => {
    const clientId = await clientWithHistory(0, 2);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    expect((await risk(id)).risk_factors!.days_overdue).toBe(0);
    await h.testDbAdmin(
      `update invoices set due_date = '${addDays(today(), -12)}' where id = '${id}'`,
    );
    await overdueSweep(h.systemDb);
    const r = await risk(id);
    expect(r.risk_factors!.days_overdue).toBe(12);
    expect(r.risk_level).toBe("low");
    // Much later, with nothing else changed, the score has crossed a threshold.
    await h.testDbAdmin(
      `update invoices set due_date = '${addDays(today(), -35)}' where id = '${id}'`,
    );
    h.fakes.model = null;
    expect((await explain(id)).data.level).toBe("medium");
  });
});

describe("risk explanation (FR-11.16)", () => {
  const sentence = {
    explanation:
      "Most of this client's earlier invoices were paid late, and this one is already overdue.",
  };

  it("explains from the factors alone and remembers the sentence", async () => {
    const clientId = await clientWithHistory(3, 0);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const model = createScriptedModel(() => sentence);
    h.fakes.model = model;
    const first = await explain(id);
    expect(first.data).toMatchObject({
      level: "high",
      explanation: sentence.explanation,
      by: "ai",
    });
    // The model saw the numbers and nothing that identifies the client or the amount.
    const prompt = JSON.stringify(model.calls[0]);
    expect(prompt).toContain("late_rate");
    expect(prompt).not.toMatch(/Initech|history\.test|\$|500\.00|50000/);
    expect((await risk(id)).risk_explanation).toBe(sentence.explanation);

    const second = await explain(id);
    expect(second.data.explanation).toBe(sentence.explanation);
    expect(model.calls).toHaveLength(1); // not asked again while the numbers are unchanged
  });

  it("asks again when the numbers change", async () => {
    const clientId = await clientWithHistory(3, 0);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const model = createScriptedModel(() => sentence);
    h.fakes.model = model;
    await explain(id);
    await h.testDbAdmin(
      `update invoices set due_date = '${addDays(today(), -9)}' where id = '${id}'`,
    );
    await explain(id);
    expect(model.calls).toHaveLength(2);
  });

  it.each([
    ["three sentences", { explanation: "One. Two. Three." }],
    ["a dollar figure", { explanation: "They owe $5,000 and are usually late." }],
    ["an extra field", { explanation: "Often late.", advice: "Sue them." }],
    ["nothing usable", "I'm not sure."],
  ])("falls back to a rule-based sentence for %s", async (_l, reply) => {
    const clientId = await clientWithHistory(2, 1);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    h.fakes.model = createScriptedModel(() => reply);
    const res = await explain(id);
    expect(res.data.by).toBe("rules");
    expect(res.data.explanation).toMatch(/past invoices were paid late/);
    expect((await risk(id)).risk_explanation).toBeNull(); // only model sentences are stored
  });

  it("falls back when there is no model or the budget is spent", async () => {
    const clientId = await clientWithHistory(2, 1);
    const id = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    h.fakes.model = null;
    expect((await explain(id)).data.by).toBe("rules");
    h.fakes.model = createScriptedModel(() => sentence);
    await h.testDbAdmin(`update firms set ai_monthly_cap_cents = 0`);
    expect((await explain(id)).data.by).toBe("rules");
  });

  it("has nothing to say about a draft", async () => {
    const clientId = await addClient(h, acme, `d${++n}@x.test`);
    const draft = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: { clientId, items: [{ description: "x", quantity: "1", unitAmountMinor: 100 }] },
      })
    ).data.id;
    h.fakes.model = createScriptedModel(() => sentence);
    expect((await explain(draft)).data).toMatchObject({ level: null, explanation: null });
    expect((h.fakes.model as ReturnType<typeof createScriptedModel>).calls).toHaveLength(0);
  });
});
