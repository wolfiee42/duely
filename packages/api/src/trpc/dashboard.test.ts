import { addDays, localDate, realNow } from "@repo/clock";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { addClient, connectPayments, createHarness, sendInvoiceTo, type Harness } from "../testing";
import { agingBucket } from "../usecases/dashboard";
import { receiveInboundEmail } from "../usecases/inbound";

let h: Harness;
let acme: string;
let globex: string;
const today = () => localDate(realNow(), "America/New_York");
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];
const dash = async (cookie = acme) => (await h.staff("dashboard.get", { cookie })).data;

describe("agingBucket", () => {
  it.each([
    [null, "current"],
    ["2026-06-10", "current"], // due today
    ["2026-06-11", "current"],
    ["2026-06-09", "1-30"],
    ["2026-05-11", "1-30"], // 30 days late
    ["2026-05-10", "31-60"],
    ["2026-04-11", "31-60"], // 60 days late
    ["2026-04-10", "61+"],
  ])("due %s -> %s", (due, bucket) => {
    expect(agingBucket(due, "2026-06-10")).toBe(bucket);
  });
});

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  await connectPayments(h, acme);
}, 60_000);
afterAll(() => h?.close());

describe("dashboard (P6-01)", () => {
  it("starts empty", async () => {
    expect(await dash()).toMatchObject({
      outstandingMinor: 0,
      overdueMinor: 0,
      openCount: 0,
      promisesDue: [],
      recentPayments: [],
      aging: { current: { count: 0 }, "61+": { count: 0 } },
    });
  });

  it("totals what is owed, by how late, on the firm's own calendar", async () => {
    const client = await addClient(h, acme, "a@x.test");
    const make = async (days: number, amount: number, status?: string) => {
      const id = await sendInvoiceTo(h, acme, client, addDays(today(), 20), amount);
      await h.testDbAdmin(
        `update invoices set due_date = '${addDays(today(), days)}'${status ? `, status = '${status}'` : ""} where id = '${id}'`,
      );
      return id;
    };
    await make(10, 10_000); // not yet due
    await make(-5, 20_000, "overdue"); // 1-30
    await make(-45, 40_000, "overdue"); // 31-60
    await make(-90, 80_000, "overdue"); // 61+
    const half = await make(-2, 100_000, "overdue");
    await h.testDbAdmin(`update invoices set paid_minor = 30000 where id = '${half}'`); // partly paid: owes 70,000

    const d = await dash();
    expect(d.openCount).toBe(5);
    expect(d.outstandingMinor).toBe(10_000 + 20_000 + 40_000 + 80_000 + 70_000);
    expect(d.overdueMinor).toBe(20_000 + 40_000 + 80_000 + 70_000);
    expect(d.overdueCount).toBe(4);
    expect(d.aging.current).toEqual({ count: 1, amountMinor: 10_000 });
    expect(d.aging["1-30"]).toEqual({ count: 2, amountMinor: 90_000 });
    expect(d.aging["31-60"]).toEqual({ count: 1, amountMinor: 40_000 });
    expect(d.aging["61+"]).toEqual({ count: 1, amountMinor: 80_000 });
  });

  it("leaves out drafts, paid and void invoices", async () => {
    const before = (await dash()).openCount;
    const client = await addClient(h, acme, "b@x.test");
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: {
        clientId: client,
        items: [{ description: "x", quantity: "1", unitAmountMinor: 5000 }],
      },
    });
    const paid = await sendInvoiceTo(h, acme, client, addDays(today(), 5));
    await h.testDbAdmin(
      `update invoices set status = 'paid', paid_minor = total_minor where id = '${paid}'`,
    );
    const voided = await sendInvoiceTo(h, acme, client, addDays(today(), 5));
    await h.staff("invoices.void", { cookie: acme, body: { invoiceId: voided, reason: "x" } });
    expect((await dash()).openCount).toBe(before);
  });

  it("lists promises due in the next seven days, soonest first, and nothing beyond", async () => {
    const client = await addClient(h, acme, "c@x.test");
    const ids = [
      await sendInvoiceTo(h, acme, client, addDays(today(), 20)),
      await sendInvoiceTo(h, acme, client, addDays(today(), 20)),
      await sendInvoiceTo(h, acme, client, addDays(today(), 20)),
    ];
    for (const [i, days] of [5, 2, 9].entries()) {
      await h.staff("promises.create", {
        cookie: acme,
        body: { invoiceId: ids[i], promisedDate: addDays(today(), days) },
      });
    }
    const due = (await dash()).promisesDue as Array<{ promisedDate: string; invoiceId: string }>;
    expect(due.map((p) => p.promisedDate)).toEqual([addDays(today(), 2), addDays(today(), 5)]);
    expect(due.map((p) => p.invoiceId)).toEqual([ids[1], ids[0]]);
  });

  it("shows the latest successful payments only", async () => {
    const client = await addClient(h, acme, "d@x.test");
    const id = await sendInvoiceTo(h, acme, client, addDays(today(), 20));
    for (const [i, status] of ["succeeded", "failed", "succeeded"].entries()) {
      await h.testDbAdmin(
        `insert into payments (tenant_id, invoice_id, stripe_payment_intent_id, method, status, amount_minor, succeeded_at)
         select tenant_id, id, 'pi_dash_${i}', 'card', '${status}', ${1000 * (i + 1)}, ${status === "succeeded" ? `now() + interval '${i} minutes'` : "null"} from invoices where id = '${id}'`,
      );
    }
    const recent = (await dash()).recentPayments as Array<{ amountMinor: number }>;
    expect(recent.map((p) => p.amountMinor)).toEqual([3000, 1000]);
  });

  it("reads the firm's simulated clock, and is private to the firm", async () => {
    expect((await dash(globex)).openCount).toBe(0);
    await h.testDbAdmin(
      `update firms set is_demo = true, clock_offset_seconds = ${40 * 86_400} where platform_slug = 'acme'`,
    );
    const later = await dash();
    expect(later.today).toBe(addDays(today(), 40));
    expect(later.aging.current.count).toBeLessThan(5); // earlier "not yet due" invoices are now late
    await h.testDbAdmin(`update firms set clock_offset_seconds = 0 where platform_slug = 'acme'`);
  });
});

describe("invoice timeline (P6-02)", () => {
  it("tells the story in order, in plain words", async () => {
    const client = await addClient(h, acme, "bill@initech.test");
    const id = await sendInvoiceTo(h, acme, client, addDays(today(), 20));
    const [{ number }] = await q<{ number: string }>(
      `select number from invoices where id = '${id}'`,
    );
    // The invoice email goes out.
    for (const m of h.fakes.queue.messages.splice(0)) {
      if (m.type === "send_message") {
        const { deliverMessage } = await import("../usecases/outbox");
        const { testDeps } = await import("../testing");
        await deliverMessage(
          h.systemDb,
          { email: h.fakes.email, config: testDeps().config },
          m.messageId,
        );
      }
    }
    await receiveInboundEmail(h.systemDb, {
      providerId: `tl_${crypto.randomUUID()}`,
      from: "bill@initech.test",
      to: ["billing@duely.app"],
      subject: `Re: Invoice ${number}`,
      text: "I'll pay on Friday.\n\nOn Mon, Acme wrote:\n> invoice",
    });
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId: id, promisedDate: addDays(today(), 4) },
    });

    const t = (await h.staff("invoices.timeline", { cookie: acme, input: { invoiceId: id } })).data;
    const titles = t.entries.map((e: { title: string }) => e.title);
    expect(titles).toEqual(
      [
        "Draft created",
        "Invoice sent",
        "Invoice emailed to bill@initech.test",
        "Client replied",
        `Promise to pay by ${addDays(today(), 4)}`,
      ].filter((x) => titles.includes(x)),
    );
    expect(titles).toContain("Invoice sent");
    expect(titles).toContain("Client replied");
    const reply = t.entries.find((e: { kind: string }) => e.kind === "reply");
    expect(reply.detail).toBe("I'll pay on Friday."); // the quoted history is not repeated
    // Oldest first.
    const times = t.entries.map((e: { at: string }) => new Date(e.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // No raw action names leak through.
    expect(
      titles.every((x: string) => !/^(invoice|promise|payment|dispute|reminder)\./.test(x)),
    ).toBe(true);
  });

  it("stays out of other firms' invoices", async () => {
    const [{ id }] = await q<{ id: string }>(`select id from invoices limit 1`);
    expect(
      (await h.staff("invoices.timeline", { cookie: globex, input: { invoiceId: id } })).status,
    ).toBe(404);
  });
});
