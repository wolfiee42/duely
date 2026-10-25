import { resolveTenantByHost, withTenant } from "@repo/db";
import { auditLog, messages } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";
import { deliverMessage, requeueStaleMessages } from "../usecases/outbox";

let h: Harness;
let acme: string;
let tenantId: string;
let clientId: string;
let accountId: string;

const key = () => crypto.randomUUID();
const draft = async (amount = 10_000) =>
  (
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: { clientId, items: [{ description: "Work", quantity: "1", unitAmountMinor: amount }] },
    })
  ).data.id as string;
const send = (invoiceId: string, idempotencyKey = key()) =>
  h.staff("invoices.send", { cookie: acme, body: { invoiceId, idempotencyKey } });
const deliver = (id: string) =>
  deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg() }, id);
const cfg = () => ({
  platformDomain: "duely.app",
  appOrigin: "https://app.duely.app",
  cnameTarget: "customers.duely.app",
  demoEnabled: false,
  stripeWebhookSecret: "x",
  resendWebhookSecret: "x",
  stripePublishableKey: "pk",
  emailFromAddress: "billing@duely.app",
  portalSessionSecret: "x",
});
const messagesOf = (invoiceId: string) =>
  withTenant(h.db, tenantId, (tx) =>
    tx.select().from(messages).where(eq(messages.invoiceId, invoiceId)),
  );

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  tenantId = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
  clientId = (
    await h.staff("clients.create", {
      cookie: acme,
      body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
    })
  ).data.id;
  await h.staff("firm.update", {
    cookie: acme,
    body: { invoicePrefix: "AC-", defaultTermsDays: 10 },
  });
  accountId =
    (await h.staff("stripe.connectLink", { cookie: acme, body: {} }),
    (await h.staff("firm.get", { cookie: acme })).data.firm.stripeAccountId);
}, 60_000);
afterAll(() => h?.close());

describe("send guards", () => {
  it("refuses to send before Stripe is connected (422)", async () => {
    const res = await send(await draft());
    expect([res.status, res.domainCode]).toEqual([422, "invoice.charges_not_enabled"]);
  });

  it("then needs an item, a positive total and a receiving contact", async () => {
    h.fakes.stripe.completeOnboarding(accountId);
    await h.staff("stripe.status", { cookie: acme });
    const empty = (
      await h.staff("invoices.createDraft", { cookie: acme, body: { clientId, items: [] } })
    ).data.id;
    expect((await send(empty)).domainCode).toBe("invoice.no_items");
    expect((await send(await draft(0))).domainCode).toBe("invoice.zero_total");

    const lonely = (
      await h.staff("clients.create", {
        cookie: acme,
        body: {
          client: { name: "Mute" },
          contact: { name: "m", email: "m@mute.test", receivesInvoices: false },
        },
      })
    ).data.id;
    const inv = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: {
          clientId: lonely,
          items: [{ description: "x", quantity: "1", unitAmountMinor: 100 }],
        },
      })
    ).data.id;
    expect((await send(inv)).domainCode).toBe("invoice.no_contact");
  });
});

describe("sending", () => {
  it("numbers, freezes, sets dates and queues one message, then enqueues after commit", async () => {
    const id = await draft(25_000);
    const before = h.fakes.queue.messages.length;
    const res = await send(id);
    expect(res.status).toBe(200);
    expect(res.data.number).toMatch(/^AC-\d{4}$/);

    const got = await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } });
    expect(got.data).toMatchObject({ status: "sent", number: res.data.number, totalMinor: 25_000 });
    expect(got.data.sentAt).toBeTruthy();
    expect(got.data.dueDate).toBe(res.data.dueDate); // issue date + 10 days (firm terms)

    const msgs = await messagesOf(id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      kind: "invoice",
      direction: "out",
      status: "queued",
      dedupeKey: `invoice:${id}:${msgs[0]!.contactId}`,
    });
    expect(h.fakes.queue.messages.slice(before)).toEqual([
      { type: "send_message", messageId: msgs[0]!.id },
    ]);

    const audit = await withTenant(h.db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, id)),
    );
    expect(audit.map((a) => a.action)).toContain("invoice.sent");
  });

  it("assigns gapless sequential numbers, even for simultaneous sends", async () => {
    const ids = await Promise.all([draft(), draft(), draft(), draft()]);
    const sent = await Promise.all(ids.map((i) => send(i)));
    const numbers = sent.map((s) => Number(s.data.number.slice(3))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(4);
    expect(numbers[3]! - numbers[0]!).toBe(3);
  });

  it("freezes the items: edits and a second send are rejected", async () => {
    const id = await draft();
    await send(id);
    const edit = await h.staff("invoices.updateDraft", {
      cookie: acme,
      body: { invoiceId: id, clientId, items: [] },
    });
    expect(edit.domainCode).toBe("invoice.not_draft");
    const again = await send(id);
    expect([again.status, again.domainCode]).toEqual([409, "invoice.invalid_transition"]);
  });

  it("replays the same idempotency key without a second number or message", async () => {
    const id = await draft();
    const k = key();
    const first = await send(id, k);
    const second = await send(id, k);
    expect(second.data).toEqual(first.data);
    expect(await messagesOf(id)).toHaveLength(1);
  });

  it("another firm cannot send it (404)", async () => {
    const other = await h.ownerOf("globex");
    const id = await draft();
    expect(
      (
        await h.staff("invoices.send", {
          cookie: other,
          body: { invoiceId: id, idempotencyKey: key() },
        })
      ).status,
    ).toBe(404);
  });
});

describe("outbox delivery", () => {
  it("sends once, stores no live token, and a duplicate queue message is a no-op", async () => {
    const id = await draft(12_345);
    await send(id);
    const [m] = await messagesOf(id);
    const sentBefore = h.fakes.email.sent.length;

    expect(await deliver(m!.id)).toBe("sent");
    expect(await deliver(m!.id)).toBe("noop");
    expect(h.fakes.email.sent.length).toBe(sentBefore + 1);

    const mail = h.fakes.email.sent.at(-1)!;
    expect(mail).toMatchObject({ to: "bill@initech.test", from: "acme <billing@duely.app>" });
    expect(mail.subject).toMatch(/^Invoice AC-\d{4} from acme$/);
    expect(mail.html).toContain("$123.45");
    const link = /https:\/\/acme\.duely\.app\/api\/portal\/auth\/([\w-]{43})/.exec(mail.text)?.[1];
    expect(link).toBeTruthy();

    const [stored] = await messagesOf(id);
    expect(stored).toMatchObject({
      status: "sent",
      providerMessageId: expect.stringMatching(/^msg_fake_/),
    });
    expect(stored!.bodyText).not.toContain(link!);
    expect(stored!.bodyHtml).not.toContain(link!);
  });

  it("a provider failure leaves the message queued, and the retry delivers exactly one email", async () => {
    const id = await draft();
    await send(id);
    const [m] = await messagesOf(id);
    const before = h.fakes.email.sent.length;

    h.fakes.email.failNext(1);
    await expect(deliver(m!.id)).rejects.toThrow();
    expect((await messagesOf(id))[0]!.status).toBe("queued");

    expect(await deliver(m!.id)).toBe("sent");
    expect(h.fakes.email.sent.length).toBe(before + 1);
  });

  it("a crash after the provider accepted but before marking sent does not double-send", async () => {
    const id = await draft();
    await send(id);
    const [m] = await messagesOf(id);
    const before = h.fakes.email.sent.length;

    // Simulate the crash: the provider has the email under the message's idempotency key, the row is still queued.
    await h.fakes.email.send({
      to: "bill@initech.test",
      from: "x",
      subject: "s",
      html: "h",
      text: "t",
      idempotencyKey: m!.dedupeKey!,
    });
    expect(await deliver(m!.id)).toBe("sent");
    expect(h.fakes.email.sent.length).toBe(before + 1); // the retry was absorbed by the provider's idempotency
    expect((await messagesOf(id))[0]!.status).toBe("sent");
  });

  it("drops the message if the invoice was voided or the address bounced since queueing", async () => {
    const voided = await draft();
    await send(voided);
    await h.staff("invoices.void", { cookie: acme, body: { invoiceId: voided, reason: "Oops" } });
    const [vm] = await messagesOf(voided);
    const before = h.fakes.email.sent.length;
    expect(await deliver(vm!.id)).toBe("cancelled");
    expect((await messagesOf(voided))[0]!.status).toBe("cancelled");

    const bounced = await draft();
    await send(bounced);
    const [bm] = await messagesOf(bounced);
    await h.testDbAdmin(
      `update contacts set email_status = 'bounced' where id = '${bm!.contactId}'`,
    );
    expect(await deliver(bm!.id)).toBe("cancelled");
    expect(h.fakes.email.sent.length).toBe(before);
    await h.testDbAdmin(`update contacts set email_status = 'ok' where id = '${bm!.contactId}'`);
  });

  it("a permanent provider error marks the message bounced instead of retrying forever", async () => {
    const id = await draft();
    await send(id);
    const [m] = await messagesOf(id);
    h.fakes.email.failNext(1, false);
    expect(await deliver(m!.id)).toBe("cancelled");
    expect((await messagesOf(id))[0]!.status).toBe("bounced");
  });

  it("never sends real email for demo firms", async () => {
    const id = await draft();
    await send(id);
    const [m] = await messagesOf(id);
    await h.testDbAdmin(`update firms set is_demo = true where id = '${tenantId}'`);
    const before = h.fakes.email.sent.length;
    expect(await deliver(m!.id)).toBe("sent");
    expect(h.fakes.email.sent.length).toBe(before);
    expect((await messagesOf(id))[0]!.providerMessageId).toBe(`demo:${m!.id}`);
    await h.testDbAdmin(`update firms set is_demo = false where id = '${tenantId}'`);
  });

  it("re-enqueues messages stuck in queued", async () => {
    const id = await draft();
    await send(id);
    const [m] = await messagesOf(id);
    h.fakes.queue.messages.length = 0;
    expect(await requeueStaleMessages(h.systemDb, h.fakes.queue, 0)).toBeGreaterThanOrEqual(1);
    expect(h.fakes.queue.messages).toContainEqual({ type: "send_message", messageId: m!.id });
    await h.systemDb.update(messages).set({ status: "cancelled" }).where(eq(messages.id, m!.id));
    h.fakes.queue.messages.length = 0;
    await requeueStaleMessages(h.systemDb, h.fakes.queue, 0);
    expect(
      h.fakes.queue.messages.some((q) => q.type === "send_message" && q.messageId === m!.id),
    ).toBe(false);
  });
});
