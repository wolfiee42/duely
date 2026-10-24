import { addDays, localDate, realNow } from "@repo/clock";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  addClient,
  connectPayments,
  createHarness,
  postResend,
  sendInvoiceTo,
  testDeps,
  type Harness,
} from "../testing";
import { deliverMessage } from "../usecases/outbox";
import { processJob } from "../usecases/process-job";
import { claimDueJobs } from "../usecases/scheduler";

const cfg = testDeps().config;
let h: Harness;
let acme: string;
let globex: string;
let clientId: string;
let seq = 0;
const today = () => localDate(realNow(), "America/New_York");
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];

/** Sends a reminder to the client and returns the tokenized address its replies go to. */
async function reminderTo(email: string) {
  const invoiceId = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() - interval '1 minute' where invoice_id = '${invoiceId}' and step_id in (select id from policy_steps where offset_days = -3)`,
  );
  await claimDueJobs(h.systemDb);
  const [job] = await q<{ id: string }>(
    `select j.id from reminder_jobs j join policy_steps s on s.id = j.step_id where j.invoice_id = '${invoiceId}' and s.offset_days = -3`,
  );
  const { messageId } = (await processJob(h.systemDb, job!.id)) as { messageId: string };
  await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, messageId);
  const sent = h.fakes.email.sent.filter((m) => m.to === email).at(-1)!;
  return { invoiceId, replyTo: sent.replyTo! };
}
const inbound = (over: Record<string, unknown> = {}) => ({
  type: "email.received",
  data: {
    email_id: `in_${++seq}`,
    from: "Bill Lumbergh <bill@initech.test>",
    to: ["billing@duely.app"],
    subject: "Re: your invoice",
    text: "I'll pay on Friday.\n\nOn Mon, 3 Jun 2026, Acme wrote:\n> Hello Initech",
    ...over,
  },
});
const post = (event: unknown) => postResend(h, "/api/inbound/email", event);
const inboundRows = () =>
  q<{
    status: string;
    invoice_id: string | null;
    body_stripped: string;
    body_text: string;
    contact_id: string | null;
  }>(
    `select status, invoice_id, body_stripped, body_text, contact_id from messages where direction = 'in' order by created_at`,
  );

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  await connectPayments(h, acme);
  await h.staff("policies.list", { cookie: acme });
  await h.testDbAdmin(
    `update collection_policies set quiet_start = '00:00', quiet_end = '23:59', send_weekends = true;
     update policy_steps set send_mode = 'auto'`,
  );
  clientId = await addClient(h, acme);
}, 60_000);
afterAll(() => h?.close());
beforeEach(async () => {
  h.fakes.queue.messages.length = 0;
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() + interval '90 days' where status = 'scheduled'`,
  );
});

describe("inbound email (P4-11)", () => {
  it("rejects unsigned requests and the wrong host", async () => {
    expect((await postResend(h, "/api/inbound/email", inbound(), { signature: null })).status).toBe(
      400,
    );
    expect(
      (await postResend(h, "/api/inbound/email", inbound(), { host: "https://acme.duely.app" }))
        .status,
    ).toBe(404);
    expect(await inboundRows()).toEqual([]);
  });

  it("matches a reply by its tokenized address, strips the quote, and queues it for review", async () => {
    const { invoiceId, replyTo } = await reminderTo("bill@initech.test");
    expect(replyTo).toMatch(/^reply\+[\w-]+@inbound\.duely\.app$/);

    const res = await post(inbound({ to: [replyTo] }));
    expect([res.status, res.outcome]).toEqual([200, "matched"]);

    const [row] = await inboundRows();
    expect(row).toMatchObject({
      status: "received",
      invoice_id: invoiceId,
      body_stripped: "I'll pay on Friday.",
    });
    expect(row!.body_text).toContain("Hello Initech"); // raw body is kept (FR-8.6)
    expect(row!.contact_id).not.toBeNull();

    const items = (await h.staff("review.list", { cookie: acme })).data.filter(
      (i: { kind: string }) => i.kind === "low_confidence_reply",
    );
    expect(items.map((i: { invoiceId: string }) => i.invoiceId)).toContain(invoiceId);
    expect(h.fakes.queue.messages.filter((m) => m.type === "classify_reply")).toEqual([
      { type: "classify_reply", messageId: expect.any(String) },
    ]);
  });

  it("matches by token even when the reply comes from a different address", async () => {
    const { invoiceId, replyTo } = await reminderTo("bill@initech.test");
    const res = await post(inbound({ from: "accounts-payable@initech-corp.test", to: [replyTo] }));
    expect(res.outcome).toBe("matched");
    const rows = await inboundRows();
    expect(rows.at(-1)!.invoice_id).toBe(invoiceId);
  });

  it("stores a redelivered webhook once", async () => {
    const { replyTo } = await reminderTo("bill@initech.test");
    const event = inbound({ to: [replyTo] });
    const before = (await inboundRows()).length;
    expect((await post(event)).outcome).toBe("matched");
    expect((await post(event)).outcome).toBe("duplicate");
    expect((await inboundRows()).length).toBe(before + 1);
    expect(h.fakes.queue.messages.filter((m) => m.type === "classify_reply")).toHaveLength(1);
  });

  it("falls back to sender plus invoice number in the subject", async () => {
    const invoiceId = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const [{ number }] = await q<{ number: string }>(
      `select number from invoices where id = '${invoiceId}'`,
    );
    const res = await post(inbound({ subject: `Re: Invoice ${number!.toLowerCase()} question` }));
    expect(res.outcome).toBe("matched");
    expect((await inboundRows()).at(-1)!.invoice_id).toBe(invoiceId);
  });

  it("puts a known sender with no identifiable invoice in that firm's queue, and staff can assign it", async () => {
    const res = await post(inbound({ subject: "Quick question" }));
    expect(res.outcome).toBe("unmatched");
    const item = (await h.staff("review.list", { cookie: acme })).data.find(
      (i: { kind: string }) => i.kind === "unmatched_inbound",
    );
    expect(item).toBeTruthy();
    expect((await h.staff("review.list", { cookie: globex })).data).toEqual([]);

    const invoiceId = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    const assigned = await h.staff("review.assign", {
      cookie: acme,
      body: { itemId: item.id, invoiceId },
    });
    expect(assigned.status).toBe(200);
    const last = (await inboundRows()).at(-1)!;
    expect(last).toMatchObject({ status: "received", invoice_id: invoiceId });
    // Only unmatched items can be assigned, and only once.
    expect(
      (await h.staff("review.assign", { cookie: acme, body: { itemId: item.id, invoiceId } }))
        .status,
    ).toBe(404);
  });

  it("keeps mail from an unknown sender instead of dropping it", async () => {
    const res = await post(inbound({ from: "stranger@nowhere.test", subject: "Hello?" }));
    expect([res.status, res.outcome]).toEqual([200, "unrouted"]);
    const rows = await q<{ from_email: string; subject: string }>(
      `select from_email, subject from unrouted_inbound`,
    );
    expect(rows).toEqual([{ from_email: "stranger@nowhere.test", subject: "Hello?" }]);
    expect((await post(inbound({ from: "stranger@nowhere.test", email_id: "same" }))).outcome).toBe(
      "unrouted",
    );
    expect((await post(inbound({ from: "stranger@nowhere.test", email_id: "same" }))).outcome).toBe(
      "duplicate",
    );
  });

  it("will not guess when a sender is known to two firms and nothing else identifies the mail", async () => {
    const other = await addClient(h, globex, "shared@both.test");
    await addClient(h, acme, "shared@both.test");
    expect(other).toBeTruthy();
    const res = await post(inbound({ from: "shared@both.test", subject: "Hi" }));
    expect(res.outcome).toBe("unrouted");
    expect((await h.staff("review.list", { cookie: globex })).data).toEqual([]);
  });

  it("ignores event types other than a received email", async () => {
    expect((await post({ type: "email.sent", data: { email_id: "x" } })).outcome).toBe("ignored");
  });

  it("answers 400 to a malformed event", async () => {
    expect((await post({ type: "email.received", data: { subject: "no ids" } })).status).toBe(400);
  });
});
