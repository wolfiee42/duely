import { addDays, localDate, realNow } from "@repo/clock";
import { resolveTenantByHost } from "@repo/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";

let h: Harness;
let acme: string;
let globex: string;
let member: string;
let clientId: string;

const query = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];
const policies = async (cookie = acme) => (await h.staff("policies.list", { cookie })).data;
const settings = {
  name: "Gentle",
  quietStart: "09:00",
  quietEnd: "17:00",
  sendWeekends: false,
  promiseGraceDays: 2,
};
const step = (offsetDays: number, over = {}) => ({
  offsetDays,
  templateKey: "overdue",
  tone: "neutral",
  sendMode: "draft",
  escalateNotifyFirm: false,
  ...over,
});

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  member = await h.signUp("member@acme.test");
  await h.testDbAdmin(`
    insert into members (tenant_id, user_id, email, role)
    select f.id, u.id, u.email, 'member' from firms f, "user" u
     where f.platform_slug = 'acme' and u.email = 'member@acme.test'`);
  clientId = (
    await h.staff("clients.create", {
      cookie: acme,
      body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
    })
  ).data.id;
  void resolveTenantByHost;
}, 60_000);
afterAll(() => h?.close());

describe("policies (P4-03)", () => {
  it("gives every new firm a default policy of draft-for-approval steps", async () => {
    const [policy, ...rest] = await policies();
    expect(rest).toEqual([]);
    expect(policy).toMatchObject({
      isDefault: true,
      quietStart: "08:00",
      quietEnd: "19:00",
      sendWeekends: false,
      promiseGraceDays: 1,
    });
    expect(policy.steps.map((s: { offsetDays: number }) => s.offsetDays)).toEqual([
      -3, 0, 3, 7, 14,
    ]);
    expect(policy.steps.every((s: { sendMode: string }) => s.sendMode === "draft")).toBe(true);
    expect(policy.steps.at(-1).escalateNotifyFirm).toBe(true);
  });

  it("lets anyone on the team read policies but only owners change them", async () => {
    expect((await h.staff("policies.list", { cookie: member })).status).toBe(200);
    const res = await h.staff("policies.create", {
      cookie: member,
      body: { settings, steps: [step(1)] },
    });
    expect(res.status).toBe(403);
  });

  it("creates a policy, and keeps firms separate", async () => {
    const res = await h.staff("policies.create", {
      cookie: acme,
      body: { settings, steps: [step(5, { tone: "firm" }), step(-1, { templateKey: "pre_due" })] },
    });
    expect(res.status).toBe(200);
    const created = (await policies()).find((p: { name: string }) => p.name === "Gentle");
    expect(created.isDefault).toBe(false);
    expect(created.steps.map((s: { offsetDays: number }) => s.offsetDays)).toEqual([-1, 5]);
    expect((await policies(globex)).map((p: { name: string }) => p.name)).not.toContain("Gentle");
    // Another firm cannot touch it.
    const hack = await h.staff("policies.update", {
      cookie: globex,
      body: { policyId: created.id, settings, steps: [step(1)] },
    });
    expect([hack.status, hack.domainCode]).toEqual([404, "policy.not_found"]);
  });

  it.each([
    ["no steps", { settings, steps: [] }, "policy.invalid_steps"],
    ["two steps on one day", { settings, steps: [step(2), step(2)] }, "policy.duplicate_offset"],
    [
      "a window that ends before it starts",
      { settings: { ...settings, quietStart: "18:00", quietEnd: "09:00" }, steps: [step(1)] },
      "policy.invalid_window",
    ],
  ])("rejects %s", async (_label, body, code) => {
    const res = await h.staff("policies.create", { cookie: acme, body });
    expect(res.domainCode).toBe(code);
  });

  it("archives only the steps that changed, so planned jobs keep their step", async () => {
    const [def] = await policies();
    const keep = def.steps[0];
    const changed = def.steps[1];
    const res = await h.staff("policies.update", {
      cookie: acme,
      body: {
        policyId: def.id,
        settings: { ...settings, name: def.name },
        steps: [
          { ...keep },
          { ...changed, tone: "firm" },
          ...def.steps.slice(2).map((s: object) => ({ ...s })),
        ],
      },
    });
    expect(res.status).toBe(200);
    const [after] = await policies();
    expect(after.quietStart).toBe("09:00");
    expect(after.steps[0].id).toBe(keep.id); // untouched
    expect(after.steps[1].id).not.toBe(changed.id); // replaced
    expect(after.steps[1].tone).toBe("firm");
    const archived = await query<{ n: string }>(
      `select count(*) n from policy_steps where archived_at is not null`,
    );
    expect(Number(archived[0]!.n)).toBe(1);
  });

  it("switches the default and refuses to delete it", async () => {
    const list = await policies();
    const other = list.find((p: { isDefault: boolean }) => !p.isDefault);
    expect(
      (await h.staff("policies.setDefault", { cookie: acme, body: { policyId: other.id } })).status,
    ).toBe(200);
    const now = await policies();
    expect(now.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
    expect(now.find((p: { id: string }) => p.id === other.id).isDefault).toBe(true);

    const old = now.find((p: { id: string }) => p.id !== other.id);
    expect(
      (await h.staff("policies.delete", { cookie: acme, body: { policyId: other.id } })).domainCode,
    ).toBe("policy.is_default");
    // Put the original default back for the following tests.
    await h.staff("policies.setDefault", { cookie: acme, body: { policyId: old.id } });
  });

  it("assigns a client override, rejects another firm's policy, and falls back when it is deleted", async () => {
    const [def, other] = [
      (await policies()).find((p: { isDefault: boolean }) => p.isDefault),
      (await policies()).find((p: { isDefault: boolean }) => !p.isDefault),
    ];
    const foreign = (await policies(globex))[0];
    const bad = await h.staff("clients.update", {
      cookie: acme,
      body: { clientId, policyId: foreign.id },
    });
    expect([bad.status, bad.domainCode]).toEqual([404, "policy.not_found"]);

    expect(
      (await h.staff("clients.update", { cookie: acme, body: { clientId, policyId: other.id } }))
        .status,
    ).toBe(200);
    expect(await query(`select 1 from clients where policy_id = '${other.id}'`)).toHaveLength(1);
    expect(
      (await h.staff("policies.delete", { cookie: acme, body: { policyId: other.id } })).status,
    ).toBe(200);
    expect(await query(`select 1 from clients where policy_id is not null`)).toHaveLength(0);
    expect((await policies()).map((p: { id: string }) => p.id)).toEqual([def.id]);
  });
});

describe("planning on send, and cancelling (P4-04)", () => {
  const today = () => localDate(realNow(), "America/New_York");
  const send = async (dueInDays: number) => {
    const id = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: {
          clientId,
          dueDate: addDays(today(), dueInDays),
          items: [{ description: "Work", quantity: "1", unitAmountMinor: 10_000 }],
        },
      })
    ).data.id as string;
    return id;
  };
  const jobs = (invoiceId: string) =>
    query<{
      status: string;
      planned_for: string;
      pause_reason: string | null;
      offset_days: number;
    }>(
      `select j.status, j.planned_for::text, j.pause_reason, s.offset_days
         from reminder_jobs j join policy_steps s on s.id = j.step_id
        where j.invoice_id = '${invoiceId}' order by s.offset_days`,
    );
  const connect = async () => {
    await h.staff("stripe.connectLink", { cookie: acme, body: {} });
    const accountId = (await h.staff("firm.get", { cookie: acme })).data.firm.stripeAccountId;
    h.fakes.stripe.completeOnboarding(accountId);
    await h.staff("stripe.status", { cookie: acme });
  };
  const sendIt = (invoiceId: string) =>
    h.staff("invoices.send", {
      cookie: acme,
      body: { invoiceId, idempotencyKey: crypto.randomUUID() },
    });

  beforeAll(connect);

  it("plans one job per step when an invoice is sent, and none before", async () => {
    const id = await send(20);
    expect(await jobs(id)).toEqual([]);
    expect((await sendIt(id)).status).toBe(200);
    const planned = await jobs(id);
    expect(planned.map((j) => j.offset_days)).toEqual([-3, 0, 3, 7, 14]);
    expect(planned.every((j) => j.status === "scheduled")).toBe(true);
    expect(planned[1]!.planned_for).toBe(addDays(today(), 20));
  });

  it("skips pre-due notices that are already in the past and sends only one catch-up", async () => {
    const id = await send(-10); // 10 days late
    await sendIt(id);
    const byOffset = Object.fromEntries((await jobs(id)).map((j) => [j.offset_days, j.status]));
    expect(byOffset).toEqual({
      "-3": "skipped",
      "0": "skipped",
      "3": "skipped",
      "7": "scheduled",
      "14": "scheduled",
    });
  });

  it("uses the client's own policy when they have an override", async () => {
    const created = await h.staff("policies.create", {
      cookie: acme,
      body: { settings: { ...settings, name: "Short" }, steps: [step(2)] },
    });
    expect(created.status).toBe(200);
    const [short] = (await policies()).filter((p: { name: string }) => p.name === "Short");
    await h.staff("clients.update", { cookie: acme, body: { clientId, policyId: short.id } });
    const id = await send(20);
    await sendIt(id);
    expect((await jobs(id)).map((j) => j.offset_days)).toEqual([2]);
    await h.staff("clients.update", { cookie: acme, body: { clientId, policyId: null } });
  });

  it("cancels every pending job when the invoice is voided, for good", async () => {
    const id = await send(20);
    await sendIt(id);
    expect(
      (await h.staff("invoices.void", { cookie: acme, body: { invoiceId: id, reason: "Mistake" } }))
        .status,
    ).toBe(200);
    expect((await jobs(id)).every((j) => j.status === "cancelled")).toBe(true);
    // The database refuses to bring a cancelled job back.
    await expect(
      h.testDbAdmin(`update reminder_jobs set status = 'scheduled' where invoice_id = '${id}'`),
    ).rejects.toThrow(/cannot change/);
  });

  it("changing the policy afterwards does not move jobs already planned", async () => {
    const id = await send(20);
    await sendIt(id);
    const before = await jobs(id);
    const [def] = (await policies()).filter((p: { isDefault: boolean }) => p.isDefault);
    await h.staff("policies.update", {
      cookie: acme,
      body: {
        policyId: def.id,
        settings: { ...settings, name: def.name },
        steps: [step(1), step(30)],
      },
    });
    expect(await jobs(id)).toEqual(before);
  });
});

describe("pausing and resuming (P4-08)", () => {
  const today = () => localDate(realNow(), "America/New_York");
  let invoiceId: string;
  const jobs = () =>
    query<{ status: string; pause_reason: string | null }>(
      `select status, pause_reason from reminder_jobs where invoice_id = '${invoiceId}' order by planned_for`,
    );

  beforeAll(async () => {
    // Back to the standard five steps.
    const [def] = (await policies()).filter((p: { isDefault: boolean }) => p.isDefault);
    await h.staff("policies.update", {
      cookie: acme,
      body: {
        policyId: def.id,
        settings: { ...settings, name: def.name },
        steps: [-3, 0, 3, 7, 14].map((d) => step(d)),
      },
    });
  });

  it("a promise pauses the schedule; cancelling it resumes", async () => {
    invoiceId = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: {
          clientId,
          dueDate: addDays(today(), 20),
          items: [{ description: "Work", quantity: "1", unitAmountMinor: 10_000 }],
        },
      })
    ).data.id;
    await h.staff("invoices.send", {
      cookie: acme,
      body: { invoiceId, idempotencyKey: crypto.randomUUID() },
    });
    expect((await jobs()).every((j) => j.status === "scheduled")).toBe(true);

    const promised = await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId, promisedDate: addDays(today(), 5) },
    });
    expect(promised.status).toBe(200);
    expect(await jobs()).toEqual(Array(5).fill({ status: "skipped", pause_reason: "promise" }));

    const [promise] = await query<{ id: string }>(
      `select id from promises where invoice_id = '${invoiceId}'`,
    );
    await h.staff("promises.cancel", { cookie: acme, body: { promiseId: promise!.id } });
    expect(await jobs()).toEqual(Array(5).fill({ status: "scheduled", pause_reason: null }));
  });

  const sendFresh = async () => {
    invoiceId = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: {
          clientId,
          dueDate: addDays(today(), 20),
          items: [{ description: "Work", quantity: "1", unitAmountMinor: 10_000 }],
        },
      })
    ).data.id;
    await h.staff("invoices.send", {
      cookie: acme,
      body: { invoiceId, idempotencyKey: crypto.randomUUID() },
    });
  };

  it("a dispute pauses the schedule; resolving it resumes", async () => {
    await sendFresh();
    const opened = await h.staff("disputes.open", {
      cookie: acme,
      body: { invoiceId, reason: "Wrong amount" },
    });
    expect(opened.status).toBe(200);
    expect(await jobs()).toEqual(Array(5).fill({ status: "skipped", pause_reason: "dispute" }));

    const [d] = await query<{ id: string }>(
      `select id from disputes where invoice_id = '${invoiceId}'`,
    );
    await h.staff("disputes.resolve", {
      cookie: acme,
      body: { disputeId: d!.id, outcome: "resolved", note: "Fixed" },
    });
    expect(await jobs()).toEqual(Array(5).fill({ status: "scheduled", pause_reason: null }));
  });

  it("stays paused while a promise is still active after the dispute ends", async () => {
    await sendFresh();
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId, promisedDate: addDays(today(), 5) },
    });
    await h.staff("disputes.open", { cookie: acme, body: { invoiceId, reason: "Wrong amount" } });
    const [d] = await query<{ id: string }>(
      `select id from disputes where invoice_id = '${invoiceId}'`,
    );
    await h.staff("disputes.resolve", {
      cookie: acme,
      body: { disputeId: d!.id, outcome: "resolved", note: "Fixed" },
    });
    expect((await jobs()).every((j) => j.status === "skipped")).toBe(true);
  });
});

describe("policy preview (P4-12)", () => {
  const preview = (body: object, cookie = acme) =>
    h.staff("policies.preview", { cookie, input: body });
  const today = () => localDate(realNow(), "America/New_York");
  const defaults = [-3, 0, 3, 7, 14].map((d) => step(d));

  it("projects each step's date and local send time for a sample invoice", async () => {
    const dueDate = addDays(today(), 30);
    const res = await preview({
      settings: { ...settings, quietStart: "08:00", quietEnd: "19:00" },
      steps: defaults,
      dueDate,
    });
    expect(res.status).toBe(200);
    expect(res.data.timezone).toBe("America/New_York");
    const rows = res.data.steps;
    expect(rows.map((r: { offsetDays: number }) => r.offsetDays)).toEqual([-3, 0, 3, 7, 14]);
    expect(rows[1].plannedFor).toBe(dueDate);
    for (const r of rows) {
      expect(r.action).toBe("schedule");
      expect(r.localTime).toMatch(/ 0[89]:00$/); // start of the window, never a weekend (checked next)
      expect(r.subject).toBeTruthy();
    }
    // No send lands on a weekend.
    for (const r of rows) {
      const day = new Date(`${r.localTime.slice(0, 10)}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(day);
    }
  });

  it("shows a skipped step and a single catch-up for an invoice that is already late", async () => {
    const res = await preview({ settings, steps: defaults, dueDate: addDays(today(), -10) });
    const byOffset = Object.fromEntries(
      res.data.steps.map((r: { offsetDays: number; action: string }) => [r.offsetDays, r.action]),
    );
    expect(byOffset).toEqual({
      "-3": "skip",
      "0": "skip",
      "3": "skip",
      "7": "schedule",
      "14": "schedule",
    });
  });

  it("previews unsaved settings in another client timezone", async () => {
    const dueDate = addDays(today(), 30);
    const res = await preview({
      settings: { ...settings, quietStart: "09:00", quietEnd: "17:00", sendWeekends: true },
      steps: [step(0)],
      dueDate,
      timezone: "Australia/Sydney",
    });
    expect(res.data.timezone).toBe("Australia/Sydney");
    expect(res.data.steps[0].localTime).toBe(`${dueDate} 09:00`);
  });

  it("is open to the whole team and validates its input", async () => {
    expect(
      (await preview({ settings, steps: defaults, dueDate: addDays(today(), 5) }, member)).status,
    ).toBe(200);
    const bad = await preview({
      settings: { ...settings, quietStart: "18:00", quietEnd: "09:00" },
      steps: defaults,
      dueDate: addDays(today(), 5),
    });
    expect(bad.domainCode).toBe("policy.invalid_window");
    const tz = await preview({
      settings,
      steps: defaults,
      dueDate: addDays(today(), 5),
      timezone: "Mars/Olympus",
    });
    expect(tz.domainCode).toBe("firm.invalid_timezone");
  });
});
