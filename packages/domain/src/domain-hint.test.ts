import { describe, expect, it } from "vite-plus/test";

import { domainHint } from "./domain-hint";

describe("domainHint", () => {
  it("has nothing to say once live", () => {
    expect(domainHint({ status: "active", errors: [], ageMinutes: 0 })).toBeNull();
  });

  it("points at the record when Cloudflare cannot find the CNAME", () => {
    const hint = domainHint({
      status: "pending",
      errors: ["custom hostname does not CNAME to this zone."],
      ageMinutes: 1,
    });
    expect(hint).toMatch(/DNS only/);
  });

  it("explains a CAA block", () => {
    expect(
      domainHint({ status: "pending", errors: ["CAA record prevents issuance"], ageMinutes: 30 }),
    ).toMatch(/CAA/);
  });

  it("is reassuring while the certificate is issued", () => {
    expect(domainHint({ status: "verifying", errors: [], ageMinutes: 3 })).toMatch(/certificate/);
  });

  it("escalates the wording when pending for a while", () => {
    const young = domainHint({ status: "pending", errors: [], ageMinutes: 2 });
    const old = domainHint({ status: "pending", errors: [], ageMinutes: 20 });
    expect(young).not.toBe(old);
    expect(old).toMatch(/proxies/);
  });

  it("tells a failed domain's owner to start over", () => {
    expect(domainHint({ status: "failed", errors: [], ageMinutes: 5000 })).toMatch(/add it again/);
  });
});
