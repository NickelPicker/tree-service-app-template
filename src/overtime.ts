import { OVERTIME_RULES, type OvertimeRules } from "./businessSettings";
import type { TimesheetEntry } from "./types";

/**
 * Colorado overtime (COMPS Order #40, in force from Feb 1, 2026): the
 * example rule this template ships with. OVERTIME_RULES in
 * src/businessSettings.ts picks it ("colorado") or the federal
 * 40-hours-a-week rule only ("weekly40"); see weekOvertime below.
 *
 * A non-exempt worker earns 1.5 times their regular rate for each hour
 * worked over:
 *   - 40 hours in the workweek (Monday to Sunday here),
 *   - 12 hours in a workday (a calendar day, midnight to midnight), or
 *   - 12 hours in a row, even when the stretch crosses midnight,
 * whichever gives the worker more. The same hour is never counted twice:
 * the daily and in-a-row rules are combined hour by hour, and the result
 * is compared with the weekly rule (the larger one is paid).
 *
 * Workday: the calendar day of the clock times as they were recorded
 * (the business's time zone), midnight to
 * midnight; a shift from 10 PM to 2 AM is 2 hours on each day.
 *
 * "In a row" (business rule: "a break will still be part of the 12
 * hour stretch"): the stretch runs from the first clock-in to the last
 * clock-out, and a gap between clock entries shorter than
 * BREAK_ENDS_STRETCH_MINUTES does not end it and counts toward its 12
 * hours (6:00-12:00 and 12:30-19:00 is one 13-hour stretch). Crew do
 * not clock out for lunch (they are paid through it), so lunch is
 * already inside the clocked time. A gap is not added to the hours
 * worked or paid: only clocked minutes are, and only clocked minutes
 * after the 12th hour of the stretch are overtime. A gap of
 * BREAK_ENDS_STRETCH_MINUTES (1 hour 15 minutes, business rule) or
 * more ends the stretch. Hours typed in
 * by hand (no clock times) count toward the day and the week, but not
 * toward "in a row" (we do not know when they were).
 *
 * A clock-out earlier than the clock-in means the shift ran past
 * midnight (clock in 6:00 PM, clock out 4:00 AM = 10 hours).
 *
 * People paid fixed weekly hours (src/weeklyPay.ts) have no clock times
 * that count: fixedHoursOvertime gives them the weekly rule only.
 */
export const WEEK_LIMIT_MINUTES = 40 * 60;
export const DAY_LIMIT_MINUTES = 12 * 60;
export const BREAK_ENDS_STRETCH_MINUTES = 75;

export type OvertimeRule = "week" | "day" | "row";

export const OVERTIME_RULE_TEXT: Record<OvertimeRule, string> = {
  week: "over 40 in the week",
  day: "over 12 in a day",
  row: "over 12 hours in a row",
};

export interface OvertimeResult {
  /** All hours worked in the week. */
  hours: number;
  /** Hours paid at the regular rate only (hours − overtime hours). */
  regularHours: number;
  overtimeHours: number;
  /** Which rule gave the overtime (empty when there is none). */
  rules: OvertimeRule[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Minutes one entry counts for: clock times win (a clock-out before the
 * clock-in ran past midnight), otherwise typed hours. Still clocked in = 0.
 */
export function entryMinutes(e: Pick<TimesheetEntry, "clockIn" | "clockOut" | "hours">): number {
  if (e.clockIn && e.clockOut) {
    const a = toMinutes(e.clockIn);
    const b = toMinutes(e.clockOut);
    if (a === null || b === null) return 0;
    return b >= a ? b - a : b + 1440 - a;
  }
  if (e.clockIn && !e.clockOut) return 0;
  const h = e.hours ?? 0;
  return h > 0 ? Math.round(h * 60) : 0;
}

/**
 * Overtime for one person's entries in one week. `week` is the seven
 * dates (Monday first); entries on other dates are ignored.
 *
 * `prior` is that person's entries dated the day before the week (the
 * Sunday before). They are not this week's hours or pay (last week's run
 * pays them), but a shift on Sunday night that runs past midnight is
 * part of Monday's 12-hour day and of a stretch in a row that goes on
 * into Monday. So their minutes are counted as worked time, and only
 * this week's own minutes can be marked as this week's overtime.
 */
export function coloradoOvertime(
  entries: Array<Pick<TimesheetEntry, "date" | "clockIn" | "clockOut" | "hours">>,
  week: string[],
  prior: Array<Pick<TimesheetEntry, "date" | "clockIn" | "clockOut" | "hours">> = [],
): OvertimeResult {
  // Day 0 is the day before the week; week[i] is day i + 1. One extra
  // day at the end: a Sunday night shift running into Monday morning.
  const dayOf = new Map(week.map((d, i) => [d, i + 1]));
  const days = week.length + 2;
  const span = days * 1440;
  const worked = new Uint8Array(span);
  /** Minutes of this week's own entries (the only ones paid here). */
  const own = new Uint8Array(span);
  const typed = new Array<number>(days).fill(0);
  let total = 0;
  for (const e of prior) {
    if (!(e.clockIn && e.clockOut)) continue;
    const mins = entryMinutes(e);
    if (mins <= 0) continue;
    const start = toMinutes(e.clockIn) ?? 0;
    for (let m = start; m < Math.min(span, start + mins); m++) worked[m] = 1;
  }
  for (const e of entries) {
    const d = dayOf.get(e.date);
    if (d === undefined) continue;
    const mins = entryMinutes(e);
    if (mins <= 0) continue;
    total += mins;
    if (e.clockIn && e.clockOut) {
      const start = d * 1440 + (toMinutes(e.clockIn) ?? 0);
      for (let m = start; m < Math.min(span, start + mins); m++) {
        worked[m] = 1;
        own[m] = 1;
      }
    } else {
      typed[d] += mins;
    }
  }

  const daily = new Uint8Array(span);
  let typedOvertime = 0;
  for (let d = 0; d < days; d++) {
    // Typed hours count first in the day, so clocked time after them can
    // go over 12.
    let count = typed[d];
    typedOvertime += Math.max(0, typed[d] - DAY_LIMIT_MINUTES);
    for (let m = d * 1440; m < (d + 1) * 1440; m++) {
      if (!worked[m]) continue;
      if (count >= DAY_LIMIT_MINUTES) daily[m] = 1;
      count++;
    }
  }

  const inRow = new Uint8Array(span);
  let stretch = 0;
  let gap = Infinity;
  for (let m = 0; m < span; m++) {
    if (!worked[m]) {
      gap++;
      continue;
    }
    // A short gap (a break) stays part of the stretch and counts toward
    // its 12 hours; a long one starts a new stretch.
    if (gap >= BREAK_ENDS_STRETCH_MINUTES) stretch = 0;
    else stretch += gap;
    gap = 0;
    stretch++;
    if (stretch > DAY_LIMIT_MINUTES) inRow[m] = 1;
  }

  let either = typedOvertime;
  let dayMarks = typedOvertime;
  let rowMarks = 0;
  for (let m = 0; m < span; m++) {
    if (!own[m]) continue;
    if (daily[m] || inRow[m]) either++;
    if (daily[m]) dayMarks++;
    if (inRow[m]) rowMarks++;
  }
  const weekly = Math.max(0, total - WEEK_LIMIT_MINUTES);
  const ot = Math.max(either, weekly);
  const rules: OvertimeRule[] = [];
  if (ot > 0) {
    if (weekly >= either) rules.push("week");
    else {
      if (dayMarks > 0) rules.push("day");
      if (rowMarks > 0) rules.push("row");
    }
  }
  return {
    hours: round2(total / 60),
    regularHours: round2((total - ot) / 60),
    overtimeHours: round2(ot / 60),
    rules,
  };
}

/**
 * Overtime for someone paid fixed weekly hours (e.g. Sam, 32): those
 * hours are the hours counted for the week (business rule: "Sam can
 * get overtime, but generally she will be at 32 hours every week"). They
 * have no clock times or days, so only the weekly rule can apply: hours
 * over 40 are overtime. 32 fixed hours give none; 45 give 5.
 */
/**
 * The federal (FLSA) rule only: hours over 40 in the workweek are
 * overtime; no daily or in-a-row rule. Used when OVERTIME_RULES in
 * src/businessSettings.ts is "weekly40".
 */
export function weeklyOnlyOvertime(
  entries: Array<Pick<TimesheetEntry, "date" | "clockIn" | "clockOut" | "hours">>,
  week: string[],
): OvertimeResult {
  const days = new Set(week);
  let total = 0;
  for (const e of entries) if (days.has(e.date)) total += Math.max(0, entryMinutes(e));
  const ot = Math.max(0, total - WEEK_LIMIT_MINUTES);
  return {
    hours: round2(total / 60),
    regularHours: round2((total - ot) / 60),
    overtimeHours: round2(ot / 60),
    rules: ot > 0 ? ["week"] : [],
  };
}

/** Overtime for one person's week under the business's OVERTIME_RULES setting. */
export function weekOvertime(
  entries: Array<Pick<TimesheetEntry, "date" | "clockIn" | "clockOut" | "hours">>,
  week: string[],
  prior: Array<Pick<TimesheetEntry, "date" | "clockIn" | "clockOut" | "hours">> = [],
  rules: OvertimeRules = OVERTIME_RULES,
): OvertimeResult {
  return rules === "weekly40" ? weeklyOnlyOvertime(entries, week) : coloradoOvertime(entries, week, prior);
}

export function fixedHoursOvertime(fixedHours: number): OvertimeResult {
  const total = Math.max(0, Math.round(fixedHours * 60));
  const ot = Math.max(0, total - WEEK_LIMIT_MINUTES);
  return {
    hours: round2(total / 60),
    regularHours: round2((total - ot) / 60),
    overtimeHours: round2(ot / 60),
    rules: ot > 0 ? ["week"] : [],
  };
}
