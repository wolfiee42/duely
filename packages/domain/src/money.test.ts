import { describe, expect, it } from "vite-plus/test";

import {
  formatQuantity,
  formatUsd,
  invoiceTotals,
  lineAmount,
  parseQuantity,
  platformFee,
} from "./money";

describe("parseQuantity", () => {
  it.each([
    ["1", 1000],
    ["2.5", 2500],
    ["0.125", 125],
    ["  3.10 ", 3100],
    ["0.001", 1],
  ])("%s -> %i", (input, milli) => expect(parseQuantity(input)).toBe(milli));

  it.each([[""], ["0"], ["0.000"], ["-1"], ["1.0005"], ["abc"], ["1e3"], [".5"], ["1,5"]])(
    "rejects %j",
    (input) => expect(parseQuantity(input)).toBeNull(),
  );

  it("round-trips through formatQuantity", () => {
    for (const milli of [1, 125, 1000, 1500, 2050, 999_999]) {
      expect(parseQuantity(formatQuantity(milli))).toBe(milli);
    }
    expect(formatQuantity(2500)).toBe("2.5");
    expect(formatQuantity(3000)).toBe("3");
  });
});

describe("lineAmount (round half up)", () => {
  it.each([
    [1000, 1999, 1999], // 1 x $19.99
    [1500, 1001, 1502], // 1.5 x 10.01 = 15.015 -> 1502 (half rounds up)
    [500, 1, 1], // 0.5 x 1 = 0.5 -> 1
    [499, 1, 0], // 0.499 -> 0
    [1, 999, 1], // 0.999 -> 1
    [333, 100, 33], // 33.3 -> 33
    [2500, 333, 833], // 832.5 -> 833
    [1000, 0, 0],
  ])("qty %i x unit %i = %i", (q, unit, expected) => expect(lineAmount(q, unit)).toBe(expected));

  it("does not overflow on large intermediate products", () => {
    // 999,999.999 x 9e9 = 8,999,999,991,000,000: past 2^53 / 1000 in the product, still exact via BigInt.
    expect(lineAmount(999_999_999, 9_000_000_000)).toBe(8_999_999_991_000_000);
    expect(() => lineAmount(999_999_999, 9_007_199_254_740_991)).toThrow(RangeError);
  });

  it("rejects non-positive quantity and negative or fractional amounts", () => {
    expect(() => lineAmount(0, 100)).toThrow(RangeError);
    expect(() => lineAmount(1000, -1)).toThrow(RangeError);
    expect(() => lineAmount(1000, 1.5)).toThrow(RangeError);
  });
});

describe("invoiceTotals", () => {
  it("rounds each line, then sums", () => {
    // Three lines of 0.5 x 1 each round to 1; rounding the sum (1.5) instead would give 2.
    const t = invoiceTotals([
      { quantityMilli: 500, unitAmountMinor: 1 },
      { quantityMilli: 500, unitAmountMinor: 1 },
      { quantityMilli: 500, unitAmountMinor: 1 },
    ]);
    expect(t).toEqual({ lineAmounts: [1, 1, 1], subtotalMinor: 3, totalMinor: 3 });
  });

  it("is zero for no lines", () => {
    expect(invoiceTotals([]).totalMinor).toBe(0);
  });
});

describe("platformFee (floor)", () => {
  it.each([
    [10_000, 100, 100], // 1% of $100
    [9999, 100, 99], // 99.99 -> 99
    [199, 100, 1],
    [99, 100, 0],
    [123_456, 250, 3086], // 3086.4
    [10_000, 0, 0],
    [10_000, 10_000, 10_000],
  ])("fee on %i at %i bps = %i", (amount, bps, fee) => expect(platformFee(amount, bps)).toBe(fee));

  it("never exceeds the amount and rejects bad input", () => {
    expect(() => platformFee(100, 10_001)).toThrow(RangeError);
    expect(() => platformFee(-1, 100)).toThrow(RangeError);
  });
});

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [5, "$0.05"],
    [123_456, "$1,234.56"],
    [-250, "-$2.50"],
  ])("%i -> %s", (minor, text) => expect(formatUsd(minor)).toBe(text));
});
