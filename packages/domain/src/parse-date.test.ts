import { describe, expect, it } from "vite-plus/test";

import { resolveDateText } from "./parse-date";

// Reference: Wednesday 2026-06-10, 10:00 in New York.
const ref = new Date("2026-06-10T14:00:00Z");
const tz = "America/New_York";
const r = (text: string, at = ref, zone = tz) => resolveDateText(text, at, zone);

describe("resolveDateText", () => {
  it.each([
    ["today", "2026-06-10"],
    ["tomorrow", "2026-06-11"],
    ["Friday", "2026-06-12"],
    ["on Friday", "2026-06-12"],
    ["fri", "2026-06-12"],
    ["this Friday", "2026-06-12"],
    ["Wednesday", "2026-06-17"], // today is Wednesday: the next one
    ["Monday", "2026-06-15"],
    ["next Friday", "2026-06-19"], // Friday of the following week
    ["next Monday", "2026-06-15"],
    ["in 3 days", "2026-06-13"],
    ["in two weeks", "2026-06-24"],
    ["in a week", "2026-06-17"],
    ["end of the month", "2026-06-30"],
    ["end of week", "2026-06-12"],
    ["June 12", "2026-06-12"],
    ["June 12th", "2026-06-12"],
    ["Jun 30", "2026-06-30"],
    ["12 June", "2026-06-12"],
    ["12th of June", "2026-06-12"],
    ["6/12", "2026-06-12"],
    ["6/12/2026", "2026-06-12"],
    ["6/12/26", "2026-06-12"],
    ["2026-06-12", "2026-06-12"],
    ["the 15th", "2026-06-15"],
    ["the 5th", "2026-07-05"], // already past this month
    ["January 5", "2027-01-05"], // next occurrence
  ])("%s -> %s", (text, expected) => {
    expect(r(text)).toBe(expected);
  });

  it.each([
    "soon",
    "when I can",
    "next week",
    "sometime next month",
    "in a couple of days",
    "February 30",
    "13/45",
    "yesterday",
    "2026-06-09", // past
    "June 1 2026", // past
    "",
  ])("returns null for %j", (text) => {
    expect(r(text)).toBeNull();
  });

  it("uses the client's local date, not UTC", () => {
    // 2026-06-11 02:00Z is still Wednesday evening in New York, but already Thursday in Sydney.
    const late = new Date("2026-06-11T02:00:00Z");
    expect(r("tomorrow", late, "America/New_York")).toBe("2026-06-11");
    expect(r("tomorrow", late, "Australia/Sydney")).toBe("2026-06-12");
    expect(r("today", late, "Pacific/Kiritimati")).toBe("2026-06-11");
  });

  it("handles the year boundary", () => {
    const dec = new Date("2026-12-30T15:00:00Z");
    expect(r("tomorrow", dec)).toBe("2026-12-31");
    expect(r("in 3 days", dec)).toBe("2027-01-02");
    expect(r("Jan 2", dec)).toBe("2027-01-02");
    expect(r("the 5th", dec)).toBe("2027-01-05");
  });

  it("handles leap days", () => {
    const feb = new Date("2027-02-20T15:00:00Z");
    expect(r("Feb 29", feb)).toBe("2028-02-29"); // 2027 has no Feb 29, so the next real one
    expect(r("Feb 30", feb)).toBeNull();
    expect(r("Feb 29", new Date("2027-12-01T15:00:00Z"))).toBe("2028-02-29");
  });
});
