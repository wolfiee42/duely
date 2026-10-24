import { describe, expect, it } from "vite-plus/test";

import { addDays, createClock, localDate, nowWithOffset, realNow } from "./index";

const fixed = new Date("2026-03-01T12:00:00.000Z");

describe("clock", () => {
  it("returns real time when the offset is zero", async () => {
    const clock = createClock(
      async () => 0,
      () => fixed,
    );
    expect((await clock.now("firm")).toISOString()).toBe("2026-03-01T12:00:00.000Z");
  });

  it("adds a firm's offset", async () => {
    const offsets: Record<string, number> = { demo: 3 * 86_400, other: 0 };
    const clock = createClock(
      async (id) => offsets[id] ?? 0,
      () => fixed,
    );
    expect((await clock.now("demo")).toISOString()).toBe("2026-03-04T12:00:00.000Z");
    expect((await clock.now("other")).toISOString()).toBe("2026-03-01T12:00:00.000Z");
  });

  it("applies the offset to a supplied instant", () => {
    expect(nowWithOffset(90, fixed).toISOString()).toBe("2026-03-01T12:01:30.000Z");
  });

  it("realNow tracks the system time", () => {
    expect(Math.abs(realNow().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe("localDate and addDays", () => {
  it("reads the calendar date in the given timezone", () => {
    const instant = new Date("2026-03-01T03:30:00.000Z");
    expect(localDate(instant, "UTC")).toBe("2026-03-01");
    expect(localDate(instant, "America/New_York")).toBe("2026-02-28"); // still the evening before
    expect(localDate(instant, "Asia/Tokyo")).toBe("2026-03-01");
  });

  it("handles DST changes without drifting", () => {
    expect(localDate(new Date("2026-03-08T06:59:00.000Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDate(new Date("2026-11-01T05:30:00.000Z"), "America/New_York")).toBe("2026-11-01");
  });

  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-10", -14)).toBe("2026-02-24");
    expect(addDays("2026-03-10", 14)).toBe("2026-03-24");
  });
});
