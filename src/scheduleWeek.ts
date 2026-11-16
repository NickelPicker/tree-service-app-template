/**
 * The Schedule's "This week" list (the default view on phones) and
 * which view to start in. No React, so it is unit tested.
 */
import { addDaysISO } from "./utils";

/**
 * Sunday to Saturday of the week the date falls in (ISO yyyy-mm-dd),
 * the same weeks as the month grid's rows.
 */
export function weekOf(date: string): string[] {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const sunday = addDaysISO(date, -dow);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(sunday, i));
}

/** "Mon Nov 16 – Sun Nov 22". */
export function weekLabel(days: string[]): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  return days.length ? `${f(days[0])} – ${f(days[days.length - 1])}` : "";
}

export type CalendarView = "month" | "week";

/** Phones start on the week list; bigger screens on the month grid. */
export function defaultCalendarView(viewportWidth: number): CalendarView {
  return viewportWidth < 640 ? "week" : "month";
}
