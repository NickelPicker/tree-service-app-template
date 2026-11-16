/**
 * The "New job" form's starting values and checks. No React here, so
 * it is unit tested on its own.
 */
import type { ClosedDay, Job } from "./types";
import { addDaysISO } from "./utils";

function isSunday(iso: string): boolean {
  return new Date(`${iso}T12:00:00`).getDay() === 0;
}

/**
 * The first working day after `today`: Sundays and days marked
 * "Business closed" are skipped (the crew works Monday to Saturday,
 * the same rule as the Plan board's "Fill the next 6 days").
 */
export function nextWorkingDay(
  today: string,
  closedDays: readonly Pick<ClosedDay, "date">[] = [],
): string {
  let d = addDaysISO(today, 1);
  for (let i = 0; i < 60; i++) {
    if (!isSunday(d) && !closedDays.some((c) => c.date === d)) return d;
    d = addDaysISO(d, 1);
  }
  return addDaysISO(today, 1);
}

/**
 * The date a new job starts on: a day someone picked in the future
 * stays; today or a past day becomes the next working day (new jobs
 * are almost never for today, and today may be a Sunday).
 */
export function newJobDate(
  picked: string | null | undefined,
  today: string,
  closedDays: readonly Pick<ClosedDay, "date">[] = [],
): string {
  if (picked && picked > today) return picked;
  return nextWorkingDay(today, closedDays);
}

/** What a new job still needs before it can be saved, in plain words. */
export function newJobMissing(form: Pick<Job, "customerId" | "title">): string[] {
  const out: string[] = [];
  if (!form.customerId) out.push("pick a customer");
  if (!form.title.trim()) out.push("type a job title");
  return out;
}
