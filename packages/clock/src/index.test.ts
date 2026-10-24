import { describe, expect, it } from "vite-plus/test";

import { createClock, nowWithOffset, realNow } from "./index";

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
