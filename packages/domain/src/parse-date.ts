import { localParts, shiftDate, weekday } from "./tz";

// A deterministic reading of the date phrases people write in replies ("Friday", "June 12", "in 2 weeks").
// The model proposes a date; this decides whether we believe it (SPEC 5.3, FR-11.10). Anything ambiguous
// returns null, which sends the reply to a person instead of guessing.

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  a: 1,
  an: 1,
};

const dayIndex = (word: string) => DAYS.findIndex((d) => d === word || d.slice(0, 3) === word);
const monthIndex = (word: string) =>
  MONTHS.findIndex(
    (m) => m === word || (word.length >= 3 && m.startsWith(word.slice(0, 3)) && word.length <= 4),
  );

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The next occurrence of month/day on or after `today`. */
function nextMonthDay(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    if (!valid(y, month, day)) continue;
    const candidate = `${y}-${pad(month)}-${pad(day)}`;
    if (candidate >= today) return candidate;
  }
  return null;
}

/**
 * Resolves `text` against the moment the reply was sent, in the client's timezone. Returns `YYYY-MM-DD`, or
 * `null` when it cannot be read with confidence or would fall in the past.
 *
 * Conventions: a bare weekday is its next occurrence after today; "next <weekday>" is that weekday in the
 * following Monday-to-Sunday week; slash dates are US month/day.
 */
export function resolveDateText(text: string, reference: Date, timeZone: string): string | null {
  const today = localParts(reference, timeZone).date;
  const t = text
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\b(on|by|until|before|the|of|at|this|coming)\b/g, (w) =>
      w === "this" ? "this" : " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const out = resolve(t, today);
  return out && out >= today ? out : null;
}

function resolve(t: string, today: string): string | null {
  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) {
    return valid(+m[1]!, +m[2]!, +m[3]!) ? t : null;
  }
  if (t === "today" || t === "tonight" || t === "end of day" || t === "eod") return today;
  if (t === "tomorrow") return shiftDate(today, 1);
  if (t === "day after tomorrow") return shiftDate(today, 2);

  // Weekday, optionally "this"/"next".
  if ((m = /^(?:(this|next) )?([a-z]+)$/.exec(t)) && dayIndex(m[2]!) >= 0) {
    const target = dayIndex(m[2]!);
    const ahead = ((target - weekday(today) + 6) % 7) + 1; // 1..7, never today
    if (m[1] === "next") {
      // Friday of the following Monday-to-Sunday week.
      const toNextMonday = (1 - weekday(today) + 7) % 7 || 7;
      const monday = shiftDate(today, toNextMonday);
      return shiftDate(monday, (target + 6) % 7);
    }
    return shiftDate(today, ahead);
  }

  // in N days / weeks
  if ((m = /^in (\d{1,3}|[a-z]+) (day|days|week|weeks)$/.exec(t))) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!];
    if (!n) return null;
    return shiftDate(today, m[2]!.startsWith("week") ? n * 7 : n);
  }

  if (t === "end month" || t === "eom") {
    const y = +today.slice(0, 4);
    const mo = +today.slice(5, 7);
    return `${y}-${pad(mo)}-${pad(daysInMonth(y, mo))}`;
  }
  if (t === "end week" || t === "eow") {
    const ahead = (5 - weekday(today) + 7) % 7;
    return shiftDate(today, ahead);
  }

  // "june 12", "jun 12th", "12 june", "12th june"
  if ((m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t)) && monthIndex(m[1]!) >= 0) {
    return withYear(today, monthIndex(m[1]!) + 1, +m[2]!, m[3]);
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/.exec(t)) && monthIndex(m[2]!) >= 0) {
    return withYear(today, monthIndex(m[2]!) + 1, +m[1]!, m[3]);
  }

  // US m/d or m/d/yyyy
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t))) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
    return withYear(today, +m[1]!, +m[2]!, year);
  }

  // "the 15th" (the leading "the" was stripped)
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(t))) {
    const day = +m[1]!;
    const y = +today.slice(0, 4);
    const mo = +today.slice(5, 7);
    for (const [yy, mm] of [[y, mo], mo === 12 ? [y + 1, 1] : [y, mo + 1]] as Array<
      [number, number]
    >) {
      if (valid(yy, mm, day) && `${yy}-${pad(mm)}-${pad(day)}` >= today) {
        return `${yy}-${pad(mm)}-${pad(day)}`;
      }
    }
    return null;
  }
  return null;
}

function withYear(today: string, month: number, day: number, year?: string): string | null {
  if (year) return valid(+year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
  return nextMonthDay(today, month, day);
}
