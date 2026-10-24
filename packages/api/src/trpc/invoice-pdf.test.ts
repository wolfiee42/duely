import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { APP, createHarness, deliverMessage, testDeps, type Harness } from "../testing";

const ACME = "https://acme.duely.app";
const cfg = testDeps().config;

let h: Harness;
let acme: string;
let globex: string;
let clientId: string;
let portalCookie: string;
let sentId: string;
let draftId: string;

const get = (host: string, id: string, cookie?: string) =>
  h.app.request(`${host}/api/invoices/${id}/pdf`, { headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  await h.staff("stripe.connectLink", { cookie: acme, body: {} });
  h.fakes.stripe.completeOnboarding(
    (await h.staff("firm.get", { cookie: acme })).data.firm.stripeAccountId,
  );
  await h.staff("stripe.status", { cookie: acme });
  clientId = (
    await h.staff("clients.create", {
      cookie: acme,
      body: {
        client: { name: "Initech <&> Ünïcode ✓" },
        contact: { name: "Bill", email: "bill@initech.test" },
      },
    })
  ).data.id;
  const items = Array.from({ length: 60 }, (_, i) => ({
    description: `Line ${i + 1} — consulting ✓ ${"long description ".repeat(6)}`,
    quantity: "1.5",
    unitAmountMinor: 1000 + i,
  }));
  sentId = (
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: { clientId, notes: "Thanks — pay within 14 days ✓", items },
    })
  ).data.id;
  draftId = (
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: {
        clientId,
        items: [{ description: "Draft work", quantity: "1", unitAmountMinor: 100 }],
      },
    })
  ).data.id;
  await h.staff("invoices.send", {
    cookie: acme,
    body: { invoiceId: sentId, idempotencyKey: crypto.randomUUID() },
  });

  await h.portal("auth.requestLink", {
    host: ACME,
    body: { email: "bill@initech.test" },
    ip: "10.1.1.1",
  });
  for (const m of h.fakes.queue.messages.splice(0)) {
    if (m.type === "send_message")
      await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
  }
  const token = /\/api\/portal\/auth\/([\w-]{43})/.exec(h.fakes.email.sent.at(-1)!.text)![1]!;
  portalCookie = (
    await h.app.request(`${ACME}/api/portal/auth/${token}`, { redirect: "manual" })
  ).headers
    .get("set-cookie")!
    .split(";")[0]!;
}, 60_000);
afterAll(() => h?.close());
beforeEach(() => h.testDbAdmin("delete from rate_limit_events"));

describe("invoice PDF", () => {
  it("renders a real multi-page PDF for staff, including characters the font lacks", async () => {
    const res = await get(APP, sentId, acme);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toMatch(/^Invoice /);
  });

  it("staff can preview a draft; the portal cannot see one", async () => {
    expect((await get(APP, draftId, acme)).status).toBe(200);
    expect((await get(ACME, draftId, portalCookie)).status).toBe(404);
  });

  it("the contact downloads their own invoice on the portal host", async () => {
    const res = await get(ACME, sentId, portalCookie);
    expect(res.status).toBe(200);
    expect(
      (await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))).getPageCount(),
    ).toBeGreaterThan(0);
  });

  it("requires a session on both hosts", async () => {
    expect((await get(APP, sentId)).status).toBe(401);
    expect((await get(ACME, sentId)).status).toBe(401);
  });

  it("another firm's staff and a portal session from another host get 404, not the file", async () => {
    expect((await get(APP, sentId, globex)).status).toBe(404);
    expect((await get("https://globex.duely.app", sentId, portalCookie)).status).toBe(401);
  });

  it("is not served on marketing or unknown hosts, and unknown ids are 404", async () => {
    expect((await get("https://duely.app", sentId, acme)).status).toBe(404);
    expect((await get("https://evil.example", sentId, acme)).status).toBe(404);
    expect((await get(APP, crypto.randomUUID(), acme)).status).toBe(404);
  });
});
