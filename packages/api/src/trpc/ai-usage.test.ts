import { createScriptedModel } from "@repo/ai/fake";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { addClient, connectPayments, createHarness, sendInvoiceTo, type Harness } from "../testing";

let h: Harness;
let owner: string;
let member: string;

beforeAll(async () => {
  h = await createHarness();
  owner = await h.ownerOf("acme");
  member = await h.signUp("member@acme.test");
  await h.testDbAdmin(`
    insert into members (tenant_id, user_id, email, role)
    select f.id, u.id, u.email, 'member' from firms f, "user" u
     where f.platform_slug = 'acme' and u.email = 'member@acme.test'`);
}, 60_000);
afterAll(() => h?.close());

describe("AI usage and limits (P5-09)", () => {
  it("starts with a $5 monthly limit, nothing spent, and automatic actions off", async () => {
    const usage = (await h.staff("ai.usage", { cookie: owner })).data;
    expect(usage).toMatchObject({
      capCents: 500,
      spentMicros: 0,
      autoActions: false,
      byPurpose: {},
      available: true,
    });
    expect(usage.monthStart).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("is readable by the team but changeable only by an owner", async () => {
    expect((await h.staff("ai.usage", { cookie: member })).status).toBe(200);
    const res = await h.staff("ai.updateSettings", { cookie: member, body: { capCents: 1 } });
    expect(res.status).toBe(403);
  });

  it("validates the limit", async () => {
    for (const capCents of [-1, 100_001, 1.5]) {
      expect(
        (await h.staff("ai.updateSettings", { cookie: owner, body: { capCents } })).status,
      ).toBe(400);
    }
  });

  it("records what is spent, by purpose, and honours a new limit straight away", async () => {
    await connectPayments(h, owner);
    const clientId = await addClient(h, owner);
    const id = await sendInvoiceTo(h, owner, clientId, "2099-01-01");
    h.fakes.model = createScriptedModel(() => ({ explanation: "Often pays late." }));
    await h.staff("invoices.explainRisk", { cookie: owner, body: { invoiceId: id } });

    const usage = (await h.staff("ai.usage", { cookie: owner })).data;
    expect(usage.byPurpose.risk_explain).toMatchObject({ calls: 1, failed: 0 });
    expect(usage.spentMicros).toBeGreaterThan(0);

    // A zero limit switches the assistant off; the next call is refused and logged as capped.
    expect(
      (await h.staff("ai.updateSettings", { cookie: owner, body: { capCents: 0 } })).status,
    ).toBe(200);
    const model = createScriptedModel(() => ({ explanation: "Again." }));
    h.fakes.model = model;
    await h.testDbAdmin(`update invoices set risk_explanation = null`);
    const res = await h.staff("invoices.explainRisk", { cookie: owner, body: { invoiceId: id } });
    expect(res.data.by).toBe("rules");
    expect(model.calls).toHaveLength(0);
    const after = (await h.staff("ai.usage", { cookie: owner })).data;
    expect(after.capCents).toBe(0);
    expect(after.byPurpose.risk_explain.failed).toBe(1);
  });

  it("turns automatic actions on and off, with an audit entry", async () => {
    await h.staff("ai.updateSettings", { cookie: owner, body: { autoActions: true } });
    expect((await h.staff("ai.usage", { cookie: owner })).data.autoActions).toBe(true);
    await h.staff("ai.updateSettings", { cookie: owner, body: { autoActions: false } });
    expect((await h.staff("ai.usage", { cookie: owner })).data.autoActions).toBe(false);
    const audits = await h.systemDb.execute(
      `select 1 from audit_log where action = 'firm.ai_settings_changed'` as never,
    );
    expect([...audits].length).toBeGreaterThanOrEqual(2);
  });

  it("reports the assistant as unavailable when no model is configured", async () => {
    h.fakes.model = null;
    expect((await h.staff("ai.usage", { cookie: owner })).data.available).toBe(false);
  });
});
