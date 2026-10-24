import { createDb, type Db } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createApp } from "../hono/app";

const APP = "https://app.duely.app";
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

async function signUp(email: string) {
  const res = await app.request(`${APP}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({
      email,
      name: email.split("@")[0],
      password: "correct horse battery staple",
    }),
  });
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function call(path: string, cookie?: string, body?: unknown) {
  const res = await app.request(`${APP}/api/trpc/staff/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: APP,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as {
    result?: { data: any };
    error?: { data: { domainCode: string | null } };
  };
  return { status: res.status, data: json.result?.data, domainCode: json.error?.data.domainCode };
}

const q = (path: string, input: unknown, cookie?: string) =>
  call(`${path}?input=${encodeURIComponent(JSON.stringify(input))}`, cookie);

describe("member invites", () => {
  let owner: string;
  let token: string;

  beforeAll(async () => {
    owner = await signUp("owner@example.com");
    await call("firm.create", owner, {
      legalName: "Acme LLC",
      displayName: "Acme",
      platformSlug: "acme",
    });
  });

  it("only owners can invite", async () => {
    const stranger = await signUp("nobody@example.com");
    expect((await call("members.invite", stranger, { email: "x@example.com" })).status).toBe(403);
    const sent = await call("members.invite", owner, { email: "Teammate@Example.com" });
    expect(sent.status).toBe(200);
    token = sent.data.token;
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it("stores only a hash of the token", async () => {
    const list = await call("members.list", owner);
    expect(list.data.invites).toHaveLength(1);
    expect(JSON.stringify(list.data)).not.toContain(token);
  });

  it("previews without a session, and not for a bad token", async () => {
    expect((await q("members.previewInvite", { token }))?.data).toEqual({
      firmName: "Acme",
      email: "teammate@example.com",
    });
    const bad = await q("members.previewInvite", { token: "x".repeat(43) });
    expect([bad.status, bad.domainCode]).toEqual([404, "invite.invalid"]);
  });

  it("refuses a different account (403) and leaves the invite usable", async () => {
    const other = await signUp("other@example.com");
    const res = await call("members.acceptInvite", other, { token });
    expect([res.status, res.domainCode]).toEqual([403, "invite.wrong_account"]);
  });

  it("the invited address joins once, as a member, and the link is then dead", async () => {
    const mate = await signUp("teammate@example.com");
    expect((await call("members.acceptInvite", mate, { token })).status).toBe(200);
    expect((await call("firm.get", mate)).data).toMatchObject({
      role: "member",
      firm: { platformSlug: "acme" },
    });
    const again = await call("members.acceptInvite", await signUp("teammate2@example.com"), {
      token,
    });
    expect(again.status).toBe(404);
    expect((await call("members.list", owner)).data.members).toHaveLength(2);
  });

  it("members cannot see invites or invite others; revoke works for owners", async () => {
    const mate = await signUp("late@example.com");
    void mate;
    const sent = await call("members.invite", owner, { email: "revoked@example.com" });
    const id = (await call("members.list", owner)).data.invites[0].id;
    expect((await call("members.revokeInvite", owner, { inviteId: id })).status).toBe(200);
    expect(sent.status).toBe(200);
    expect((await call("members.list", owner)).data.invites).toHaveLength(0);
  });

  it("inviting an existing member conflicts (409)", async () => {
    const res = await call("members.invite", owner, { email: "teammate@example.com" });
    expect([res.status, res.domainCode]).toEqual([409, "member.already_member"]);
  });
});
