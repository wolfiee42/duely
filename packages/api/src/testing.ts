import { createFakeCloudflare, type FakeCloudflare } from "@repo/cloudflare/fake";
import { createDb, type Db } from "@repo/db";
import { adminExec, createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createFakeEmail, type FakeEmail } from "@repo/email/fake";
import { createFakeStripe, type FakeStripe } from "@repo/stripe/fake";
import { expect } from "vite-plus/test";

import { createApp, type AppDeps } from "./hono/app";
import { createMemoryFiles, createMemoryQueue } from "./services";

// Shared by the API integration suites: a migrated database plus the real Hono app, driven with
// real Better Auth sessions. Tests only; not exported from the package index.

export const APP = "https://app.duely.app";
export const PASSWORD = "correct horse battery staple";

export interface Fakes {
  cloudflare: FakeCloudflare;
  stripe: FakeStripe;
  email: FakeEmail;
  files: ReturnType<typeof createMemoryFiles>;
  queue: ReturnType<typeof createMemoryQueue>;
}

export const WEBHOOK_SECRET = "whsec_test_secret";

/** Everything `createApp` needs besides the database, with in-memory services. */
export function testDeps(): Pick<AppDeps, "auth" | "services" | "config"> & { fakes: Fakes } {
  const fakes: Fakes = {
    cloudflare: createFakeCloudflare(),
    stripe: createFakeStripe(),
    email: createFakeEmail(),
    files: createMemoryFiles(),
    queue: createMemoryQueue(),
  };
  return {
    fakes,
    services: fakes,
    auth: { baseURL: APP, secret: "test-secret-0123456789abcdef0123456789" },
    config: {
      platformDomain: "duely.app",
      appOrigin: APP,
      stripeWebhookSecret: WEBHOOK_SECRET,
      stripePublishableKey: "pk_test_fake",
      cnameTarget: "customers.duely.app",
      emailFromAddress: "billing@duely.app",
      portalSessionSecret: "portal-secret-0123456789abcdef0123456789",
    },
  };
}

export interface Harness {
  fakes: Fakes;
  db: Db;
  /** The `duely_system` connection the jobs worker uses. */
  systemDb: Db;
  /** Runs SQL as a superuser, for setup that must bypass roles and RLS. */
  testDbAdmin(sql: string): Promise<void>;
  testDb: TestDatabase;
  app: ReturnType<typeof createApp>;
  /** Signs up and returns the session cookie header. */
  signUp(email: string): Promise<string>;
  /** Signs up, creates a firm and returns the owner's cookie. */
  ownerOf(slug: string): Promise<string>;
  staff(path: string, opts?: CallOptions): Promise<CallResult>;
  /** Calls the portal router on a tenant host such as `https://acme.duely.app`. */
  portal(path: string, opts: CallOptions & { host: string; ip?: string }): Promise<CallResult>;
  close(): Promise<void>;
}

export interface CallOptions {
  cookie?: string;
  host?: string;
  body?: unknown;
  /** Query-string input for GET procedures. */
  input?: unknown;
}

export interface CallResult {
  status: number;
  data: any;
  domainCode: string | null | undefined;
}

export async function createHarness(extra: Partial<AppDeps> = {}): Promise<Harness> {
  const testDb = await createTestDatabase();
  const { db, close } = createDb(testDb.appUrl, { max: 8 });
  const system = createDb(testDb.systemUrl, { max: 4 });
  const { fakes, ...deps } = testDeps();
  const app = createApp({
    withDb: (fn) => fn(db),
    withSystemDb: (fn) => fn(system.db),
    ...deps,
    ...extra,
  });

  const request = (url: string, init: RequestInit) => app.request(url, init);

  async function signUp(email: string) {
    const res = await request(`${APP}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify({ email, name: email.split("@")[0], password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  async function staff(path: string, { cookie, host = APP, body, input }: CallOptions = {}) {
    const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await request(`${host}/api/trpc/staff/${path}${query}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: host,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      result?: { data: unknown };
      error?: { data: { domainCode: string | null } };
    } | null;
    return {
      status: res.status,
      data: json?.result?.data,
      domainCode: json?.error?.data.domainCode,
    } as CallResult;
  }

  async function portal(
    path: string,
    { cookie, host, body, input, ip }: CallOptions & { host: string; ip?: string },
  ) {
    const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await request(`${host}/api/trpc/portal/${path}${query}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: host,
        ...(ip ? { "cf-connecting-ip": ip } : {}),
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      result?: { data: unknown };
      error?: { data: { domainCode: string | null } };
    } | null;
    return {
      status: res.status,
      data: json?.result?.data,
      domainCode: json?.error?.data.domainCode,
    } as CallResult;
  }

  return {
    portal,
    fakes,
    db,
    systemDb: system.db,
    testDb,
    testDbAdmin: (statement) => adminExec(testDb, statement),
    app,
    signUp,
    async ownerOf(slug) {
      const cookie = await signUp(`owner-${slug}@example.com`);
      const res = await staff("firm.create", {
        cookie,
        body: { legalName: `${slug} LLC`, displayName: slug, platformSlug: slug },
      });
      expect(res.status).toBe(200);
      return cookie;
    },
    staff,
    async close() {
      await close();
      await system.close();
      await testDb.drop();
    },
  };
}

/** Shared by portal suites: the fake outbox, drained as the jobs worker would. */
export { deliverMessage } from "./usecases/outbox";
