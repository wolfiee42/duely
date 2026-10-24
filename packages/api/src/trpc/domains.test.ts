import { resolveTenantByHost } from "@repo/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createHarness, testDeps, type Harness } from "../testing";
import { pollDomains } from "../usecases/domains";
import { deliverMessage } from "../usecases/outbox";

const ACME = "https://acme.duely.app";
const HOST = "billing.acmefirm.com";
const CUSTOM = `https://${HOST}`;
const cfg = testDeps().config;

let h: Harness;
let acme: string;
let globex: string;
let acmeMember: string;

/** Reads as the system role, which sees every firm's rows. */
const query = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];

const add = (cookie: string, hostname = HOST, idempotencyKey: string = crypto.randomUUID()) =>
  h.staff("domains.add", { cookie, body: { hostname, idempotencyKey } });
const list = (cookie = acme) => h.staff("domains.list", { cookie });
const goLive = (hostname = HOST) =>
  h.fakes.cloudflare.set(hostname, { status: "active", sslStatus: "active", errors: [] });
const onHost = async (host: string) =>
  (await resolveTenantByHost(h.db, host, "duely.app"))?.source ?? null;
/** An unauthenticated portal call: 401 means the host resolved to a firm, 404 means it did not. */
const portalStatus = async (host: string) =>
  (await h.portal("invoices.list", { host: `https://${host}` })).status;

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  acmeMember = await h.signUp("member@acme.test");
  await h.testDbAdmin(`
    insert into members (tenant_id, user_id, email, role)
    select f.id, u.id, u.email, 'member' from firms f, "user" u
     where f.platform_slug = 'acme' and u.email = 'member@acme.test'`);
  await h.staff("clients.create", {
    cookie: acme,
    body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
  });
});

beforeEach(async () => {
  await h.testDbAdmin("delete from firm_domains; delete from rate_limit_events");
  h.fakes.cloudflare.hostnames.clear();
  h.fakes.queue.messages.length = 0;
});

afterAll(async () => {
  await h.close();
});

describe("adding a domain", () => {
  it("is for owners only", async () => {
    expect((await add(acmeMember)).status).toBe(403);
    expect((await h.staff("domains.list", { cookie: acmeMember })).status).toBe(403);
  });

  it("registers the hostname with Cloudflare and shows the CNAME to create", async () => {
    const res = await add(acme, "  Billing.AcmeFirm.com ");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      hostname: HOST,
      status: "pending",
      cname: { name: HOST, target: "customers.duely.app" },
    });
    expect(res.data.hint).toMatch(/DNS record/);
    expect([...h.fakes.cloudflare.hostnames.values()].map((x) => x.hostname)).toEqual([HOST]);
    expect((await list()).data).toHaveLength(1);
  });

  it("calls Cloudflare once when the same request is replayed", async () => {
    const key = crypto.randomUUID();
    const first = await add(acme, HOST, key);
    const second = await add(acme, HOST, key);
    expect(second.data.id).toBe(first.data.id);
    expect(h.fakes.cloudflare.hostnames.size).toBe(1);
  });

  it.each([
    ["not a hostname", "domain.invalid_hostname"],
    ["acmefirm.com", "domain.needs_subdomain"],
    ["acme.duely.app", "domain.reserved"],
    ["duely.app", "domain.needs_subdomain"],
  ])("rejects %s", async (hostname, code) => {
    const res = await add(acme, hostname);
    expect([res.status, res.domainCode]).toEqual([400, code]);
    expect(h.fakes.cloudflare.hostnames.size).toBe(0);
  });

  it("allows one domain per firm", async () => {
    await add(acme);
    const res = await add(acme, "pay.acmefirm.com");
    expect([res.status, res.domainCode]).toEqual([409, "domain.already_set"]);
    expect(h.fakes.cloudflare.hostnames.size).toBe(1);
  });

  it("refuses a hostname another firm owns, without saying who", async () => {
    await add(acme);
    const res = await add(globex);
    expect([res.status, res.domainCode]).toEqual([409, "domain.taken"]);
    expect(h.fakes.cloudflare.hostnames.size).toBe(1);
    expect((await list(globex)).data).toEqual([]);
  });

  it("refuses a hostname Cloudflare says is already in use elsewhere, and leaves nothing behind", async () => {
    h.fakes.cloudflare.hostnames.set("x", {
      id: "x",
      hostname: HOST,
      status: "active",
      sslStatus: "active",
      errors: [],
    });
    const res = await add(acme);
    expect([res.status, res.domainCode]).toEqual([409, "domain.taken"]);
    expect((await list()).data).toEqual([]);
  });

  it("removes the row if Cloudflare is down, so the firm can try again", async () => {
    h.fakes.cloudflare.failNext("create");
    const res = await add(acme);
    expect([res.status, res.domainCode]).toEqual([422, "domain.provider_unavailable"]);
    expect((await list()).data).toEqual([]);
    expect((await add(acme)).status).toBe(200);
  });
});

describe("status tracking", () => {
  it("follows Cloudflare to active on a manual check, and records when", async () => {
    const { data } = await add(acme);
    h.fakes.cloudflare.set(HOST, { status: "pending", sslStatus: "pending_validation" });
    h.fakes.cloudflare.set(HOST, {
      status: "verifying",
      errors: ["custom hostname does not CNAME to this zone."],
    });
    const stuck = await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    expect(stuck.data).toMatchObject({ status: "verifying", activatedAt: null });
    expect(stuck.data.errors).toHaveLength(1);
    expect(stuck.data.hint).toMatch(/DNS only/);

    goLive();
    const live = await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    expect(live.data).toMatchObject({ status: "active", hint: null, errors: [] });
    expect(live.data.activatedAt).not.toBeNull();
  });

  it("marks a domain failed when Cloudflare has forgotten it", async () => {
    const { data } = await add(acme);
    h.fakes.cloudflare.hostnames.clear();
    const res = await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    expect(res.data.status).toBe("failed");
    expect(res.data.hint).toMatch(/add it again/);
  });

  it("is not reachable for another firm's domain", async () => {
    const { data } = await add(acme);
    for (const path of ["domains.check", "domains.remove"]) {
      const res = await h.staff(path, { cookie: globex, body: { domainId: data.id } });
      expect([res.status, res.domainCode]).toEqual([404, "domain.not_found"]);
    }
    expect(h.fakes.cloudflare.hostnames.size).toBe(1);
  });

  it("records status changes in the audit log", async () => {
    const { data } = await add(acme);
    goLive();
    await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    const actions = await query<{ action: string }>(
      `select action from audit_log where entity_id = '${data.id}' order by created_at`,
    );
    expect(actions.map((a) => a.action)).toEqual(["domain.added", "domain.status_changed"]);
  });
});

describe("the poller", () => {
  const poll = (olderThanSeconds = 0) =>
    pollDomains(h.systemDb, h.fakes.cloudflare, { olderThanSeconds });

  it("advances domains for every firm and leaves recently checked ones alone", async () => {
    await add(acme);
    await add(globex, "pay.globexinc.com");
    goLive();
    expect(await pollDomains(h.systemDb, h.fakes.cloudflare)).toEqual({ checked: 0, failures: 0 });

    expect(await poll()).toEqual({ checked: 2, failures: 0 });
    const rows = await query<{ hostname: string; status: string }>(
      "select hostname, status from firm_domains order by hostname",
    );
    expect(rows).toEqual([
      { hostname: HOST, status: "active" },
      { hostname: "pay.globexinc.com", status: "pending" },
    ]);
    // Active domains are no longer polled.
    expect((await poll()).checked).toBe(1);
  });

  it("keeps going when one domain's check fails", async () => {
    await add(acme);
    await add(globex, "pay.globexinc.com");
    h.fakes.cloudflare.failNext("get");
    goLive("pay.globexinc.com");
    const result = await poll();
    expect(result).toEqual({ checked: 2, failures: 1 });
    const statuses = await query<{ status: string }>(
      "select status from firm_domains where status = 'active'",
    );
    expect(statuses).toHaveLength(1);
  });

  it("gives up on an add that was interrupted before Cloudflare was called", async () => {
    await h.testDbAdmin(`
      insert into firm_domains (tenant_id, hostname, status, created_at)
      select id, '${HOST}', 'pending', now() - interval '10 minutes' from firms where platform_slug = 'acme'`);
    await poll();
    const [row] = await query<{ status: string }>("select status from firm_domains");
    expect(row!.status).toBe("failed");
  });

  it("does not give up on a fresh add that is still in flight", async () => {
    await h.testDbAdmin(`
      insert into firm_domains (tenant_id, hostname, status)
      select id, '${HOST}', 'pending' from firms where platform_slug = 'acme'`);
    await poll();
    const [row] = await query<{ status: string }>("select status from firm_domains");
    expect(row!.status).toBe("pending");
  });
});

describe("host resolution and links", () => {
  it("serves the portal on the custom host only once it is active", async () => {
    const { data } = await add(acme);
    expect(await onHost(HOST)).toBeNull();
    expect(await portalStatus(HOST)).toBe(404);
    expect(await portalStatus("acme.duely.app")).toBe(401);

    h.fakes.cloudflare.set(HOST, { status: "verifying", sslStatus: "pending_issuance" });
    await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    expect(await portalStatus(HOST)).toBe(404); // verifying is not enough

    goLive();
    await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    expect(await onHost(HOST)).toBe("custom");
    expect(await portalStatus(HOST)).toBe(401);
    expect(await portalStatus("acme.duely.app")).toBe(401); // platform subdomain keeps working
  });

  it("never serves staff routes on a custom host", async () => {
    const { data } = await add(acme);
    goLive();
    await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    const res = await h.staff("firm.get", { cookie: acme, host: CUSTOM });
    expect(res.status).toBe(404);
  });

  it("sends sign-in links to the platform subdomain until the custom domain is active, then to it", async () => {
    const linkHost = async (requestedOn: string) => {
      await h.portal("auth.requestLink", {
        host: requestedOn,
        body: { email: "bill@initech.test" },
        ip: "203.0.113.9",
      });
      for (const m of h.fakes.queue.messages.splice(0)) {
        if (m.type === "send_message")
          await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
      }
      return /https:\/\/([\w.-]+)\/api\/portal\/auth\//.exec(h.fakes.email.sent.at(-1)!.text)![1];
    };

    const { data } = await add(acme);
    expect(await linkHost(ACME)).toBe("acme.duely.app");

    goLive();
    await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    await h.testDbAdmin("delete from rate_limit_events");
    expect(await linkHost(ACME)).toBe(HOST);
    await h.testDbAdmin("delete from rate_limit_events");
    expect(await linkHost(CUSTOM)).toBe(HOST);
  });
});

describe("removing a domain", () => {
  it("releases the hostname at Cloudflare and stops serving it, but not the subdomain", async () => {
    const { data } = await add(acme);
    goLive();
    await h.staff("domains.check", { cookie: acme, body: { domainId: data.id } });
    expect(await portalStatus(HOST)).toBe(401);

    const res = await h.staff("domains.remove", { cookie: acme, body: { domainId: data.id } });
    expect(res.status).toBe(200);
    expect(h.fakes.cloudflare.hostnames.size).toBe(0);
    expect(await portalStatus(HOST)).toBe(404);
    expect(await portalStatus("acme.duely.app")).toBe(401);
    expect((await list()).data).toEqual([]);
  });

  it("lets the same hostname be used by another firm afterwards", async () => {
    const { data } = await add(acme);
    await h.staff("domains.remove", { cookie: acme, body: { domainId: data.id } });
    expect((await add(globex)).status).toBe(200);
  });

  it("replaces a domain by removing then adding", async () => {
    const { data } = await add(acme);
    await h.staff("domains.remove", { cookie: acme, body: { domainId: data.id } });
    const next = await add(acme, "pay.acmefirm.com");
    expect(next.data.hostname).toBe("pay.acmefirm.com");
    expect(h.fakes.cloudflare.hostnames.size).toBe(1);
  });

  it("keeps the domain if Cloudflare cannot release it, so the firm can retry", async () => {
    const { data } = await add(acme);
    h.fakes.cloudflare.failNext("delete");
    const res = await h.staff("domains.remove", { cookie: acme, body: { domainId: data.id } });
    expect([res.status, res.domainCode]).toEqual([422, "domain.provider_unavailable"]);
    expect((await list()).data).toHaveLength(1);
    expect(
      (await h.staff("domains.remove", { cookie: acme, body: { domainId: data.id } })).status,
    ).toBe(200);
  });
});
