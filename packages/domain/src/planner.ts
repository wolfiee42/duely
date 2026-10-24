import { localParts, parseClock, shiftDate, weekday, zonedInstant } from "./tz";

// SPEC 4.1. Pure: given an invoice's due date, a policy and a client timezone, decide when each step
// should fire. Callers persist the result; nothing here reads a clock.

export interface QuietWindow {
  /** `HH:MM`. Sends are allowed in [start, end) in the client's timezone (FR-9.8). */
  quietStart: string;
  quietEnd: string;
  sendWeekends: boolean;
}

export interface PlanStep {
  id: string;
  offsetDays: number;
}

export interface JobPlan {
  stepId: string;
  /** `due_date + offset`, a calendar date in the client's timezone. */
  plannedFor: string;
  /** When to run. Meaningful only for `schedule`. */
  nextRunAt: Date;
  /**
   * `schedule`: run at `nextRunAt`. `skip`: not worth sending (a notice for a date that has passed, or an
   * older step superseded by a later catch-up).
   */
  action: "schedule" | "skip";
}

const allowedDay = (date: string, window: QuietWindow) =>
  window.sendWeekends || (weekday(date) !== 0 && weekday(date) !== 6);

/**
 * The earliest instant at or after `from` that is inside the sending window on an allowed day.
 * Deferring is never dropping: a send that misses today's window goes to the start of the next one.
 */
export function nextAllowedInstant(from: Date, window: QuietWindow, timeZone: string): Date {
  const start = parseClock(window.quietStart);
  const end = parseClock(window.quietEnd);
  const here = localParts(from, timeZone);

  if (allowedDay(here.date, window)) {
    if (here.minutes >= start && here.minutes < end) return from;
    if (here.minutes < start) return zonedInstant(here.date, start, timeZone);
  }
  let date = shiftDate(here.date, 1);
  while (!allowedDay(date, window)) date = shiftDate(date, 1);
  return zonedInstant(date, start, timeZone);
}

export function plan(input: {
  dueDate: string;
  steps: readonly PlanStep[];
  window: QuietWindow;
  /** The client's timezone (their own, else the firm's). */
  timeZone: string;
  now: Date;
}): JobPlan[] {
  const { dueDate, window, timeZone, now } = input;
  const today = localParts(now, timeZone).date;
  const start = parseClock(window.quietStart);

  const entries = [...input.steps]
    .sort((a, b) => a.offsetDays - b.offsetDays)
    .map((step) => ({ step, plannedFor: shiftDate(dueDate, step.offsetDays) }));

  // Of the steps whose date has passed, only the latest is worth sending, and only if it is not a
  // "before due" notice. Sending the whole backlog at once would read as spam (SPEC 4.1).
  const past = entries.filter((e) => e.plannedFor < today);
  const catchUp = past.filter((e) => e.step.offsetDays >= 0).at(-1);

  return entries.map(({ step, plannedFor }): JobPlan => {
    const passed = plannedFor < today;
    if (passed && step !== catchUp?.step) {
      return { stepId: step.id, plannedFor, nextRunAt: now, action: "skip" };
    }
    const candidate = zonedInstant(plannedFor, start, timeZone);
    const from = candidate.getTime() < now.getTime() ? now : candidate;
    return {
      stepId: step.id,
      plannedFor,
      nextRunAt: nextAllowedInstant(from, window, timeZone),
      action: "schedule",
    };
  });
}
