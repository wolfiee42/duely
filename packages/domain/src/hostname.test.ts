import { describe, expect, it } from "vite-plus/test";

import { DomainError } from "./errors";
import { parseCustomHostname } from "./hostname";

const parse = (s: string) => parseCustomHostname(s, "duely.app");
const codeOf = (s: string) => {
  try {
    parse(s);
  } catch (e) {
    return e instanceof DomainError ? e.code : "other";
  }
  return null;
};

describe("parseCustomHostname", () => {
  it("normalises case, scheme, slash, trailing dot and whitespace", () => {
    expect(parse("  Billing.Acme.COM ")).toBe("billing.acme.com");
    expect(parse("https://billing.acme.com/")).toBe("billing.acme.com");
    expect(parse("billing.acme.com.")).toBe("billing.acme.com");
    expect(parse("pay.acme.co.uk")).toBe("pay.acme.co.uk");
    expect(parse("a-b.acme.io")).toBe("a-b.acme.io");
  });

  it.each([
    "",
    "billing",
    "billing acme.com",
    "billing.acme.com:8080",
    "billing.acme.com/path",
    "user@billing.acme.com",
    "*.acme.com",
    "bill_ing.acme.com",
    "-billing.acme.com",
    "billing-.acme.com",
    "billing..acme.com",
    "billing.acme.123",
    "127.0.0.1",
    `${"a".repeat(64)}.acme.com`,
  ])("rejects %j", (input) => {
    expect(codeOf(input)).toMatch(/^domain\./);
  });

  it("asks for a subdomain when given an apex", () => {
    expect(codeOf("acme.com")).toBe("domain.needs_subdomain");
  });

  it("reserves the platform domain and everything under it", () => {
    expect(codeOf("duely.app")).toBe("domain.needs_subdomain");
    expect(codeOf("acme.duely.app")).toBe("domain.reserved");
    expect(codeOf("a.b.duely.app")).toBe("domain.reserved");
    expect(codeOf("billing.notduely.app")).toBeNull();
  });
});
