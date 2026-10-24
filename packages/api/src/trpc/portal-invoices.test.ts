import { resolveTenantByHost, withTenant } from "@repo/db";
import { auditLog } from "@repo/db/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createHarness, deliverMessage, testDeps, type Harness } from "../testing";

const ACME = "https://acme.duely.app";
const cfg = testDeps().config;

let h: Harness;
let acme: string;
let globex: string;
let acmeTenant: string;
let initechId: string;
let hooliId: string;

const drain = async () => {
  for (const m of h.fakes.queue.messages.splice(0)) {
    if (m.type === "send_message")
      await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
  }
};
const cookieFrom = async (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

async function portalLogin(host: string, email: string, ip: string) {
  await h.portal("auth.requestLink", { host, body: { email }, ip });
  await drain();
  const token = /\/api\/portal\/auth\/([\w-]{43})/.exec(h.fakes.email.sent.at(-1)!.text)![1]!;
  return cookieFrom(
    await h.app.request(`${host}/api/portal/auth/${token}`, { redirect: "manual" }),
  );
}

async function sentInvoice(cookie: string, clientId: string, amount: number) {
  const id = (
    await h.staff("invoices.createDraft", {
      cookie,
      body: { clientId, items: [{ description: "Work", quantity: "1", unitAmountMinor: amount }] },
    })
  ).data.id as string;
  const res = await h.staff("invoices.send", {
    cookie,
    body: { invoiceId: id, idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(200);
  return id;
}

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  acmeTenant = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
  for (const [cookie, name, email] of [
    [acme, "Initech", "bill@initech.test"],
    [acme, "Umbrella", "ann@umbrella.test"],
    [globex, "Hooli", "gavin@hooli.test"],
  ] as const) {
    const id = (
      await h.staff("clients.create", {
        cookie,
        body: { client: { name }, contact: { name: email.split("@")[0]!, email } },
      })
    ).data.id;
    if (name === "Initech") initechId = id;
    if (name === "Hooli") hooliId = id;
  }
  for (const [cookie] of [[acme], [globex]] as const) {
    await h.staff("stripe.connectLink", { cookie, body: {} });
    const accountId = (await h.staff("firm.get", { cookie })).data.firm.stripeAccountId;
    h.fakes.stripe.completeOnboarding(accountId);
    await h.staff("stripe.status", { cookie });
  }
}, 60_000);
afterAll(() => h?.close());
beforeEach(() => h.testDbAdmin("delete from rate_limit_events"));

describe("portal invoices", () => {
  it("lists only the signed-in client's sent invoices, never drafts", async () => {
    const sent = await sentInvoice(acme, initechId, 5000);
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: { clientId: initechId, items: [] },
    });
    const cookie = await portalLogin(ACME, "bill@initech.test", "10.0.0.1");
    const list = await h.portal("invoices.list", { host: ACME, cookie });
    expect(list.data.map((i: { id: string }) => i.id)).toEqual([sent]);
    expect(list.data[0]).toMatchObject({ status: "sent", totalMinor: 5000 });
  });

  it("requires a session", async () => {
    expect((await h.portal("invoices.list", { host: ACME })).status).toBe(401);
    expect(
      (await h.portal("invoices.get", { host: ACME, input: { invoiceId: initechId } })).status,
    ).toBe(401);
  });

  it("records the first view once: sent -> viewed, timestamp kept, one audit entry", async () => {
    const id = await sentInvoice(acme, initechId, 7000);
    const cookie = await portalLogin(ACME, "bill@initech.test", "10.0.0.2");
    const first = await h.portal("invoices.get", { host: ACME, cookie, input: { invoiceId: id } });
    expect(first.data).toMatchObject({
      id,
      status: "viewed",
      totalMinor: 7000,
      canPay: true,
      firm: { displayName: "acme" },
    });
    const stamp = (await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } })).data
      .firstViewedAt;
    expect(stamp).toBeTruthy();

    await h.portal("invoices.get", { host: ACME, cookie, input: { invoiceId: id } });
    const after = await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } });
    expect(after.data.firstViewedAt).toBe(stamp);
    const views = (await withTenant(h.db, acmeTenant, (tx) => tx.select().from(auditLog))).filter(
      (a) => a.entityId === id && a.action === "invoice.viewed",
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ actorType: "contact" });
  });

  it("another client's invoice in the same firm is a 404", async () => {
    const umbrella = (await h.staff("clients.list", { cookie: acme })).data.find(
      (c: { name: string }) => c.name === "Umbrella",
    ).id;
    const theirs = await sentInvoice(acme, umbrella, 100);
    const cookie = await portalLogin(ACME, "bill@initech.test", "10.0.0.3");
    const res = await h.portal("invoices.get", {
      host: ACME,
      cookie,
      input: { invoiceId: theirs },
    });
    expect([res.status, res.domainCode]).toEqual([404, "invoice.not_found"]);
    expect(
      (await h.staff("invoices.get", { cookie: acme, input: { invoiceId: theirs } })).data
        .firstViewedAt,
    ).toBeNull();
  });

  it("another firm's invoice is a 404, and a draft is a 404", async () => {
    const hooli = await sentInvoice(globex, hooliId, 100);
    const draft = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: { clientId: initechId, items: [] },
      })
    ).data.id;
    const cookie = await portalLogin(ACME, "bill@initech.test", "10.0.0.4");
    expect(
      (await h.portal("invoices.get", { host: ACME, cookie, input: { invoiceId: hooli } })).status,
    ).toBe(404);
    expect(
      (await h.portal("invoices.get", { host: ACME, cookie, input: { invoiceId: draft } })).status,
    ).toBe(404);
  });

  it("ignores any clientId or tenantId a caller tries to supply", async () => {
    const cookie = await portalLogin(ACME, "bill@initech.test", "10.0.0.5");
    const umbrella = (await h.staff("clients.list", { cookie: acme })).data.find(
      (c: { name: string }) => c.name === "Umbrella",
    ).id;
    const list = await h.portal("invoices.list", {
      host: ACME,
      cookie,
      input: { clientId: umbrella, tenantId: acmeTenant },
    });
    expect(list.data.every((i: { id: string }) => i.id !== undefined)).toBe(true);
    const umbrellaInvoices = (
      await h.staff("invoices.list", { cookie: acme, input: { clientId: umbrella } })
    ).data.map((i: { id: string }) => i.id);
    expect(list.data.some((i: { id: string }) => umbrellaInvoices.includes(i.id))).toBe(false);
  });

  it("shows overdue for a past-due invoice and cannot pay a voided one", async () => {
    const id = await sentInvoice(acme, initechId, 900);
    await h.testDbAdmin(`update invoices set due_date = '2020-01-01' where id = '${id}'`);
    const cookie = await portalLogin(ACME, "bill@initech.test", "10.0.0.6");
    expect(
      (await h.portal("invoices.get", { host: ACME, cookie, input: { invoiceId: id } })).data
        .effectiveStatus,
    ).toBe("overdue");
    await h.staff("invoices.void", { cookie: acme, body: { invoiceId: id, reason: "Mistake" } });
    expect(
      (await h.portal("invoices.get", { host: ACME, cookie, input: { invoiceId: id } })).data,
    ).toMatchObject({ status: "void", canPay: false });
  });
});
