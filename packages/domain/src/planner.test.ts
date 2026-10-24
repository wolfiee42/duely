import { describe, expect, it } from "vite-plus/test";

import { nextAllowedInstant, plan, type QuietWindow } from "./planner";
import { localParts, shiftDate, weekday, zonedInstant } from "./tz";

const WINDOW: QuietWindow = { quietStart: "08:00", quietEnd: "19:00", sendWeekends: false };
const WEEKENDS: QuietWindow = { ...WINDOW, sendWeekends: true };
const at = (iso: string) => new Date(iso);
const wall = (d: Date, tz: string) => {
  const p = localParts(d, tz);
  return `${p.date} ${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
};

describe("zonedInstant", () => {
  it("reads the wall clock in the zone", () => {
    expect(zonedInstant("2026-07-01", 8 * 60, "America/New_York").toISOString()).toBe(
      "2026-07-01T12:00:00.000Z",
    );
    expect(zonedInstant("2026-01-15", 8 * 60, "America/New_York").toISOString()).toBe(
      "2026-01-15T13:00:00.000Z",
    );
    expect(zonedInstant("2026-07-01", 8 * 60, "Asia/Kolkata").toISOString()).toBe(
      "2026-07-01T02:30:00.000Z",
    );
  });

  it("shifts a time that does not exist to just after the gap", () => {
    // New York springs forward 2026-03-08 at 02:00: 02:30 never happens.
    const t = zonedInstant("2026-03-08", 2 * 60 + 30, "America/New_York");
    expect(wall(t, "America/New_York")).toBe("2026-03-08 03:30");
  });

  it("takes the first of two occurrences when clocks go back", () => {
    // New York falls back 2026-11-01 at 02:00: 01:30 happens twice.
    const t = zonedInstant("2026-11-01", 90, "America/New_York");
    expect(t.toISOString()).toBe("2026-11-01T05:30:00.000Z"); // EDT, the first one
  });

  it("handles half-hour DST (Lord Howe) and zones east of the date line", () => {
    expect(
      wall(zonedInstant("2026-01-10", 480, "Australia/Lord_Howe"), "Australia/Lord_Howe"),
    ).toBe("2026-01-10 08:00");
    expect(wall(zonedInstant("2026-06-10", 480, "Pacific/Auckland"), "Pacific/Auckland")).toBe(
      "2026-06-10 08:00",
    );
  });
});

describe("nextAllowedInstant", () => {
  const tz = "America/New_York";

  it("keeps an instant already inside the window", () => {
    const t = at("2026-06-10T15:00:00Z"); // Wed 11:00 NY
    expect(nextAllowedInstant(t, WINDOW, tz)).toEqual(t);
  });

  it("moves an early instant to the start of today's window", () => {
    expect(wall(nextAllowedInstant(at("2026-06-10T09:00:00Z"), WINDOW, tz), tz)).toBe(
      "2026-06-10 08:00",
    ); // 05:00 NY
  });

  it("defers a late instant to the next morning, in the client's zone", () => {
    expect(wall(nextAllowedInstant(at("2026-06-10T23:30:00Z"), WINDOW, tz), tz)).toBe(
      "2026-06-11 08:00",
    ); // 19:30 NY
  });

  it("treats the end of the window as outside it", () => {
    expect(wall(nextAllowedInstant(at("2026-06-10T23:00:00Z"), WINDOW, tz), tz)).toBe(
      "2026-06-11 08:00",
    ); // exactly 19:00 NY
  });

  it("skips weekends unless allowed", () => {
    const sat = at("2026-06-13T15:00:00Z");
    expect(wall(nextAllowedInstant(sat, WINDOW, tz), tz)).toBe("2026-06-15 08:00");
    expect(nextAllowedInstant(sat, WEEKENDS, tz)).toEqual(sat);
    // Friday evening rolls over the whole weekend.
    expect(wall(nextAllowedInstant(at("2026-06-12T23:30:00Z"), WINDOW, tz), tz)).toBe(
      "2026-06-15 08:00",
    );
  });

  it("judges the weekend by the client's calendar, not UTC", () => {
    // Fri 22:00 in Los Angeles is already Saturday in UTC.
    const t = at("2026-06-13T05:00:00Z");
    expect(wall(t, "America/Los_Angeles")).toBe("2026-06-12 22:00");
    expect(wall(nextAllowedInstant(t, WINDOW, "America/Los_Angeles"), "America/Los_Angeles")).toBe(
      "2026-06-15 08:00",
    );
  });

  it("survives DST changes between now and the next window", () => {
    // Sat 2026-03-07 evening -> Monday 08:00 EDT (clocks changed on Sunday).
    const out = nextAllowedInstant(at("2026-03-08T03:00:00Z"), WINDOW, tz);
    expect(wall(out, tz)).toBe("2026-03-09 08:00");
    expect(out.toISOString()).toBe("2026-03-09T12:00:00.000Z");
  });
});

describe("nextAllowedInstant properties", () => {
  // Deterministic pseudo-random inputs (no flaky runs).
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const zones = [
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Pacific/Auckland",
    "Pacific/Kiritimati",
    "UTC",
  ];
  const windows: QuietWindow[] = [
    WINDOW,
    WEEKENDS,
    { quietStart: "09:30", quietEnd: "17:45", sendWeekends: false },
    { quietStart: "00:00", quietEnd: "23:59", sendWeekends: false },
  ];

  it("always lands inside the window on an allowed day, never earlier, and is idempotent", () => {
    for (let i = 0; i < 4000; i++) {
      const from = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 365 * 86_400_000));
      const tz = zones[Math.floor(rand() * zones.length)]!;
      const window = windows[Math.floor(rand() * windows.length)]!;
      const out = nextAllowedInstant(from, window, tz);
      const here = localParts(out, tz);
      const label = `${from.toISOString()} ${tz} ${JSON.stringify(window)}`;

      expect(out.getTime(), label).toBeGreaterThanOrEqual(from.getTime());
      // Within a week: never silently dropped or pushed far out.
      expect(out.getTime() - from.getTime(), label).toBeLessThan(4 * 86_400_000);
      if (!window.sendWeekends) {
        expect([0, 6], label).not.toContain(weekday(here.date));
      }
      const [sh, sm] = window.quietStart.split(":").map(Number) as [number, number];
      const [eh, em] = window.quietEnd.split(":").map(Number) as [number, number];
      // A window start inside a DST gap lands an hour late; allow that, but never outside the day's window.
      expect(here.minutes, label).toBeGreaterThanOrEqual(sh * 60 + sm);
      expect(here.minutes, label).toBeLessThan(eh * 60 + em);
      expect(nextAllowedInstant(out, window, tz), label).toEqual(out);
    }
  });

  it("is monotonic: a later input never yields an earlier result", () => {
    for (let i = 0; i < 1500; i++) {
      const a = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 365 * 86_400_000));
      const b = new Date(a.getTime() + Math.floor(rand() * 3 * 86_400_000));
      const tz = zones[Math.floor(rand() * zones.length)]!;
      const window = windows[Math.floor(rand() * windows.length)]!;
      expect(nextAllowedInstant(b, window, tz).getTime()).toBeGreaterThanOrEqual(
        nextAllowedInstant(a, window, tz).getTime(),
      );
    }
  });
});

describe("plan", () => {
  const steps = [
    { id: "pre", offsetDays: -3 },
    { id: "due", offsetDays: 0 },
    { id: "p3", offsetDays: 3 },
    { id: "p7", offsetDays: 7 },
    { id: "p14", offsetDays: 14 },
  ];
  const tz = "America/Chicago";
  const run = (dueDate: string, now: string) =>
    plan({ dueDate, steps, window: WINDOW, timeZone: tz, now: at(now) });
  const byId = (plans: ReturnType<typeof run>) =>
    Object.fromEntries(plans.map((p) => [p.stepId, p]));

  it("schedules every step at the start of the window on its date", () => {
    const p = byId(run("2026-06-17", "2026-06-10T12:00:00Z")); // due Wed, today Wed 07:00 CT
    expect(p.pre).toMatchObject({ plannedFor: "2026-06-14", action: "schedule" });
    // 06-14 is a Sunday: deferred to Monday 06-15 at 08:00 CT.
    expect(wall(p.pre!.nextRunAt, tz)).toBe("2026-06-15 08:00");
    expect(wall(p.due!.nextRunAt, tz)).toBe("2026-06-17 08:00");
    expect(wall(p.p3!.nextRunAt, tz)).toBe("2026-06-22 08:00"); // 06-20 is a Saturday
    expect(wall(p.p7!.nextRunAt, tz)).toBe("2026-06-24 08:00");
    expect(wall(p.p14!.nextRunAt, tz)).toBe("2026-07-01 08:00");
    expect(Object.values(p).every((x) => x.action === "schedule")).toBe(true);
  });

  it("uses the client's local date, not UTC, to decide what has passed", () => {
    // 2026-06-18 03:00Z is still Wed 06-17 22:00 in Chicago, so a due date of 06-17 is today, not past.
    const p = byId(run("2026-06-17", "2026-06-18T03:00:00Z"));
    expect(p.due!.action).toBe("schedule");
    expect(wall(p.due!.nextRunAt, tz)).toBe("2026-06-18 08:00"); // after hours: next morning
    expect(p.pre!.action).toBe("skip"); // the pre-due notice is past
  });

  it("drops past pre-due notices but never back-sends them", () => {
    const p = byId(run("2026-06-17", "2026-06-17T15:00:00Z"));
    expect(p.pre!.action).toBe("skip");
    expect(p.due!.action).toBe("schedule");
    expect(p.due!.nextRunAt.toISOString()).toBe("2026-06-17T15:00:00.000Z"); // 10:00 CT, in window: now
  });

  it("sends at most one catch-up for an invoice that is already well overdue", () => {
    const p = byId(run("2026-06-01", "2026-06-12T15:00:00Z")); // 11 days late
    const scheduled = Object.values(p).filter(
      (x) => x.action === "schedule" && x.nextRunAt <= at("2026-06-12T15:00:00Z"),
    );
    // due(+0), +3, +7 have passed; only the latest of them (+7) catches up.
    expect(p.due!.action).toBe("skip");
    expect(p.p3!.action).toBe("skip");
    expect(p.p7!.action).toBe("schedule");
    expect(scheduled.map((x) => x.stepId)).toEqual(["p7"]);
    expect(p.p14!.plannedFor).toBe("2026-06-15");
    expect(p.p14!.action).toBe("schedule");
  });

  it("defers a catch-up that is due outside the window", () => {
    const p = byId(run("2026-06-01", "2026-06-12T03:00:00Z")); // Thu 22:00 CT
    expect(wall(p.p7!.nextRunAt, tz)).toBe("2026-06-12 08:00");
  });

  it("is stable when planned again with the same inputs", () => {
    expect(run("2026-06-17", "2026-06-10T12:00:00Z")).toEqual(
      run("2026-06-17", "2026-06-10T12:00:00Z"),
    );
  });

  it("keeps planned dates on the calendar across a DST change", () => {
    const p = plan({
      dueDate: "2026-03-05",
      steps: [{ id: "x", offsetDays: 7 }],
      window: WINDOW,
      timeZone: "America/New_York",
      now: at("2026-03-01T12:00:00Z"),
    });
    expect(p[0]!.plannedFor).toBe(shiftDate("2026-03-05", 7));
    expect(wall(p[0]!.nextRunAt, "America/New_York")).toBe("2026-03-12 08:00");
  });
});
