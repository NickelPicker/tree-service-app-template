/**
 * US federal holidays + weekends, for the suggestion rules and the
 * calendar. Holidays use the standard federal observance shift: a
 * holiday falling on a Saturday is observed the Friday before, and
 * one falling on a Sunday the Monday after. Dates are plain local
 * YYYY-MM-DD strings, the same as the rest of the app.
 */

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): Date {
  // weekday: 0 = Sunday .. 6 = Saturday; n: 1-based occurrence.
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
): Date {
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month + 1, 0 - offset);
}

function observed(d: Date): Date {
  const day = d.getDay();
  if (day === 6) return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  if (day === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return d;
}

function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The federal holiday on this date, if any — else null. */
export function federalHoliday(iso: string): string | null {
  const y = parseInt(iso.slice(0, 4), 10);
  // Check the years around it: an observed holiday can land in the
  // prior year (e.g. New Year's Day on a Saturday is observed Dec 31).
  const holidays: Array<[string, Date]> = [];
  for (const year of [y - 1, y, y + 1]) {
    holidays.push(["New Year's Day", observed(new Date(year, 0, 1))]);
    holidays.push([
      "Martin Luther King Jr. Day",
      nthWeekdayOfMonth(year, 0, 1, 3),
    ]);
    holidays.push(["Presidents' Day", nthWeekdayOfMonth(year, 1, 1, 3)]);
    holidays.push(["Memorial Day", lastWeekdayOfMonth(year, 4, 1)]);
    holidays.push(["Juneteenth", observed(new Date(year, 5, 19))]);
    holidays.push(["Independence Day", observed(new Date(year, 6, 4))]);
    holidays.push(["Labor Day", nthWeekdayOfMonth(year, 8, 1, 1)]);
    holidays.push(["Columbus Day", nthWeekdayOfMonth(year, 9, 1, 2)]);
    holidays.push(["Veterans Day", observed(new Date(year, 10, 11))]);
    holidays.push(["Thanksgiving Day", nthWeekdayOfMonth(year, 10, 4, 4)]);
    holidays.push(["Christmas Day", observed(new Date(year, 11, 25))]);
  }
  const found = holidays.find(([, d]) => isoOf(d) === iso);
  return found ? found[0] : null;
}

/** Saturday or Sunday. */
export function isWeekend(iso: string): boolean {
  const d = new Date(
    parseInt(iso.slice(0, 4), 10),
    parseInt(iso.slice(5, 7), 10) - 1,
    parseInt(iso.slice(8, 10), 10),
  );
  const day = d.getDay();
  return day === 0 || day === 6;
}
