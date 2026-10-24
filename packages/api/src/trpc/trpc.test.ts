import { createDb, withTenant, type Db } from "@repo/db";
import { auditLog, firms, members } from "@repo/db/schema";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createApp } from "../hono/app";

// trpc-authz + tenant-isolation at the API boundary (SPEC 8): real Better Auth sign-up, real
// session cookies, real RLS. Requests go through the same Hono app the Worker serves.

const APP = "https://app.duely.app";
const ACME_HOST = "https://acme.duely.app";
const ORIGIN = { origin: APP };

let testDb: TestDatabase;
let db: Db;
let close: () => Promise<unknown>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  testDb = await createTestDatabase();
  ({ db, close } = createDb(testDb.appUrl, { max: 6 }));
  app = createApp({
    platformDomain: "duely.app",
    withDb: (fn) => fn(db),
    auth: { baseURL: APP, secret: "test-secret-0123456789abcdef0123456789" },
  });
}, 60_000);

afterAll(async () => {
  await close?.();
  await testDb?.drop();
});

/** Signs up through Better Auth and returns the session cookie header. */
async function signUp(email: string, name = email.split("@")[0]!) {
  const res = await app.request(`${APP}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN },
    body: JSON.stringify({ email, name, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function call(path: string, opts: { cookie?: string; host?: string; body?: unknown } = {}) {
  const { cookie, host = APP, body } = opts;
  const headers: Record<string, string> = { ...ORIGIN, ...(cookie ? { cookie } : {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`${host}/api/trpc/staff/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as {
    result?: { data: unknown };
    error?: { message: string; data: { code: string; domainCode: string | null } };
  } | null;
  return { status: res.status, data: json?.result?.data, error: json?.error };
}

const create = (cookie: string, platformSlug: string) =>
  call("firm.create", {
    cookie,
    body: { legalName: `${platformSlug} LLC`, displayName: platformSlug, platformSlug },
  });

describe("authentication and host kind", () => {
  it("rejects a request with no session (401)", async () => {
    const res = await call("firm.get");
    expect(res.status).toBe(401);
    expect(res.error?.data.domainCode).toBe("auth.unauthenticated");
  });

  it("returns 404 on a portal host even with a valid staff session", async () => {
    const cookie = await signUp("host-check@example.com");
    expect((await call("firm.get", { cookie, host: ACME_HOST })).status).toBe(404);
    expect((await call("firm.get", { cookie, host: "https://evil.example" })).status).toBe(404);
  });

  it("does not serve staff auth on a tenant host", async () => {
    const res = await app.request(`${ACME_HOST}/api/auth/get-session`);
    expect(res.status).toBe(404);
  });

  it("sets a host-only session cookie, with no Domain attribute (FR-1.7)", async () => {
    const res = await app.request(`${APP}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ORIGIN },
      body: JSON.stringify({
        email: "cookie@example.com",
        name: "Cookie",
        password: "correct horse battery staple",
      }),
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).not.toMatch(/;\s*domain=/i);
      expect(c).toMatch(/httponly/i);
      expect(c).toMatch(/secure/i);
    }
  });
});

describe("firm.create and firm.get", () => {
  it("a new user with no firm is told to create one (403), then can", async () => {
    const cookie = await signUp("owner-a@example.com");
    const before = await call("firm.get", { cookie });
    expect(before.status).toBe(403);
    expect(before.error?.data.domainCode).toBe("member.no_firm");

    const created = await create(cookie, "acme");
    expect(created.status).toBe(200);

    const after = await call("firm.get", { cookie });
    expect(after.status).toBe(200);
    expect(after.data).toMatchObject({
      firm: { platformSlug: "acme", displayName: "acme" },
      role: "owner",
    });
  });

  it("writes the firm, owner member and an audit entry together", async () => {
    const rows = await withTenantByAdminSlug("acme");
    expect(rows.members).toEqual([
      expect.objectContaining({ role: "owner", email: "owner-a@example.com" }),
    ]);
    expect(rows.audit).toEqual([
      expect.objectContaining({ action: "firm.created", actorType: "member" }),
    ]);
  });

  it("rejects a taken slug (409), a reserved slug and a bad slug (422/400)", async () => {
    const cookie = await signUp("owner-b@example.com");
    const taken = await create(cookie, "acme");
    expect(taken.status).toBe(409);
    expect(taken.error?.data.domainCode).toBe("firm.slug_taken");

    const reserved = await create(cookie, "admin");
    expect(reserved.status).toBe(400);
    expect(reserved.error?.data.domainCode).toBe("firm.invalid_slug");
  });

  it("a user cannot create a second firm (409)", async () => {
    const cookie = await signUp("owner-c@example.com");
    expect((await create(cookie, "globex")).status).toBe(200);
    const again = await create(cookie, "globex-2");
    expect(again.status).toBe(409);
    expect(again.error?.data.domainCode).toBe("firm.already_member");
  });

  it("validates input (400)", async () => {
    const cookie = await signUp("owner-d@example.com");
    const res = await call("firm.create", {
      cookie,
      body: { legalName: "x", displayName: "", platformSlug: "!" },
    });
    expect(res.status).toBe(400);
  });

  it("reports slug availability to a signed-in user", async () => {
    const cookie = await signUp("owner-e@example.com");
    const q = (slug: string) =>
      call(`firm.slugAvailable?input=${encodeURIComponent(JSON.stringify({ slug }))}`, { cookie });
    expect((await q("acme")).data).toBe(false);
    expect((await q("admin")).data).toBe(false);
    expect((await q("free-slug")).data).toBe(true);
  });
});

describe("cross-tenant isolation through the API", () => {
  it("each owner sees only their own firm", async () => {
    const globex = await call("firm.get", { cookie: await signIn("owner-c@example.com") });
    const acme = await call("firm.get", { cookie: await signIn("owner-a@example.com") });
    expect((globex.data as { firm: { platformSlug: string } }).firm.platformSlug).toBe("globex");
    expect((acme.data as { firm: { platformSlug: string } }).firm.platformSlug).toBe("acme");
  });

  it("firm.get takes no tenant input: a crafted tenantId is ignored", async () => {
    const cookie = await signIn("owner-a@example.com");
    const globexId = (await tenantIdBySlug("globex"))!;
    const res = await call(
      `firm.get?input=${encodeURIComponent(JSON.stringify({ tenantId: globexId }))}`,
      { cookie },
    );
    expect((res.data as { firm: { platformSlug: string } }).firm.platformSlug).toBe("acme");
  });
});

// --- helpers that look behind the API, using the system view of the database ---

async function signIn(email: string) {
  const res = await app.request(`${APP}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN },
    body: JSON.stringify({ email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function tenantIdBySlug(slug: string) {
  const { resolveTenantByHost } = await import("@repo/db");
  return (await resolveTenantByHost(db, `${slug}.duely.app`, "duely.app"))?.tenantId ?? null;
}

async function withTenantByAdminSlug(slug: string) {
  const tenantId = (await tenantIdBySlug(slug))!;
  return withTenant(db, tenantId, async (tx) => ({
    firm: await tx.select().from(firms).where(eq(firms.id, tenantId)),
    members: await tx.select().from(members),
    audit: await tx.select().from(auditLog),
  }));
}
