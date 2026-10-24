import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";

let h: Harness;
let owner: string;
let member: string;

beforeAll(async () => {
  h = await createHarness();
  owner = await h.ownerOf("acme");
  const invite = await h.staff("members.invite", {
    cookie: owner,
    body: { email: "mate@example.com" },
  });
  member = await h.signUp("mate@example.com");
  await h.staff("members.acceptInvite", { cookie: member, body: { token: invite.data.token } });
}, 60_000);
afterAll(() => h?.close());

describe("Stripe Connect onboarding", () => {
  it("is owner-only for the link, but any member can read status", async () => {
    expect((await h.staff("stripe.connectLink", { cookie: member, body: {} })).status).toBe(403);
    expect((await h.staff("stripe.status", { cookie: member })).data).toEqual({ connected: false });
  });

  it("creates one account, reuses it on every later link, and points back at settings", async () => {
    const first = await h.staff("stripe.connectLink", { cookie: owner, body: {} });
    expect(first.status).toBe(200);
    expect(first.data.url).toMatch(/^https:\/\/connect\.stripe\.test\/onboard\/acct_fake_\d+$/);
    const second = await h.staff("stripe.connectLink", { cookie: owner, body: {} });
    expect(second.data.url).toBe(first.data.url);
    expect(h.fakes.stripe.accounts.size).toBe(1);
  });

  it("two simultaneous clicks end with one account on the firm", async () => {
    const racer = await h.ownerOf("racer");
    const [a, b] = await Promise.all([
      h.staff("stripe.connectLink", { cookie: racer, body: {} }),
      h.staff("stripe.connectLink", { cookie: racer, body: {} }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const accountId = (await h.staff("firm.get", { cookie: racer })).data.firm.stripeAccountId;
    expect(accountId).toMatch(/^acct_fake_/);
    expect((await h.staff("firm.get", { cookie: racer })).data.firm.stripeChargesEnabled).toBe(
      false,
    );
  });

  it("status syncs the capability flags from Stripe onto the firm", async () => {
    const accountId = (await h.staff("firm.get", { cookie: owner })).data.firm
      .stripeAccountId as string;
    expect((await h.staff("stripe.status", { cookie: owner })).data).toMatchObject({
      connected: true,
      chargesEnabled: false,
    });
    h.fakes.stripe.completeOnboarding(accountId);
    expect((await h.staff("stripe.status", { cookie: owner })).data).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
    expect((await h.staff("firm.get", { cookie: owner })).data.firm).toMatchObject({
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: true,
    });
  });
});
