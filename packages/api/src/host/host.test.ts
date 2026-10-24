import { describe, expect, it } from "vite-plus/test";

import { isValidPlatformSlug, resolveHostKind } from "./host";

const prod = (host: string | null) => resolveHostKind(host, "duely.app");

describe("resolveHostKind", () => {
  it.each([
    ["duely.app", { kind: "marketing" }],
    ["www.duely.app", { kind: "marketing" }],
    ["app.duely.app", { kind: "app" }],
    ["APP.Duely.App", { kind: "app" }],
    ["app.duely.app:443", { kind: "app" }],
    ["app.duely.app.", { kind: "app" }],
    ["acme.duely.app", { kind: "portal", via: "platform" }],
    ["acme-co.duely.app", { kind: "portal", via: "platform" }],
    ["abc.duely.app", { kind: "portal", via: "platform" }],
    ["billing.acme.com", { kind: "portal", via: "custom" }],
    ["duely.app.evil.com", { kind: "portal", via: "custom" }],
  ])("%s", (host, expected) => {
    expect(prod(host)).toEqual(expected);
  });

  it.each([
    [null],
    [""],
    ["admin.duely.app"], // reserved
    ["inbound.duely.app"],
    ["ab.duely.app"], // too short
    [`${"a".repeat(31)}.duely.app`], // too long
    ["-acme.duely.app"],
    ["acme-.duely.app"],
    ["a.b.duely.app"], // nested subdomain
    ["acme..duely.app"],
    ["acme_co.duely.app"],
    ["acme.duely.app/evil"],
    ["[::1]"],
  ])("rejects %s", (host) => {
    expect(prod(host)).toBeNull();
  });

  it("uses the same rules for *.localhost in development", () => {
    const dev = (h: string) => resolveHostKind(h, "localhost");
    expect(dev("localhost:3000")).toEqual({ kind: "marketing" });
    expect(dev("app.localhost:3000")).toEqual({ kind: "app" });
    expect(dev("acme.localhost:3000")).toEqual({ kind: "portal", via: "platform" });
    expect(dev("admin.localhost:3000")).toBeNull();
  });
});

describe("isValidPlatformSlug", () => {
  it("enforces length, charset and the reserved list", () => {
    expect(isValidPlatformSlug("acme")).toBe(true);
    expect(isValidPlatformSlug("a1-b2")).toBe(true);
    for (const bad of [
      "ab",
      "Acme",
      "ac me",
      "app",
      "www",
      "api",
      "inbound",
      "mail",
      "admin",
      "status",
      "docs",
      "assets",
      "-ab",
      "ab-",
    ]) {
      expect(isValidPlatformSlug(bad)).toBe(false);
    }
  });
});
