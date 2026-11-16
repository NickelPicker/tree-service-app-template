/**
 * Clock-in / clock-out tap times (business rule, "Live-only
 * clock-in unless allowed"; the "manager pay and live clock-in" rules).
 *
 * Time entries store a date ('YYYY-MM-DD') and 'HH:MM' as wall clock
 * time in the business's time zone (BUSINESS_TIME_ZONE, src/businessSettings.ts),
 * and the database checks a crew tap against its own clock in
 * public.business_time_zone(). So a tap time is always taken in that zone,
 * whatever time zone the phone is set to (a phone left on another zone
 * would otherwise record hours off and be refused). Only clock taps use
 * this: the rest of the app's dates (todayStr, schedule, ...) are
 * unchanged.
 *
 * The database accepts a crew tap (without "May enter hours by hand")
 * when it is at most 5 minutes ahead and no older than 12 hours for a
 * clock-in, 24 hours for a clock-out (taps kept on the phone without
 * signal are sent later with the time they were made). A tap that is
 * too old is refused with code CT001 and a message giving the tapped
 * time; the app keeps that tap on the phone, marked failed with the
 * message, instead of dropping it (src/fieldQueue.ts). Since migration
 * the "crew day and 8pm clockout" rules there are no overnight crew shifts: see the 8 PM rule
 * below (eightPmClockOut).
 */

import { BUSINESS_TIME_ZONE } from "./businessSettings";

export const CLOCK_TZ = BUSINESS_TIME_ZONE;
export const CLOCK_IN_MAX_AGE_HOURS = 12;
export const CLOCK_OUT_MAX_AGE_HOURS = 24;
/** The database's error code for "this tap is too old to save". */
export const TAP_TOO_OLD_CODE = "CT001";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CLOCK_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The Denver date and 'HH:MM' at this moment (default: now). */
export function clockNow(now: Date = new Date()): { date: string; time: string } {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  // Some engines print midnight as "24" even with h23.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

/**
 * Every moment (epoch ms) a Denver date + 'HH:MM' can mean: one, two in
 * the repeated 1 am hour when the clocks go back (MDT and MST), none in
 * the skipped hour in March. `afterIn`: the entry's clock-in, for a
 * clock-out (earlier than it = the next day).
 */
export function clockMoments(date: string, hhmm: string, afterIn?: string | null): number[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}/.test(hhmm)) return [];
  const time = hhmm.slice(0, 5);
  let day = date;
  if (afterIn && /^\d{2}:\d{2}/.test(afterIn) && time < afterIn.slice(0, 5)) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    day = d.toISOString().slice(0, 10);
  }
  const out: number[] = [];
  for (const offset of ["-06:00", "-07:00"]) {
    const ms = Date.parse(`${day}T${time}:00${offset}`);
    if (Number.isNaN(ms)) continue;
    const back = clockNow(new Date(ms));
    if (back.date === day && back.time === time) out.push(ms);
  }
  return out;
}

/** The Denver date before `date` ('YYYY-MM-DD'). */
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The 8 PM rule (business rule: "A clock out should be forced at
 * 8pm, we don't do overnight shifts ... If they do then the office will
 * have to do the hours manually."; the "crew day and 8pm clockout" rules). Every
 * open entry ends at 20:00 on its own day at the latest; the database
 * closes it there (marked `autoClosed`). Crew without "May enter hours
 * by hand" cannot clock in at or after 8 PM.
 */
export const CLOCK_DAY_END = "20:00";
export const AFTER_8PM_TEXT = "After 8 PM the office enters hours.";
export const CLOSED_AT_8PM_TEXT = "Closed automatically at 8 PM";

/** True when live clock-in is closed for the day (8 PM or later, Denver). */
export function pastClockDayEnd(now: Date = new Date()): boolean {
  return clockNow(now).time >= CLOCK_DAY_END;
}

/**
 * The clock-out an open entry has under the 8 PM rule, or null while it
 * still runs: 20:00 for an entry from an earlier day, or from today once
 * 8 PM has passed. An entry clocked in at 20:00 or later (typed by the
 * office) is left alone, as the database does.
 */
export function eightPmClockOut(
  entry: { date: string; clockIn: string | null; clockOut: string | null },
  now: Date = new Date(),
): string | null {
  if (!entry.clockIn || entry.clockOut !== null) return null;
  if (entry.clockIn.slice(0, 5) >= CLOCK_DAY_END) return null;
  const today = clockNow(now);
  if (entry.date < today.date) return autoClosesOn(entry.date, today.date) ? CLOCK_DAY_END : null;
  if (entry.date === today.date && today.time >= CLOCK_DAY_END) return CLOCK_DAY_END;
  return null;
}

/**
 * The 8 PM rule closes open entries by itself only for the last 3 days
 * (today and the 2 days before, Denver); an older open entry is left
 * for the office (the database also leaves entries in approved weeks).
 */
export const AUTO_CLOSE_DAYS_BACK = 2;
export function autoClosesOn(date: string, today: string): boolean {
  let from = today;
  for (let i = 0; i < AUTO_CLOSE_DAYS_BACK; i++) from = dayBefore(from);
  return date >= from && date <= today;
}

/**
 * The time a Clock out tap saves for this entry: now, or 20:00 when the
 * 8 PM rule already ended it (the database saves the same).
 */
export function clockOutTapTime(
  entry: { date: string; clockIn: string | null; clockOut: string | null },
  now: Date = new Date(),
): { time: string; autoClosed: boolean } {
  const capped = eightPmClockOut(entry, now);
  if (capped) return { time: capped, autoClosed: true };
  // An older open entry: the database saves 20:00 of its day too.
  if (entry.clockIn && entry.clockIn.slice(0, 5) < CLOCK_DAY_END && entry.date < clockNow(now).date) {
    return { time: CLOCK_DAY_END, autoClosed: true };
  }
  return { time: clockNow(now).time, autoClosed: false };
}

/** The database's "too old" message, for a refusal reason. */
export function isTapTooOldMessage(message: string | null | undefined): boolean {
  return /couldn't be saved\..*Tell the office the time you tapped: \d{4}-\d{2}-\d{2} at \d{2}:\d{2}/.test(
    message ?? "",
  );
}

/** The tapped date and time named in a "too old" message, or null. */
export function tappedAtFromMessage(
  message: string | null | undefined,
): { date: string; time: string } | null {
  const m = /tapped: (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/.exec(message ?? "");
  return m ? { date: m[1], time: m[2] } : null;
}
