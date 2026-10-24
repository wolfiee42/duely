// Calendar and timezone arithmetic for the planner. Pure: only `Intl`, no clock.

interface Parts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instant: Date, timeZone: string) {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

export function localParts(instant: Date, timeZone: string): Parts {
  const w = wallClock(instant, timeZone);
  return { date: w.date, minutes: w.hour * 60 + w.minute };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` or `HH:MM:SS` to minutes since midnight. */
export function parseClock(value: string): number {
  const [h, m] = value.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** Calendar arithmetic on a `YYYY-MM-DD` string, independent of any timezone or DST. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday. */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function offsetMs(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const [y, m, d] = w.date.split("-").map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` + `minutes`.
 * An ambiguous time (clocks go back) resolves to the first occurrence; a time that does not exist
 * (clocks go forward) resolves to the same offset applied after the gap, i.e. shifted forward.
 */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  const fits = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    return p.date === date && p.minutes === minutes;
  };
  if (fits(first)) return new Date(first);
  if (fits(second)) return new Date(second);
  return new Date(Math.max(first, second));
}
