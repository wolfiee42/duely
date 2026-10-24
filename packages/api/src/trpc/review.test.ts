import { addDays, localDate, realNow } from "@repo/clock";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  addClient,
  connectPayments,
  createHarness,
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
let base = 0;
const sent = () => h.fakes.email.sent.slice(base);
const today = () => localDate(realNow(), "America/New_York");
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];
const list = (cookie = acme) => h.staff("review.list", { cookie });

/** Sends an invoice and runs its first reminder through the scheduler, leaving a draft in the queue. */
async function draftedReminder() {
  const invoiceId = await sendInvoiceTo(h, acme, clientId, addDays(today(), 20));
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() - interval '1 minute' where invoice_id = '${invoiceId}'`,
  );
  const claimed = await claimDueJobs(h.systemDb);
  const [job] = await q<{ id: string }>(
    `select j.id from reminder_jobs j join policy_steps s on s.id = j.step_id where j.invoice_id = '${invoiceId}' and s.offset_days = -3`,
  );
  expect(claimed.map((c) => c.id)).toContain(job!.id);
  expect((await processJob(h.systemDb, job!.id)).outcome).toBe("drafted");
  const item = (await list()).data.find((i: { invoiceId: string }) => i.invoiceId === invoiceId);
  // The invoice email itself goes out first; the tests below look only at what follows.
  await deliverAll();
  base = h.fakes.email.sent.length;
  return { invoiceId, jobId: job!.id, item };
}
const deliverAll = async () => {
  for (const m of h.fakes.queue.messages.splice(0)) {
    if (m.type === "send_message")
      await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
  }
};

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  await connectPayments(h, acme);
  clientId = await addClient(h, acme);
  await h.staff("policies.list", { cookie: acme });
  await h.testDbAdmin(
    `update collection_policies set quiet_start = '00:00', quiet_end = '23:59', send_weekends = true`,
  );
}, 60_000);
afterAll(() => h?.close());
beforeEach(async () => {
  await h.testDbAdmin(
    `update reminder_jobs set next_run_at = now() + interval '90 days' where status = 'scheduled'`,
  );
  base = h.fakes.email.sent.length;
  h.fakes.queue.messages.length = 0;
});

describe("review queue (P4-09)", () => {
  it("shows a drafted reminder with what would be sent, to whom", async () => {
    const { item } = await draftedReminder();
    expect(item).toMatchObject({
      kind: "draft_approval",
      status: "open",
      clientName: "Initech",
      to: "bill@initech.test",
    });
    expect(item.subject).toMatch(/is due soon/);
    expect(item.body).toContain("Hello Initech");
    expect((await h.staff("review.count", { cookie: acme })).data).toBeGreaterThan(0);
    // Nothing went out.
    expect(sent()).toHaveLength(0);
  });

  it("approves a draft, and the reminder is then sent exactly once", async () => {
    const { item, jobId } = await draftedReminder();
    const res = await h.staff("review.approve", { cookie: acme, body: { itemId: item.id } });
    expect(res.status).toBe(200);
    await deliverAll();
    await deliverAll();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain("Hello Initech");
    expect(
      (await q<{ status: string }>(`select status from reminder_jobs where id = '${jobId}'`))[0]!
        .status,
    ).toBe("sent");
    expect(
      (await q<{ status: string }>(`select status from review_items where id = '${item.id}'`))[0]!
        .status,
    ).toBe("approved");
    // A second click finds nothing to approve.
    const again = await h.staff("review.approve", { cookie: acme, body: { itemId: item.id } });
    expect([again.status, again.domainCode]).toEqual([404, "review.not_found"]);
  });

  it("sends the reviewer's edits, not the template", async () => {
    const { item } = await draftedReminder();
    await h.staff("review.approve", {
      cookie: acme,
      body: {
        itemId: item.id,
        edits: {
          subject: "Quick note on your invoice",
          body: "Hi Bill, any news?\n\nView and pay: {{portal_url}}",
        },
      },
    });
    await deliverAll();
    expect(sent()[0]!.subject).toBe("Quick note on your invoice");
    expect(sent()[0]!.text).toContain("Hi Bill, any news?");
    expect(sent()[0]!.text).toMatch(/\/api\/portal\/auth\//);
    const [row] = await q<{ status: string }>(
      `select status from review_items where id = '${item.id}'`,
    );
    expect(row!.status).toBe("edited");
    const [m] = await q<{ generated_by: string }>(
      `select generated_by from messages where id = '${item.messageId}'`,
    );
    expect(m!.generated_by).toBe("human");
  });

  it("escapes edited text in the HTML part", async () => {
    const { item } = await draftedReminder();
    await h.staff("review.approve", {
      cookie: acme,
      body: {
        itemId: item.id,
        edits: { subject: "Hi", body: "<script>alert(1)</script>\n\n{{portal_url}}" },
      },
    });
    await deliverAll();
    expect(sent()[0]!.html).not.toContain("<script>");
    expect(sent()[0]!.html).toContain("&lt;script&gt;");
  });

  it("rejects a draft: nothing is sent and the step is dropped for that invoice", async () => {
    const { item, jobId } = await draftedReminder();
    expect(
      (await h.staff("review.reject", { cookie: acme, body: { itemId: item.id } })).status,
    ).toBe(200);
    await deliverAll();
    expect(sent()).toHaveLength(0);
    expect(
      (await q<{ status: string }>(`select status from reminder_jobs where id = '${jobId}'`))[0]!
        .status,
    ).toBe("cancelled");
    expect((await list()).data.find((i: { id: string }) => i.id === item.id)).toBeUndefined();
  });

  it("closes the item instead of sending when the invoice was paid while it waited", async () => {
    const { invoiceId, item } = await draftedReminder();
    await h.testDbAdmin(
      `update invoices set status = 'paid', paid_minor = total_minor where id = '${invoiceId}'`,
    );
    const res = await h.staff("review.approve", { cookie: acme, body: { itemId: item.id } });
    expect([res.status, res.domainCode]).toEqual([409, "review.no_longer_needed"]);
    await deliverAll();
    expect(sent()).toHaveLength(0);
    const [row] = await q<{ status: string }>(
      `select status from review_items where id = '${item.id}'`,
    );
    expect(row!.status).toBe("dismissed");
  });

  it("withdraws a waiting draft when the invoice is paid or a promise is made", async () => {
    const { invoiceId, item } = await draftedReminder();
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId, promisedDate: addDays(today(), 5) },
    });
    expect((await list()).data.find((i: { id: string }) => i.id === item.id)).toBeUndefined();
    const [m] = await q<{ status: string }>(
      `select status from messages where id = '${item.messageId}'`,
    );
    expect(m!.status).toBe("cancelled");
  });

  it("keeps each firm's queue to itself", async () => {
    const { item } = await draftedReminder();
    expect((await list(globex)).data).toEqual([]);
    for (const path of ["review.approve", "review.reject", "review.dismiss"]) {
      const res = await h.staff(path, { cookie: globex, body: { itemId: item.id } });
      expect(res.status, path).toBe(404);
    }
    expect((await list()).data.some((i: { id: string }) => i.id === item.id)).toBe(true);
  });

  it("dismisses an item that needs no action, but not a draft", async () => {
    const { item, jobId } = await draftedReminder();
    expect(
      (await h.staff("review.dismiss", { cookie: acme, body: { itemId: item.id } })).domainCode,
    ).toBe("review.use_approve_or_reject");
    await h.testDbAdmin(
      `insert into review_items (tenant_id, kind, job_id, payload) select tenant_id, 'dead_job', id, '{}' from reminder_jobs where id = '${jobId}'`,
    );
    const dead = (await list()).data.find((i: { kind: string }) => i.kind === "dead_job");
    expect(
      (await h.staff("review.dismiss", { cookie: acme, body: { itemId: dead.id } })).status,
    ).toBe(200);
  });
});
