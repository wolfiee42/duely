import { describe, expect, it } from "vite-plus/test";

import { parseAddress, replyTokenFrom, stripQuoted } from "./inbound";

describe("parseAddress", () => {
  it("takes the address out of a display name and lowercases it", () => {
    expect(parseAddress('"Bill L." <Bill@Initech.test>')).toBe("bill@initech.test");
    expect(parseAddress("  bill@initech.test ")).toBe("bill@initech.test");
  });
});

describe("replyTokenFrom", () => {
  it("finds the token among several recipients", () => {
    expect(
      replyTokenFrom(["Support <help@x.test>", "Duely <reply+abc123XYZ_-9@inbound.duely.app>"]),
    ).toBe("abc123XYZ_-9");
  });

  it("ignores lookalikes", () => {
    expect(replyTokenFrom(["reply+short@inbound.duely.app"])).toBeNull();
    expect(replyTokenFrom(["reply+abcdefghij@evil.example.com"])).toBeNull();
    expect(replyTokenFrom(["billing@duely.app"])).toBeNull();
  });
});

describe("stripQuoted", () => {
  it("drops a Gmail-style quoted history", () => {
    const body = `I'll pay on Friday.

On Mon, 3 Jun 2026 at 10:00, Acme Billing <billing@duely.app> wrote:
> Hello Initech,
> Invoice INV-0001 is past due.`;
    expect(stripQuoted(body)).toBe("I'll pay on Friday.");
  });

  it("handles an 'On … wrote:' line that wraps", () => {
    const body = `Will do.

On Mon, 3 Jun 2026 at 10:00, Acme Billing
<billing@duely.app> wrote:
> older`;
    expect(stripQuoted(body)).toBe("Will do.");
  });

  it("drops an Outlook header block", () => {
    const body = `We dispute this amount.\r\n\r\nFrom: Acme <billing@duely.app>\r\nSent: Monday\r\nSubject: Invoice\r\n\r\nHello`;
    expect(stripQuoted(body)).toBe("We dispute this amount.");
  });

  it("drops original-message and forwarded separators", () => {
    expect(stripQuoted("Thanks\n-----Original Message-----\nFrom: x")).toBe("Thanks");
    expect(stripQuoted("See below\n---------- Forwarded message ---------\nFrom: x")).toBe(
      "See below",
    );
  });

  it("drops signatures and mobile footers", () => {
    expect(stripQuoted("Paid today.\n\n-- \nBill Lumbergh\nInitech")).toBe("Paid today.");
    expect(stripQuoted("Paid today.\n\nSent from my iPhone")).toBe("Paid today.");
  });

  it("drops inline '>' lines but keeps the reply around them", () => {
    expect(stripQuoted("> are you paying?\nYes, Friday.")).toBe("Yes, Friday.");
  });

  it("keeps a body with nothing to strip, including a line that merely starts with 'On'", () => {
    expect(stripQuoted("On Friday I will transfer the money.\nThanks")).toBe(
      "On Friday I will transfer the money.\nThanks",
    );
    expect(stripQuoted("")).toBe("");
  });
});
