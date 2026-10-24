import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { MAX_LOGO_BYTES } from "../hono/files";
import { APP, createHarness, type Harness } from "../testing";

let h: Harness;
let owner: string;
let member: string;
let other: string;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeAll(async () => {
  h = await createHarness();
  owner = await h.ownerOf("acme");
  other = await h.ownerOf("globex");
  // A second user joins acme as a plain member through an invite.
  const invite = await h.staff("members.invite", {
    cookie: owner,
    body: { email: "mate@example.com" },
  });
  member = await h.signUp("mate@example.com");
  await h.staff("members.acceptInvite", { cookie: member, body: { token: invite.data.token } });
}, 60_000);
afterAll(() => h?.close());

const upload = (
  cookie: string | undefined,
  body: BodyInit,
  type: string,
  extra: Record<string, string> = {},
) =>
  h.app.request(`${APP}/api/files/logo`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": type, ...extra },
    body,
  });

describe("firm settings", () => {
  it("owner updates branding; the change is audited and visible", async () => {
    const res = await h.staff("firm.update", {
      cookie: owner,
      body: {
        displayName: "Acme Studio",
        brandPrimary: "#00AA55",
        defaultTermsDays: 30,
        invoicePrefix: "AC-",
        timezone: "Europe/Berlin",
        replyToEmail: "ar@acme.test",
      },
    });
    expect(res.status).toBe(200);
    const got = await h.staff("firm.get", { cookie: owner });
    expect(got.data.firm).toMatchObject({
      displayName: "Acme Studio",
      brandPrimary: "#00AA55",
      defaultTermsDays: 30,
      invoicePrefix: "AC-",
      timezone: "Europe/Berlin",
      replyToEmail: "ar@acme.test",
    });
  });

  it("members cannot change settings (403) but can read them", async () => {
    const res = await h.staff("firm.update", { cookie: member, body: { displayName: "Hacked" } });
    expect([res.status, res.domainCode]).toEqual([403, "member.owner_required"]);
    expect((await h.staff("firm.get", { cookie: member })).data.role).toBe("member");
  });

  it("validates colors, timezone and prefix", async () => {
    expect(
      (await h.staff("firm.update", { cookie: owner, body: { brandPrimary: "red" } })).status,
    ).toBe(400);
    expect(
      (await h.staff("firm.update", { cookie: owner, body: { invoicePrefix: "A B" } })).status,
    ).toBe(400);
    const tz = await h.staff("firm.update", { cookie: owner, body: { timezone: "Mars/Olympus" } });
    expect([tz.status, tz.domainCode]).toEqual([400, "firm.invalid_timezone"]);
  });

  it("never changes the slug or another firm", async () => {
    await h.staff("firm.update", { cookie: owner, body: { platformSlug: "stolen", id: "x" } });
    expect((await h.staff("firm.get", { cookie: owner })).data.firm.platformSlug).toBe("acme");
    expect((await h.staff("firm.get", { cookie: other })).data.firm.displayName).toBe("globex");
  });
});

describe("logo upload", () => {
  it("stores a valid PNG under a random tenant-scoped key and serves it on the portal host", async () => {
    const res = await upload(owner, PNG, "image/png");
    expect(res.status).toBe(200);
    const keys = [...h.fakes.files.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^firms\/[0-9a-f-]{36}\/logo\/[0-9a-f-]{36}\.png$/);

    const served = await h.app.request("https://acme.duely.app/api/logo");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect((await h.staff("firm.get", { cookie: owner })).data.firm.hasLogo).toBe(true);
  });

  it("serves each tenant's own logo only, and nothing off the portal host or without one", async () => {
    expect((await h.app.request("https://globex.duely.app/api/logo")).status).toBe(404); // globex has none
    expect((await h.app.request(`${APP}/api/logo`)).status).toBe(404);
    expect((await h.app.request("https://nobody.duely.app/api/logo")).status).toBe(404);
  });

  it("rejects: no session, a member, wrong type, lying type, too large", async () => {
    expect((await upload(undefined, PNG, "image/png")).status).toBe(401);
    expect((await upload(member, PNG, "image/png")).status).toBe(403);
    expect((await upload(owner, "<svg onload=alert(1)/>", "image/svg+xml")).status).toBe(415);
    expect((await upload(owner, "GIF89a....", "image/png")).status).toBe(415); // not actually a PNG
    expect((await upload(owner, new Uint8Array(MAX_LOGO_BYTES + 1), "image/png")).status).toBe(413);
    expect(
      (await upload(owner, PNG, "image/png", { "content-length": String(MAX_LOGO_BYTES + 5) }))
        .status,
    ).toBe(413);
  });

  it("is only accepted on the app host", async () => {
    const res = await h.app.request("https://acme.duely.app/api/files/logo", {
      method: "POST",
      headers: { cookie: owner, "content-type": "image/png" },
      body: PNG,
    });
    expect(res.status).toBe(404);
  });
});
