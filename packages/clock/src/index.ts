// The only place allowed to read the real time (lint rule `duely/no-raw-date`).

/** Looks up a firm's `clock_offset_seconds`. Supplied by the caller, so this package does no IO. */
export type OffsetSource = (firmId: string) => Promise<number>;

export interface Clock {
  /** Real now plus the firm's offset. Offsets are only ever non-zero for demo firms (FR-14.7). */
  now(firmId: string): Promise<Date>;
}

/** Real time with no firm involved: token expiry, session checks, anything not tied to a tenant. */
export function realNow(): Date {
  return new Date();
}

/** For code that already holds the firm row. */
export function nowWithOffset(offsetSeconds: number, real: Date = realNow()): Date {
  return new Date(real.getTime() + offsetSeconds * 1000);
}

export function createClock(getOffsetSeconds: OffsetSource, real: () => Date = realNow): Clock {
  return {
    async now(firmId) {
      return nowWithOffset(await getOffsetSeconds(firmId), real());
    },
  };
}

/** `YYYY-MM-DD` of an instant as seen in an IANA timezone (the firm's "today"). */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as ISO year-month-day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Calendar arithmetic on a `YYYY-MM-DD` string, independent of any timezone or DST. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
