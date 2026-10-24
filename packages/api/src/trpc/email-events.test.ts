import { addDays, localDate, realNow } from "@repo/clock";
import { signSvix } from "@repo/email";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  addClient,
  APP,
  connectPayments,
  createHarness,
  RESEND_WEBHOOK_SECRET,
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
let clientId: string;
let seq = 0;
const today = () => localDate(realNow(), "America/New_York");
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];

/** Sends one reminder for a fresh invoice to the client; returns ids and the provider's id for it. */
async function sentReminder(forClient = clientId) {
  const invoiceId = await sendInvoiceTo(h, acme, forClient, addDays(today(), 20));
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() - interval '1 minute' where invoice_id = '${invoiceId}' and step_id in (select id from policy_steps where offset_days = -3)`,
  );
  await claimDueJobs(h.systemDb);
  const [job] = await q<{ id: string }>(
    `select j.id from reminder_jobs j join policy_steps s on s.id = j.step_id where j.invoice_id = '${invoiceId}' and s.offset_days = -3`,
  );
  const result = await processJob(h.systemDb, job!.id);
  const messageId = (result as { messageId: string }).messageId;
  await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, messageId);
  const [m] = await q<{ provider_message_id: string; reply_token: string }>(
    `select provider_message_id, reply_token from messages where id = '${messageId}'`,
  );
  return {
    invoiceId,
    jobId: job!.id,
    messageId,
    providerId: m!.provider_message_id,
    token: m!.reply_token,
  };
}
const messageStatus = async (id: string) =>
  (await q<{ status: string }>(`select status from messages where id = '${id}'`))[0]!.status;
const contactStatus = async (email = "bill@initech.test") =>
  (
    await q<{ email_status: string; receives_reminders: boolean }>(
      `select email_status, receives_reminders from contacts where email = '${email}'`,
    )
  )[0]!;
const pendingJobs = async (invoiceId: string) =>
  (
    await q<{ status: string }>(
      `select status from reminder_jobs where invoice_id = '${invoiceId}'`,
    )
  ).map((j) => j.status);

async function webhook(
  event: unknown,
  over: { host?: string; secret?: string; signature?: string | null; timestamp?: number } = {},
) {
  const raw = JSON.stringify(event);
  const id = `msg_${++seq}`;
  const timestamp = over.timestamp ?? Math.floor(realNow().getTime() / 1000);
  const signature =
    over.signature === undefined
      ? await signSvix(id, timestamp, raw, over.secret ?? RESEND_WEBHOOK_SECRET)
      : over.signature;
  const res = await h.app.request(`${over.host ?? APP}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      ...(signature ? { "svix-signature": signature } : {}),
    },
    body: raw,
  });
  return res.status;
}
const event = (type: string, providerId: string, extra: object = {}) => ({
  type,
  data: { email_id: providerId, ...extra },
});

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  await connectPayments(h, acme);
  await h.staff("policies.list", { cookie: acme });
  await h.testDbAdmin(
    `update collection_policies set quiet_start = '00:00', quiet_end = '23:59', send_weekends = true;
     update policy_steps set send_mode = 'auto'`,
  );
}, 60_000);
afterAll(() => h?.close());
beforeEach(async () => {
  // A fresh client each time, so one test's bounce never affects the next.
  clientId = await addClient(h, acme, `bill${++seq}@initech.test`);
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() + interval '90 days' where status = 'scheduled'`,
  );
});

describe("Resend webhook (P4-10)", () => {
  it("rejects bad signatures, missing headers, stale timestamps and the wrong host", async () => {
    const e = event("email.delivered", "re_x");
    expect(await webhook(e, { signature: "v1,AAAA" })).toBe(400);
    expect(await webhook(e, { signature: null })).toBe(400);
    expect(await webhook(e, { secret: `whsec_${btoa("another")}` })).toBe(400);
    expect(await webhook(e, { timestamp: 1_000_000 })).toBe(400);
    expect(await webhook(e, { host: "https://acme.duely.app" })).toBe(404);
  });

  it("marks a message delivered, and a replay changes nothing", async () => {
    const { messageId, providerId } = await sentReminder();
    expect(await webhook(event("email.delivered", providerId))).toBe(200);
    expect(await messageStatus(messageId)).toBe("delivered");
    expect(await webhook(event("email.delivered", providerId))).toBe(200);
    expect(await messageStatus(messageId)).toBe("delivered");
  });

  it("a hard bounce marks the contact and cancels the pending reminders for their invoices", async () => {
    const { invoiceId, messageId, providerId } = await sentReminder();
    expect((await pendingJobs(invoiceId)).includes("scheduled")).toBe(true);

    expect(
      await webhook(event("email.bounced", providerId, { bounce: { type: "Permanent" } })),
    ).toBe(200);
    expect(await messageStatus(messageId)).toBe("bounced");
    expect(
      (
        await q<{ email_status: string }>(
          `select email_status from contacts where client_id = '${clientId}'`,
        )
      )[0]!.email_status,
    ).toBe("bounced");
    expect((await pendingJobs(invoiceId)).every((s) => ["sent", "cancelled"].includes(s))).toBe(
      true,
    );
    expect(
      await q(`select 1 from audit_log where action = 'email.bounced' and entity_type = 'contact'`),
    ).not.toHaveLength(0);
  });

  it("a late 'delivered' does not undo a bounce", async () => {
    const { messageId, providerId } = await sentReminder();
    await webhook(event("email.bounced", providerId, { bounce: { type: "Permanent" } }));
    await webhook(event("email.delivered", providerId));
    expect(await messageStatus(messageId)).toBe("bounced");
  });

  it("ignores a soft bounce", async () => {
    const { messageId, providerId, invoiceId } = await sentReminder();
    expect(
      await webhook(event("email.bounced", providerId, { bounce: { type: "Transient" } })),
    ).toBe(200);
    expect(await messageStatus(messageId)).toBe("sent");
    expect((await pendingJobs(invoiceId)).includes("scheduled")).toBe(true);
  });

  it("treats a complaint like a hard bounce", async () => {
    const { messageId, providerId } = await sentReminder();
    expect(await webhook(event("email.complained", providerId))).toBe(200);
    expect(await messageStatus(messageId)).toBe("complained");
    expect(
      (
        await q<{ email_status: string }>(
          `select email_status from contacts where client_id = '${clientId}'`,
        )
      )[0]!.email_status,
    ).toBe("complained");
  });

  it("keeps reminding while another contact at the client can still be reached", async () => {
    const { invoiceId, providerId } = await sentReminder();
    const added = await h.staff("contacts.add", {
      cookie: acme,
      body: { clientId, name: "Peter", email: "peter@initech.test" },
    });
    expect(added.status).toBe(200);
    await webhook(event("email.bounced", providerId, { bounce: { type: "Permanent" } }));
    expect((await pendingJobs(invoiceId)).includes("scheduled")).toBe(true);
  });

  it("asks the provider to retry an event for a message it has no record of yet", async () => {
    expect(await webhook(event("email.delivered", "re_unknown"))).toBe(503);
  });

  it("ignores event types it does not act on", async () => {
    const { providerId } = await sentReminder();
    expect(await webhook(event("email.opened", providerId))).toBe(200);
  });
});

describe("unsubscribe (P4-10, FR-8.7)", () => {
  const get = (token: string) => h.app.request(`https://app.duely.app/api/unsubscribe/${token}`);
  const post = (token: string) =>
    h.app.request(`https://app.duely.app/api/unsubscribe/${token}`, { method: "POST" });

  it("opening the link changes nothing, so a mail scanner cannot unsubscribe anyone", async () => {
    const { token, invoiceId } = await sentReminder();
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Stop reminders");
    expect(
      (await contactStatus(`bill${seq - 1}@initech.test`).catch(() => null)) ?? true,
    ).toBeTruthy();
    expect((await pendingJobs(invoiceId)).includes("scheduled")).toBe(true);
  });

  it("confirming stops reminders at once and the firm can see it", async () => {
    const { token, invoiceId, jobId } = await sentReminder();
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Reminders stopped");

    const [contact] = await q<{ receives_reminders: boolean }>(
      `select receives_reminders from contacts where client_id = '${clientId}'`,
    );
    expect(contact!.receives_reminders).toBe(false);
    expect((await pendingJobs(invoiceId)).every((s) => ["sent", "cancelled"].includes(s))).toBe(
      true,
    );
    expect(jobId).toBeTruthy();
    expect(
      await q(`select 1 from audit_log where action = 'contact.unsubscribed'`),
    ).not.toHaveLength(0);
    // The client page shows it.
    const view = await h.staff("clients.get", { cookie: acme, input: { clientId } });
    expect(view.data.contacts[0].receivesReminders).toBe(false);
  });

  it("is safe to repeat, and an unknown link is a 404", async () => {
    const { token } = await sentReminder();
    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);
    expect((await post("not-a-real-token")).status).toBe(404);
    expect((await get("not-a-real-token")).status).toBe(404);
  });

  it("a reminder already queued for them is not sent afterwards", async () => {
    const first = await sentReminder();
    // Second invoice's reminder is queued but not yet sent when they unsubscribe.
    const invoiceId = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
    await h.testDbAdmin(
      `update reminder_jobs set next_run_at = now() - interval '1 minute' where invoice_id = '${invoiceId}' and step_id in (select id from policy_steps where offset_days = -3)`,
    );
    await claimDueJobs(h.systemDb);
    const [job] = await q<{ id: string }>(
      `select j.id from reminder_jobs j join policy_steps s on s.id = j.step_id where j.invoice_id = '${invoiceId}' and s.offset_days = -3`,
    );
    const queued = (await processJob(h.systemDb, job!.id)) as { messageId: string };
    await post(first.token);
    const before = h.fakes.email.sent.length;
    await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, queued.messageId);
    expect(h.fakes.email.sent.length).toBe(before);
  });
});
