import { addDays, localDate, realNow } from "@repo/clock";
import { localParts, weekday, zonedInstant } from "@repo/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createHarness, testDeps, type Harness } from "../testing";
import { deliverMessage } from "../usecases/outbox";
import { processJob } from "../usecases/process-job";
import {
  claimDueJobs,
  MAX_ATTEMPTS,
  overdueSweep,
  promiseSweep,
  reapStuckJobs,
  recordJobFailure,
  runTick,
} from "../usecases/scheduler";

// scheduler-concurrency and send-recheck (SPEC 8, CI gates).

const cfg = testDeps().config;
let h: Harness;
let acme: string;
let clientId: string;
/** Emails sent before the current test began (the fake derives provider ids from its length). */
let base = 0;
const sent = () => h.fakes.email.sent.slice(base);

const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];
const today = () => localDate(realNow(), "America/New_York");

async function connect(cookie: string) {
  await h.staff("stripe.connectLink", { cookie, body: {} });
  const accountId = (await h.staff("firm.get", { cookie })).data.firm.stripeAccountId;
  h.fakes.stripe.completeOnboarding(accountId);
  await h.staff("stripe.status", { cookie });
}
async function client(cookie: string, email = "bill@initech.test") {
  return (
    await h.staff("clients.create", {
      cookie,
      body: { client: { name: "Initech" }, contact: { name: "Bill", email } },
    })
  ).data.id as string;
}
async function sentInvoice(cookie: string, forClient: string, dueInDays: number) {
  const id = (
    await h.staff("invoices.createDraft", {
      cookie,
      body: {
        clientId: forClient,
        dueDate: addDays(today(), dueInDays),
        items: [{ description: "Work", quantity: "1", unitAmountMinor: 10_000 }],
      },
    })
  ).data.id as string;
  const sent = await h.staff("invoices.send", {
    cookie,
    body: { invoiceId: id, idempotencyKey: crypto.randomUUID() },
  });
  expect(sent.status).toBe(200);
  return id;
}
const makeDue = (invoiceId: string, where = "true") =>
  h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() - interval '1 minute' where invoice_id = '${invoiceId}' and ${where}`,
  );
const jobs = (invoiceId: string) =>
  q<{
    id: string;
    status: string;
    offset_days: number;
    attempts: number;
    message_id: string | null;
  }>(
    `select j.id, j.status, s.offset_days, j.attempts, j.message_id
       from reminder_jobs j join policy_steps s on s.id = j.step_id
      where j.invoice_id = '${invoiceId}' order by s.offset_days`,
  );
const jobAt = async (invoiceId: string, offset: number) =>
  (await jobs(invoiceId)).find((j) => j.offset_days === offset)!;
const autoSend = (tenantSlug = "acme") =>
  h.testDbAdmin(
    `update policy_steps set send_mode = 'auto' where tenant_id = (select id from firms where platform_slug = '${tenantSlug}')`,
  );
const draftMode = (tenantSlug = "acme") =>
  h.testDbAdmin(
    `update policy_steps set send_mode = 'draft' where tenant_id = (select id from firms where platform_slug = '${tenantSlug}')`,
  );
const deliver = (id: string) =>
  deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, id);

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  await connect(acme);
  clientId = await client(acme);
  // Real time decides "now" for this firm, so open its sending window all day, every day. The quiet-hours
  // behaviour has its own test on a firm whose clock is pinned.
  await h.staff("policies.list", { cookie: acme });
  await h.testDbAdmin(
    `update collection_policies set quiet_start = '00:00', quiet_end = '23:59', send_weekends = true`,
  );
}, 60_000);
afterAll(() => h?.close());
beforeEach(async () => {
  // Park every earlier job so each test sees only its own.
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() + interval '90 days' where status = 'scheduled'`,
  );
  base = h.fakes.email.sent.length;
});

describe("claiming (scheduler-concurrency gate)", () => {
  it("claims only jobs that are due", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    expect(await claimDueJobs(h.systemDb)).toEqual([]);
    await makeDue(id, "true");
    const claimed = await claimDueJobs(h.systemDb);
    expect(claimed).toHaveLength(5);
    expect((await jobs(id)).every((j) => j.status === "claimed" && j.attempts === 1)).toBe(true);
  });

  it("never hands one job to two overlapping ticks", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await sentInvoice(acme, clientId, 20 + i));
    for (const id of ids) await makeDue(id);
    // Open every pooled connection first, so the ticks genuinely overlap instead of queueing behind connects.
    await Promise.all(
      Array.from({ length: 4 }, () => h.systemDb.execute(sql`select pg_sleep(0.05)`)),
    );

    // Four ticks racing, each wanting every job on separate connections.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimDueJobs(h.systemDb, 200)),
    );
    const all = results.flat().map((j) => j.id);
    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(all.length).toBe(60);

    const attempts = await q<{ attempts: number }>(
      `select attempts from reminder_jobs where invoice_id in (${ids.map((i) => `'${i}'`).join(",")})`,
    );
    expect(attempts.every((a) => a.attempts === 1)).toBe(true);
    // Everything claimed once; a further tick finds nothing.
    expect(await claimDueJobs(h.systemDb)).toEqual([]);
  });

  it("honours a demo firm's clock offset (D6)", async () => {
    const demo = await h.ownerOf("demo");
    await connect(demo);
    const demoClient = await client(demo);
    const id = await sentInvoice(demo, demoClient, 20);
    expect(await claimDueJobs(h.systemDb)).toEqual([]);
    // Jump the firm's clock a month ahead: its jobs fall due without touching real time.
    await h.testDbAdmin(
      `update firms set is_demo = true, clock_offset_seconds = ${30 * 86_400} where platform_slug = 'demo'`,
    );
    const claimed = await claimDueJobs(h.systemDb);
    expect(claimed.length).toBeGreaterThan(0);
    expect((await jobs(id)).some((j) => j.status === "claimed")).toBe(true);
    await h.testDbAdmin(`update firms set clock_offset_seconds = 0 where platform_slug = 'demo'`);
  });

  it("a tick enqueues one process_job per claimed job and nothing for the rest", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    h.fakes.queue.messages.length = 0;
    const result = await runTick(h.systemDb, h.fakes.queue);
    expect(result.claimed).toBe(5);
    expect(h.fakes.queue.messages).toHaveLength(5);
    expect(h.fakes.queue.messages.every((m) => m.type === "process_job")).toBe(true);
    expect((await runTick(h.systemDb, h.fakes.queue)).claimed).toBe(0);
  });
});

describe("process_job", () => {
  it("drafts for approval when the step is draft-for-approval, and sends nothing", async () => {
    await draftMode();
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    const job = await jobAt(id, -3);
    await claimDueJobs(h.systemDb);

    expect(await processJob(h.systemDb, job.id)).toEqual({ outcome: "drafted" });
    const after = await jobAt(id, -3);
    expect(after.status).toBe("awaiting_approval");
    const [message] = await q<{
      status: string;
      kind: string;
      body_text: string;
      dedupe_key: string;
    }>(`select status, kind, body_text, dedupe_key from messages where id = '${after.message_id}'`);
    expect(message).toMatchObject({
      status: "draft",
      kind: "reminder",
      dedupe_key: `job:${job.id}`,
    });
    expect(message!.body_text).toContain("{{portal_url}}");
    const items = await q(
      `select 1 from review_items where job_id = '${job.id}' and kind = 'draft_approval' and status = 'open'`,
    );
    expect(items).toHaveLength(1);
    expect(sent()).toHaveLength(0);
  });

  it("queues a message for an auto-send step, and sends it exactly once", async () => {
    await autoSend();
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    const job = await jobAt(id, -3);
    await claimDueJobs(h.systemDb);

    const result = await processJob(h.systemDb, job.id);
    expect(result.outcome).toBe("queued");
    const messageId = (result as { messageId: string }).messageId;
    expect((await jobAt(id, -3)).status).toBe("enqueued");

    expect(await deliver(messageId)).toBe("sent");
    expect(await deliver(messageId)).toBe("noop"); // duplicate queue delivery
    expect(sent()).toHaveLength(1);
    const email = sent()[0]!;
    expect(email.to).toBe("bill@initech.test");
    expect(email.subject).toMatch(/is due soon/);
    expect(email.text).toMatch(/\/api\/portal\/auth\/[\w-]{43}/);
    expect(email.text).toMatch(/\/api\/unsubscribe\/[\w-]+/);
    expect(email.replyTo).toMatch(/^reply\+[\w-]+@inbound\.duely\.app$/);
    expect((await jobAt(id, -3)).status).toBe("sent");
    // The stored copy never keeps a live link.
    const [stored] = await q<{ body_html: string; body_text: string }>(
      `select body_html, body_text from messages where id = '${messageId}'`,
    );
    expect(stored!.body_html).not.toMatch(/api\/portal\/auth/);
    expect(stored!.body_text).toContain("{{portal_url}}");
  });

  it("is a no-op the second time, and two racing workers make one message", async () => {
    await autoSend();
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    const job = await jobAt(id, 0);
    await claimDueJobs(h.systemDb);
    const [a, b] = await Promise.all([
      processJob(h.systemDb, job.id),
      processJob(h.systemDb, job.id),
    ]);
    // Both end up pointing at the same single message; the second just adopts it.
    expect([a.outcome, b.outcome]).toEqual(["queued", "queued"]);
    expect((a as { messageId: string }).messageId).toBe((b as { messageId: string }).messageId);
    expect(await q(`select 1 from messages where job_id = '${job.id}'`)).toHaveLength(1);
    // A redelivered process_job after success finds its message and hands the same id back.
    const again = await processJob(h.systemDb, job.id);
    expect(["noop", "queued"]).toContain(again.outcome);
    expect(await q(`select 1 from messages where job_id = '${job.id}'`)).toHaveLength(1);
  });

  it("defers outside quiet hours and on weekends, in the client's timezone", async () => {
    const quiet = await h.ownerOf("quiet");
    await connect(quiet);
    const qClient = await client(quiet);
    const id = await sentInvoice(quiet, qClient, 20);
    // Pretend it is Saturday noon in New York for this firm.
    let day = addDays(today(), 1);
    while (weekday(day) !== 6) day = addDays(day, 1);
    const saturday = zonedInstant(day, 12 * 60, "America/New_York");
    await h.testDbAdmin(
      `update firms set is_demo = true, clock_offset_seconds = ${Math.round((saturday.getTime() - realNow().getTime()) / 1000)} where platform_slug = 'quiet'`,
    );
    await makeDue(id, "true");
    await h.testDbAdmin(
      `update reminder_jobs set next_run_at = now() - interval '1 minute' where invoice_id = '${id}'`,
    );
    const job = await jobAt(id, -3);
    await claimDueJobs(h.systemDb);
    expect((await processJob(h.systemDb, job.id)).outcome).toBe("deferred");
    const [row] = await q<{ status: string; epoch: number }>(
      `select status, extract(epoch from next_run_at)::float8 as epoch from reminder_jobs where id = '${job.id}'`,
    );
    expect(row!.status).toBe("scheduled");
    const next = new Date(row!.epoch * 1000);
    expect(localParts(next, "America/New_York")).toEqual({
      date: addDays(day, 2),
      minutes: 8 * 60,
    });
    expect(sent()).toHaveLength(0);
  });
});

describe("send-time re-check (send-recheck gate, FR-9.9)", () => {
  async function queuedReminder() {
    await autoSend();
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    const job = await jobAt(id, -3);
    await claimDueJobs(h.systemDb);
    const result = await processJob(h.systemDb, job.id);
    return { id, job, messageId: (result as { messageId: string }).messageId };
  }

  it("sends nothing if the invoice was paid after the message was queued", async () => {
    const { id, job, messageId } = await queuedReminder();
    // A payment lands between queueing and sending.
    await h.testDbAdmin(
      `update invoices set status = 'paid', paid_minor = total_minor where id = '${id}'`,
    );
    expect(await deliver(messageId)).toBe("cancelled");
    expect(sent()).toHaveLength(0);
    expect(
      (await q<{ status: string }>(`select status from messages where id = '${messageId}'`))[0]!
        .status,
    ).toBe("cancelled");
    expect(
      (await q<{ status: string }>(`select status from reminder_jobs where id = '${job.id}'`))[0]!
        .status,
    ).toBe("cancelled");
  });

  it("sends nothing if the invoice was voided", async () => {
    const { id, messageId } = await queuedReminder();
    await h.staff("invoices.void", { cookie: acme, body: { invoiceId: id, reason: "Mistake" } });
    // Voiding already withdrew the unsent message, so the late delivery has nothing to send.
    expect(await deliver(messageId)).toBe("noop");
    expect(
      (await q<{ status: string }>(`select status from messages where id = '${messageId}'`))[0]!
        .status,
    ).toBe("cancelled");
    expect(sent()).toHaveLength(0);
  });

  it("sends nothing while a dispute is open, and pauses rather than cancels the job", async () => {
    const { id, job, messageId } = await queuedReminder();
    await h.testDbAdmin(
      `insert into disputes (tenant_id, invoice_id, reason, source, prior_status)
       select tenant_id, id, 'Wrong amount', 'manual', 'sent' from invoices where id = '${id}'`,
    );
    expect(await deliver(messageId)).toBe("cancelled");
    expect(sent()).toHaveLength(0);
    const [row] = await q<{ status: string; pause_reason: string }>(
      `select status, pause_reason from reminder_jobs where id = '${job.id}'`,
    );
    expect(row).toEqual({ status: "skipped", pause_reason: "dispute" });
  });

  it("sends nothing if the contact unsubscribed or bounced meanwhile", async () => {
    const { messageId } = await queuedReminder();
    await h.testDbAdmin(
      `update contacts set email_status = 'bounced' where email = 'bill@initech.test'`,
    );
    expect(await deliver(messageId)).toBe("cancelled");
    expect(sent()).toHaveLength(0);
    await h.testDbAdmin(
      `update contacts set email_status = 'ok' where email = 'bill@initech.test'`,
    );
  });

  it("still sends when nothing changed", async () => {
    const { messageId } = await queuedReminder();
    expect(await deliver(messageId)).toBe("sent");
    expect(sent()).toHaveLength(1);
  });
});

describe("reaper and retries", () => {
  it("returns a stuck job to the schedule", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    await claimDueJobs(h.systemDb);
    await h.testDbAdmin(
      `update reminder_jobs set claimed_at = now() - interval '10 minutes' where invoice_id = '${id}'`,
    );
    expect(await reapStuckJobs(h.systemDb)).toMatchObject({ requeued: 5, dead: 0 });
    expect((await jobs(id)).every((j) => j.status === "scheduled")).toBe(true);
  });

  it("leaves a recently claimed job alone", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    await makeDue(id, "true");
    await claimDueJobs(h.systemDb);
    expect(await reapStuckJobs(h.systemDb)).toEqual({ requeued: 0, dead: 0 });
    expect((await jobs(id)).every((j) => j.status === "claimed")).toBe(true);
  });

  it("buries a job after too many attempts and puts it in front of the firm", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    const job = await jobAt(id, 0);
    await h.testDbAdmin(
      `update reminder_jobs set status = 'claimed', claimed_at = now() - interval '10 minutes', attempts = ${MAX_ATTEMPTS} where id = '${job.id}'`,
    );
    expect((await reapStuckJobs(h.systemDb)).dead).toBe(1);
    expect((await jobAt(id, 0)).status).toBe("dead");
    expect(
      await q(`select 1 from review_items where job_id = '${job.id}' and kind = 'dead_job'`),
    ).toHaveLength(1);
  });

  it("backs a failed job off, and gives up at the limit", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    const job = await jobAt(id, 3);
    await h.testDbAdmin(
      `update reminder_jobs set status = 'claimed', claimed_at = now(), attempts = 1 where id = '${job.id}'`,
    );
    expect(await recordJobFailure(h.systemDb, job.id, "boom")).toBe("retry");
    const [row] = await q<{ status: string; last_error: string; wait: number }>(
      `select status, last_error, extract(epoch from next_run_at - now())::int wait from reminder_jobs where id = '${job.id}'`,
    );
    expect(row!.status).toBe("scheduled");
    expect(row!.last_error).toBe("boom");
    expect(row!.wait).toBeGreaterThan(60);

    await h.testDbAdmin(
      `update reminder_jobs set status = 'claimed', attempts = ${MAX_ATTEMPTS} where id = '${job.id}'`,
    );
    expect(await recordJobFailure(h.systemDb, job.id, "boom")).toBe("dead");
  });
});

describe("sweeps", () => {
  it("marks past-due invoices overdue and leaves the rest", async () => {
    const late = await sentInvoice(acme, clientId, 5);
    const fine = await sentInvoice(acme, clientId, 5);
    await h.testDbAdmin(
      `update invoices set due_date = '${addDays(today(), -2)}' where id = '${late}'`,
    );
    expect(await overdueSweep(h.systemDb)).toBeGreaterThanOrEqual(1);
    const status = async (id: string) =>
      (await q<{ status: string }>(`select status from invoices where id = '${id}'`))[0]!.status;
    expect(await status(late)).toBe("overdue");
    expect(await status(fine)).toBe("sent");
    expect(await overdueSweep(h.systemDb)).toBe(0); // idempotent
  });

  it("breaks a promise once the grace period is over: invoice overdue again, schedule resumes", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId: id, promisedDate: addDays(today(), 3) },
    });
    expect((await jobs(id)).every((j) => j.status === "skipped")).toBe(true);

    // Not yet: inside the promised date plus one day of grace.
    expect(await promiseSweep(h.systemDb)).toBe(0);
    await h.testDbAdmin(
      `update promises set promised_date = '${addDays(today(), -2)}' where invoice_id = '${id}'`,
    );
    await h.testDbAdmin(
      `update invoices set due_date = '${addDays(today(), -5)}' where id = '${id}'`,
    );
    expect(await promiseSweep(h.systemDb)).toBe(1);

    const [invoice] = await q<{ status: string }>(`select status from invoices where id = '${id}'`);
    expect(invoice!.status).toBe("overdue");
    expect(
      (await q<{ status: string }>(`select status from promises where invoice_id = '${id}'`))[0]!
        .status,
    ).toBe("broken");
    const states = (await jobs(id)).map((j) => j.status);
    expect(states).toContain("scheduled");
    expect(states).not.toContain("claimed");
    expect(await promiseSweep(h.systemDb)).toBe(0);
  });

  it("keeps a promise that is paid in time", async () => {
    const id = await sentInvoice(acme, clientId, 20);
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId: id, promisedDate: addDays(today(), 3) },
    });
    await h.testDbAdmin(
      `update promises set promised_date = '${addDays(today(), -2)}' where invoice_id = '${id}'`,
    );
    await h.testDbAdmin(`update promises set status = 'kept' where invoice_id = '${id}'`);
    expect(await promiseSweep(h.systemDb)).toBe(0);
  });
});
