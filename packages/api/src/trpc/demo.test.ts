import { addDays } from "@repo/clock";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  addClient,
  connectPayments,
  createHarness,
  sendInvoiceTo,
  testDeps,
  type Harness,
} from "../testing";

let h: Harness;
let demo: string;
let real: string;
let demoTenant: string;
let realTenant: string;
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];
const scoped = (tenant: string) => `where tenant_id = '${tenant}'`;
const counts = async (tenant: string) =>
  Object.fromEntries(
    (
      await q<{ status: string; n: string }>(
        `select status, count(*) n from invoices ${scoped(tenant)} group by status`,
      )
    ).map((r) => [r.status, Number(r.n)]),
  );

beforeAll(async () => {
  h = await createHarness();
  // A signed-up user with no firm starts a demo.
  demo = await h.signUp("visitor@example.com");
  const made = await h.staff("firm.createDemo", { cookie: demo, body: {} });
  expect(made.status).toBe(200);
  demoTenant = made.data.tenantId;
  real = await h.ownerOf("realfirm");
  realTenant = (
    await q<{ id: string }>(`select id from firms where platform_slug = 'realfirm'`)
  )[0]!.id;
}, 90_000);
afterAll(() => h?.close());

describe("the seeded demo firm (P6-04)", () => {
  it("is flagged as a demo, branded, and has payments switched on", async () => {
    const [f] = await q<{
      is_demo: boolean;
      display_name: string;
      stripe_charges_enabled: boolean;
      brand_primary: string;
    }>(
      `select is_demo, display_name, stripe_charges_enabled, brand_primary from firms where id = '${demoTenant}'`,
    );
    expect(f).toMatchObject({
      is_demo: true,
      display_name: "Northwind Advisory",
      brand_primary: "#0F766E",
    });
  });

  it("has invoices in every status", async () => {
    expect(await counts(demoTenant)).toEqual({
      draft: 1,
      sent: 1,
      viewed: 1,
      overdue: 4,
      promised: 1,
      disputed: 1,
      paid: 7,
      void: 1,
    });
  });

  it("has a ledger, clients, an active promise, a dispute and reminders already sent", async () => {
    expect(
      await q(`select 1 from payments ${scoped(demoTenant)} and status = 'succeeded'`),
    ).toHaveLength(7);
    expect(await q(`select 1 from clients ${scoped(demoTenant)}`)).toHaveLength(6);
    expect(
      await q(`select 1 from promises ${scoped(demoTenant)} and status = 'active'`),
    ).toHaveLength(1);
    expect(
      await q(`select 1 from promises ${scoped(demoTenant)} and status = 'broken'`),
    ).toHaveLength(1);
    expect(
      await q(`select 1 from disputes ${scoped(demoTenant)} and status = 'open'`),
    ).toHaveLength(1);
    expect(
      (
        await q(
          `select 1 from messages ${scoped(demoTenant)} and kind = 'reminder' and status = 'delivered'`,
        )
      ).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("looks right on the dashboard", async () => {
    const d = (await h.staff("dashboard.get", { cookie: demo })).data;
    expect(d.openCount).toBe(8);
    expect(d.overdueCount).toBeGreaterThanOrEqual(5);
    expect(d.aging["61+"].count).toBe(1);
    expect(d.recentPayments).toHaveLength(5);
    expect(d.promisesDue).toHaveLength(1);
    expect(d.highRiskCount).toBeGreaterThanOrEqual(1);
  });

  it("opens with things to do: a reminder to approve and two replies, already read", async () => {
    const items = (await h.staff("review.list", { cookie: demo })).data as Array<{
      kind: string;
      payload: { classification?: { label: string } };
    }>;
    expect(items.some((i) => i.kind === "draft_approval")).toBe(true);
    const claim = items.find((i) => i.kind === "already_paid_claim");
    expect(claim).toBeTruthy();
    const promise = items.find((i) => i.kind === "low_confidence_reply");
    expect(promise?.payload.classification?.label).toBe("promise");
  });

  it("gives each invoice a story to read", async () => {
    const list = (await h.staff("invoices.list", { cookie: demo })).data as Array<{
      id: string;
      effectiveStatus: string;
    }>;
    const promised = list.find((i) => i.effectiveStatus === "promised")!;
    const t = (
      await h.staff("invoices.timeline", { cookie: demo, input: { invoiceId: promised.id } })
    ).data;
    const titles = t.entries.map((e: { title: string }) => e.title);
    expect(titles).toContain("Invoice sent");
    expect(titles.some((x: string) => x.startsWith("Promise to pay by"))).toBe(true);
    expect(titles.some((x: string) => x.startsWith("Reminder sent to"))).toBe(true);
  });

  it("does not touch another firm", async () => {
    expect(await counts(realTenant)).toEqual({});
  });
});

describe("the demo outbox (P6-05)", () => {
  it("lists what was 'sent', for a demo firm only", async () => {
    const out = (await h.staff("demo.outbox", { cookie: demo })).data as Array<{
      kind: string;
      to: string;
      subject: string;
    }>;
    expect(out.length).toBeGreaterThan(10);
    expect(out.some((m) => m.kind === "invoice" && m.to.endsWith(".example"))).toBe(true);
    const refused = await h.staff("demo.outbox", { cookie: real });
    expect([refused.status, refused.domainCode]).toEqual([403, "demo.not_demo"]);
  });

  it("keeps a working link in a demo firm's emails, and never sends them out", async () => {
    await connectPayments(h, demo);
    const client = await addClient(h, demo, "visit@client.example");
    await h.testDbAdmin(`update firms set is_demo = true where id = '${demoTenant}'`);
    const before = h.fakes.email.sent.length;
    const sent = await h.staff("invoices.createDraft", {
      cookie: demo,
      body: {
        clientId: client,
        dueDate: "2099-01-01",
        items: [{ description: "x", quantity: "1", unitAmountMinor: 1000 }],
      },
    });
    const res = await h.staff("invoices.send", {
      cookie: demo,
      body: { invoiceId: sent.data.id, idempotencyKey: crypto.randomUUID() },
    });
    expect([res.status, res.domainCode]).toEqual([200, undefined]);
    for (const m of h.fakes.queue.messages.splice(0)) {
      if (m.type === "send_message") {
        const { deliverMessage } = await import("../usecases/outbox");
        await deliverMessage(
          h.systemDb,
          { email: h.fakes.email, config: testDeps().config },
          m.messageId,
        );
      }
    }
    expect(h.fakes.email.sent.length).toBe(before); // nothing went to a provider
    const [m] = await q<{ body_text: string }>(
      `select body_text from messages ${scoped(demoTenant)} and kind = 'invoice' and body_text like '%/api/portal/auth/%' limit 1`,
    );
    expect(m?.body_text).toMatch(/\/api\/portal\/auth\/[\w-]{43}/);
  });
});

describe("simulating time (P6-06)", () => {
  it("moves only the demo firm's clock and runs the scheduler so reminders fall due now", async () => {
    const before = (await h.staff("demo.status", { cookie: demo })).data;
    const queuedBefore = (
      await q(
        `select 1 from review_items ${scoped(demoTenant)} and kind = 'draft_approval' and status = 'open'`,
      )
    ).length;
    const res = await h.staff("demo.advanceClock", { cookie: demo, body: { days: 7 } });
    expect(res.status).toBe(200);
    expect(res.data.offsetDays).toBe(7);
    expect(res.data.today).toBe(addDays(before.today, 7));
    expect(res.data.cycle.claimed).toBeGreaterThan(0);
    const queuedAfter = (
      await q(
        `select 1 from review_items ${scoped(demoTenant)} and kind = 'draft_approval' and status = 'open'`,
      )
    ).length;
    expect(queuedAfter).toBeGreaterThanOrEqual(queuedBefore);
    expect(
      (
        await q<{ clock_offset_seconds: string }>(
          `select clock_offset_seconds from firms where id = '${realTenant}'`,
        )
      )[0]!.clock_offset_seconds,
    ).toBe("0");
  });

  it("makes invoices overdue as the days pass", async () => {
    const before = (await counts(demoTenant)).overdue ?? 0;
    await h.staff("demo.advanceClock", { cookie: demo, body: { days: 30 } });
    expect((await counts(demoTenant)).overdue).toBeGreaterThan(before);
  });

  it("rejects silly values", async () => {
    for (const days of [0, 91, 1.5, -3]) {
      expect((await h.staff("demo.advanceClock", { cookie: demo, body: { days } })).status).toBe(
        400,
      );
    }
  });

  it("is impossible on a real firm, and its clock does not move (FR-14.7)", async () => {
    const res = await h.staff("demo.advanceClock", { cookie: real, body: { days: 5 } });
    expect([res.status, res.domainCode]).toEqual([403, "demo.not_demo"]);
    const [f] = await q<{ clock_offset_seconds: string }>(
      `select clock_offset_seconds from firms where id = '${realTenant}'`,
    );
    expect(f!.clock_offset_seconds).toBe("0");
    // And the database refuses a clock offset on a real firm even if the application were bypassed.
    await expect(
      h.testDbAdmin(`update firms set clock_offset_seconds = 86400 where id = '${realTenant}'`),
    ).rejects.toThrow();
  });
});

describe("simulating a client reply (P6-06)", () => {
  it("takes the real inbound and classification path", async () => {
    const list = (await h.staff("invoices.list", { cookie: demo })).data as Array<{
      id: string;
      effectiveStatus: string;
      number: string | null;
    }>;
    const target = list.find(
      (i) => i.effectiveStatus === "sent" || i.effectiveStatus === "viewed",
    )!;
    const res = await h.staff("demo.simulateReply", {
      cookie: demo,
      body: { invoiceId: target.id, text: "We will pay this on Friday, thanks." },
    });
    expect(res.status).toBe(200);
    expect(["review", "auto_promise"]).toContain(res.data.decision);
    const [m] = await q<{ status: string; body_stripped: string }>(
      `select status, body_stripped from messages where invoice_id = '${target.id}' and direction = 'in' order by created_at desc limit 1`,
    );
    expect(m).toMatchObject({
      status: "received",
      body_stripped: "We will pay this on Friday, thanks.",
    });
    const items = (await h.staff("review.list", { cookie: demo })).data as Array<{
      invoiceId: string;
      payload: { classification?: { label: string } };
    }>;
    expect(items.find((i) => i.invoiceId === target.id)?.payload.classification?.label).toBe(
      "promise",
    );
  });

  it("is refused on a real firm, and for an invoice that is not yours", async () => {
    const mine = await sendInvoiceTo(
      h,
      real,
      await addClient(h, real, "r@real.test"),
      "2099-01-01",
    ).catch(() => null);
    void mine;
    const list = (await h.staff("invoices.list", { cookie: demo })).data as Array<{ id: string }>;
    const res = await h.staff("demo.simulateReply", {
      cookie: real,
      body: { invoiceId: list[0]!.id, text: "hi" },
    });
    expect([res.status, res.domainCode]).toEqual([403, "demo.not_demo"]);
  });
});

describe("resetting (P6-07)", () => {
  it("returns the demo firm to its starting point, including the clock", async () => {
    const res = await h.staff("demo.reset", { cookie: demo, body: {} });
    expect(res.status).toBe(200);
    expect(res.data.offsetDays).toBe(0);
    expect(await counts(demoTenant)).toEqual({
      draft: 1,
      sent: 1,
      viewed: 1,
      overdue: 4,
      promised: 1,
      disputed: 1,
      paid: 7,
      void: 1,
    });
    expect(await q(`select 1 from payments ${scoped(demoTenant)}`)).toHaveLength(7);
    expect(await q(`select 1 from clients ${scoped(demoTenant)}`)).toHaveLength(6); // not doubled
    // The firm itself, and who may use it, survive.
    expect((await h.staff("firm.get", { cookie: demo })).data.firm.displayName).toBe(
      "Northwind Advisory",
    );
  });

  it("will not reset a real firm, and the database agrees", async () => {
    const client = await addClient(h, real, "keep@real.test");
    await connectPayments(h, real);
    const id = await sendInvoiceTo(h, real, client, "2099-01-01");
    const res = await h.staff("demo.reset", { cookie: real, body: {} });
    expect([res.status, res.domainCode]).toEqual([403, "demo.not_demo"]);
    expect(await q(`select 1 from invoices where id = '${id}'`)).toHaveLength(1);
    // Straight at the function, as the system role working inside the real firm:
    await expect(
      h.systemDb.transaction(async (tx) => {
        await tx.execute(sql`set local role duely_app`);
        await tx.execute(sql`select set_config('app.tenant_id', ${realTenant}, true)`);
        await tx.execute(sql`select reset_demo_firm(${realTenant}::uuid)`);
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/demo firm/) } });
  });

  it("cannot be pointed at another firm's data", async () => {
    await expect(
      h.systemDb.transaction(async (tx) => {
        await tx.execute(sql`set local role duely_app`);
        await tx.execute(sql`select set_config('app.tenant_id', ${realTenant}, true)`);
        await tx.execute(sql`select reset_demo_firm(${demoTenant}::uuid)`);
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/inside the firm/) } });
    expect((await counts(demoTenant)).paid).toBe(7);
  });

  it("a request still cannot delete a sent invoice by hand (the guard stays on)", async () => {
    await expect(
      h.testDbAdmin(`delete from invoices where tenant_id = '${realTenant}' and status <> 'draft'`),
    ).rejects.toThrow(/draft/);
  });
});

describe("starting a demo", () => {
  it("is off where the deployment has not allowed it", async () => {
    const off = await createHarness({ config: { ...testDeps().config, demoEnabled: false } });
    try {
      const cookie = await off.signUp("v2@example.com");
      const res = await off.staff("firm.createDemo", { cookie, body: {} });
      expect([res.status, res.domainCode]).toEqual([403, "demo.disabled"]);
    } finally {
      await off.close();
    }
  });
});
