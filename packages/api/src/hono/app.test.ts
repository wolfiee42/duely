import { createDb, withTenant, type Db } from "@repo/db";
import { firmDomains, firms } from "@repo/db/schema";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { testDeps } from "../testing";
import { createApp } from "./app";
import { hostScope, requestId, requireHostKind, type AppEnv } from "./middleware";

// host-kind suite (SPEC 8): wrong-kind and unknown hosts get a bare 404, never a hint.

const ACME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let testDb: TestDatabase;
let close: () => Promise<unknown>;
let db: Db;

const withDb = <T>(fn: (db: Db) => Promise<T>) => fn(db);

beforeAll(async () => {
  testDb = await createTestDatabase();
  ({ db, close } = createDb(testDb.appUrl, { max: 4 }));
  await withTenant(db, ACME, async (tx) => {
    await tx
      .insert(firms)
      .values({ id: ACME, platformSlug: "acme", legalName: "Acme", displayName: "Acme" });
    await tx.insert(firmDomains).values([
      { tenantId: ACME, hostname: "billing.acme.test", status: "active" },
      { tenantId: ACME, hostname: "soon.acme.test", status: "pending" },
    ]);
  });
}, 60_000);

afterAll(async () => {
  await close?.();
  await testDb?.drop();
});

/** App with one probe route per host kind, behind the same middleware chain as the real app. */
function probeApp() {
  const app = new Hono<AppEnv>().use(requestId).use(hostScope("duely.app", withDb));
  app.get("/staff", requireHostKind("app"), (c) => c.text("staff"));
  app.get("/portal", requireHostKind("portal"), (c) => c.json({ tenant: c.var.host.tenantId }));
  app.get("/marketing", requireHostKind("marketing"), (c) => c.text("marketing"));
  return app;
}

const get = (app: Hono<AppEnv>, host: string, path: string) =>
  app.request(`https://${host}${path}`);

describe("host-kind guard", () => {
  const app = probeApp();

  it("serves each route only on its own host kind", async () => {
    expect((await get(app, "app.duely.app", "/staff")).status).toBe(200);
    expect((await get(app, "acme.duely.app", "/portal")).status).toBe(200);
    expect((await get(app, "duely.app", "/marketing")).status).toBe(200);
  });

  it("returns 404 for the wrong kind, on every route", async () => {
    for (const [host, path] of [
      ["acme.duely.app", "/staff"],
      ["duely.app", "/staff"],
      ["app.duely.app", "/portal"],
      ["duely.app", "/portal"],
      ["app.duely.app", "/marketing"],
      ["acme.duely.app", "/marketing"],
    ] as const) {
      const res = await get(app, host, path);
      expect([host, path, res.status]).toEqual([host, path, 404]);
    }
  });

  it("returns an identical bare 404 for unknown hosts and wrong kinds", async () => {
    const unknown = [
      "nobody.duely.app", // valid slug, no such firm
      "admin.duely.app", // reserved
      "evil.example", // not a custom domain
      "soon.acme.test", // custom domain not active yet
    ];
    const wrongKind = await get(app, "acme.duely.app", "/staff");
    for (const host of unknown) {
      const res = await get(app, host, "/portal");
      expect([host, res.status]).toEqual([host, 404]);
      expect(await res.text()).toBe(await wrongKind.clone().text());
    }
  });

  it("resolves the tenant for platform subdomains and active custom domains", async () => {
    expect(await (await get(app, "acme.duely.app", "/portal")).json()).toEqual({ tenant: ACME });
    expect(await (await get(app, "billing.acme.test", "/portal")).json()).toEqual({ tenant: ACME });
  });
});

describe("api app", () => {
  const app = createApp({ withDb, withSystemDb: withDb, ...testDeps() });

  it("answers /api/health on any known host and checks the database", async () => {
    for (const host of ["duely.app", "app.duely.app", "acme.duely.app"]) {
      const res = await get(app as unknown as Hono<AppEnv>, host, "/api/health");
      expect([host, res.status, await res.json()]).toEqual([host, 200, { ok: true }]);
    }
  });

  it("404s unknown hosts before any route runs", async () => {
    expect((await get(app as unknown as Hono<AppEnv>, "evil.example", "/api/health")).status).toBe(
      404,
    );
  });

  it("tags every response with a request id", async () => {
    const res = await get(app as unknown as Hono<AppEnv>, "app.duely.app", "/api/health");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
