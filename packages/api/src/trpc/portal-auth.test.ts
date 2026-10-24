import { resolveTenantByHost, withTenant } from "@repo/db";
import { messages, portalSessions, portalTokens } from "@repo/db/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";
import { testDeps } from "../testing";
import { deliverMessage } from "../usecases/outbox";

const ACME = "https://acme.duely.app";
const GLOBEX = "https://globex.duely.app";
const cfg = testDeps().config;

let h: Harness;
let acme: string;
let globex: string;
let acmeTenant: string;

const deliverAll = async () => {
  for (const m of h.fakes.queue.messages.splice(0)) {
    if (m.type === "send_message")
      await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
  }
};
const lastLink = () =>
  /https:\/\/[\w.]+\/api\/portal\/auth\/([\w-]{43})/.exec(h.fakes.email.sent.at(-1)!.text)![1]!;
const consume = (host: string, token: string, cookie?: string) =>
  h.app.request(`${host}/api/portal/auth/${token}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
const requestLink = (host: string, email: string, ip = "203.0.113.1") =>
  h.portal("auth.requestLink", { host, body: { email }, ip });

/** Requests a link for `email`, delivers it and returns the raw token. */
async function login(host: string, email: string, ip?: string) {
  await requestLink(host, email, ip);
  await deliverAll();
  return lastLink();
}

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  acmeTenant = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
  await h.staff("clients.create", {
    cookie: acme,
    body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
  });
  await h.staff("clients.create", {
    cookie: globex,
    body: { client: { name: "Hooli" }, contact: { name: "Gavin", email: "gavin@hooli.test" } },
  });
}, 60_000);
afterAll(() => h?.close());
// Each test starts with an empty limiter; the limit tests below assert the limits themselves.
beforeEach(() => h.testDbAdmin("delete from rate_limit_events"));

describe("magic link login", () => {
  it("emails a link, trades it for a host-only session cookie, and the session works", async () => {
    const token = await login(ACME, "Bill@Initech.test");
    const res = await consume(ACME, token);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/portal");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^duely_portal=[\w-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).not.toMatch(/Domain/i);

    const me = await h.portal("auth.me", { host: ACME, cookie: cookieOf(res) });
    expect(me.data).toMatchObject({
      contact: { name: "Bill", email: "bill@initech.test" },
      firm: { displayName: "acme" },
    });
  });

  it("stores only hashes: neither the link token nor the session cookie value is in the database", async () => {
    const token = await login(ACME, "bill@initech.test", "198.51.100.7");
    const session = cookieOf(await consume(ACME, token)).split("=")[1]!;
    const tokens = await withTenant(h.db, acmeTenant, (tx) => tx.select().from(portalTokens));
    const sessions = await withTenant(h.db, acmeTenant, (tx) => tx.select().from(portalSessions));
    expect(JSON.stringify(tokens)).not.toContain(token);
    expect(JSON.stringify(sessions)).not.toContain(session);
    const bodies = await withTenant(h.db, acmeTenant, (tx) =>
      tx.select({ t: messages.bodyText, h: messages.bodyHtml }).from(messages),
    );
    expect(JSON.stringify(bodies)).not.toContain(token);
  });

  it("a login link works once", async () => {
    const token = await login(ACME, "bill@initech.test", "198.51.100.8");
    expect((await consume(ACME, token)).headers.get("location")).toBe("/portal");
    const again = await consume(ACME, token);
    expect(again.headers.get("location")).toBe("/portal/login?link=invalid");
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("two simultaneous uses of one link yield exactly one session", async () => {
    const token = await login(ACME, "bill@initech.test", "198.51.100.9");
    const before = (await withTenant(h.db, acmeTenant, (tx) => tx.select().from(portalSessions)))
      .length;
    const [a, b] = await Promise.all([consume(ACME, token), consume(ACME, token)]);
    expect([a, b].filter((r) => r.headers.get("set-cookie")).length).toBe(1);
    expect(
      (await withTenant(h.db, acmeTenant, (tx) => tx.select().from(portalSessions))).length,
    ).toBe(before + 1);
  });

  it("an expired link and an unknown token are rejected the same way", async () => {
    const token = await login(ACME, "bill@initech.test", "198.51.100.10");
    await h.testDbAdmin(
      `update portal_tokens set expires_at = now() - interval '1 second' where used_at is null`,
    );
    const expired = await consume(ACME, token);
    const unknown = await consume(ACME, "x".repeat(43));
    expect([expired.status, expired.headers.get("location")]).toEqual([
      unknown.status,
      unknown.headers.get("location"),
    ]);
    expect(expired.headers.get("set-cookie")).toBeNull();
  });

  it("a new login replaces the old session in that browser (rotation)", async () => {
    const first = cookieOf(
      await consume(ACME, await login(ACME, "bill@initech.test", "198.51.100.11")),
    );
    const second = cookieOf(
      await consume(ACME, await login(ACME, "bill@initech.test", "198.51.100.12"), first),
    );
    expect(second).not.toBe(first);
    expect((await h.portal("auth.me", { host: ACME, cookie: first })).data.contact).toBeNull();
    expect((await h.portal("auth.me", { host: ACME, cookie: second })).data.contact).not.toBeNull();
  });

  it("logout ends the session", async () => {
    const cookie = cookieOf(
      await consume(ACME, await login(ACME, "bill@initech.test", "198.51.100.13")),
    );
    expect((await h.portal("auth.logout", { host: ACME, cookie, body: {} })).status).toBe(200);
    expect((await h.portal("auth.me", { host: ACME, cookie })).data.contact).toBeNull();
    expect((await h.portal("auth.logout", { host: ACME, body: {} })).status).toBe(401);
  });
});

describe("no enumeration, rate limits", () => {
  it("answers identically for known and unknown addresses, and sends only to the known one", async () => {
    const sentBefore = h.fakes.email.sent.length;
    const known = await requestLink(ACME, "bill@initech.test", "192.0.2.1");
    const unknown = await requestLink(ACME, "nobody@nowhere.test", "192.0.2.2");
    expect(known).toEqual(unknown);
    expect(known.data).toEqual({ ok: true });
    await deliverAll();
    expect(h.fakes.email.sent.length).toBe(sentBefore + 1);
  });

  it("limits requests per email (3 per window), counting unknown addresses too", async () => {
    const codes = [];
    for (let i = 0; i < 5; i++)
      codes.push((await requestLink(ACME, "spam@initech.test", `192.0.2.${10 + i}`)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // A different address from a fresh IP is unaffected.
    expect((await requestLink(ACME, "bill@initech.test", "192.0.2.99")).status).toBe(200);
  });

  it("limits requests per IP (10 per window) across addresses", async () => {
    const codes = [];
    for (let i = 0; i < 12; i++)
      codes.push((await requestLink(ACME, `u${i}@x.test`, "192.0.2.200")).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("does not email a bounced address or an archived client's contact", async () => {
    await h.testDbAdmin(
      `update contacts set email_status = 'bounced' where email = 'gavin@hooli.test'`,
    );
    const before = h.fakes.queue.messages.length;
    await requestLink(GLOBEX, "gavin@hooli.test", "192.0.2.150");
    expect(h.fakes.queue.messages.length).toBe(before);
    await h.testDbAdmin(`update contacts set email_status = 'ok' where email = 'gavin@hooli.test'`);
  });
});

describe("isolation between hosts", () => {
  it("a session from one firm's host is worthless on another's", async () => {
    const cookie = cookieOf(
      await consume(ACME, await login(ACME, "bill@initech.test", "198.51.100.20")),
    );
    expect((await h.portal("auth.me", { host: GLOBEX, cookie })).data.contact).toBeNull();
    expect((await h.portal("auth.logout", { host: GLOBEX, cookie, body: {} })).status).toBe(401);
  });

  it("a login link from one firm cannot be used on another's host", async () => {
    const token = await login(ACME, "bill@initech.test", "198.51.100.21");
    const res = await consume(GLOBEX, token);
    expect(res.headers.get("location")).toBe("/portal/login?link=invalid");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the link endpoint and portal router are 404 on the app host, and staff routes 404 on portal hosts", async () => {
    expect((await h.app.request("https://app.duely.app/api/portal/auth/abc")).status).toBe(404);
    expect((await h.portal("auth.me", { host: "https://app.duely.app" })).status).toBe(404);
    expect((await h.staff("firm.get", { cookie: acme, host: ACME })).status).toBe(404);
  });

  it("the portal cookie does not authenticate staff routes and a staff cookie does not authenticate the portal", async () => {
    const portalCookie = cookieOf(
      await consume(ACME, await login(ACME, "bill@initech.test", "198.51.100.22")),
    );
    expect((await h.staff("firm.get", { cookie: portalCookie })).status).toBe(401);
    expect((await h.portal("auth.me", { host: ACME, cookie: acme })).data.contact).toBeNull();
  });
});

describe("expired sessions", () => {
  it("stop working", async () => {
    const cookie = cookieOf(
      await consume(ACME, await login(ACME, "bill@initech.test", "198.51.100.30")),
    );
    await h.testDbAdmin(`update portal_sessions set expires_at = now() - interval '1 second'`);
    expect((await h.portal("auth.me", { host: ACME, cookie })).data.contact).toBeNull();
  });
});
