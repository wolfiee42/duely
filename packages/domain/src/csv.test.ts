import { describe, expect, it } from "vite-plus/test";

import { CsvError, MAX_CSV_ROWS, parseCsv, parseCsvDate, parseMoney, toCsv } from "./csv";

describe("parseCsv", () => {
  it("reads plain rows with LF, CRLF and a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("handles quotes, embedded commas, doubled quotes and newlines", () => {
    expect(parseCsv('name,note\n"Smith, J","said ""hi""\nthere"\n')).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthere'],
    ]);
  });
  it("keeps empty fields, skips blank lines and drops a BOM", () => {
    expect(parseCsv("﻿a,b,c\n\n1,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
  it("rejects an unclosed quote and oversize input", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(CsvError);
    expect(() => parseCsv("x".repeat(1_000_001))).toThrow(/too large/);
    expect(() => parseCsv(Array.from({ length: MAX_CSV_ROWS + 5 }, () => "a").join("\n"))).toThrow(
      /up to/,
    );
  });
  it("round-trips through toCsv", () => {
    const rows = [
      ["a", 'b,"c"'],
      ["line\nbreak", ""],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("parseMoney", () => {
  it.each([
    ["1200", 120000],
    ["$1,200.50", 120050],
    ["0.5", 50],
    ["12.05", 1205],
    [" 7 ", 700],
  ])("%s", (s, n) => {
    expect(parseMoney(s)).toBe(n);
  });
  it.each(["", "abc", "-5", "1.234", "1,2,3x", "€5"])("rejects %j", (s) => {
    expect(parseMoney(s)).toBeNull();
  });
});

describe("parseCsvDate", () => {
  it("reads ISO and US dates, and rejects the impossible", () => {
    expect(parseCsvDate("2026-07-01")).toBe("2026-07-01");
    expect(parseCsvDate("7/1/2026")).toBe("2026-07-01");
    expect(parseCsvDate("12/31/2026")).toBe("2026-12-31");
    expect(parseCsvDate("2026-02-30")).toBeNull();
    expect(parseCsvDate("13/1/2026")).toBeNull();
    expect(parseCsvDate("July 1")).toBeNull();
  });
});
