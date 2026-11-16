import { jobValue } from "./jobValue";
import type { AppState, Job } from "./types";

/**
 * Upcoming jobs (today or later, not done) with no dollar value from
 * any source: no invoice, no estimate, no hourly price, no value typed
 * on the job. The Plan board works out how long a job takes from its
 * value ($400 = 1 hour), so these need a number. Soonest first.
 */
export function jobsWithoutValue(state: AppState, today: string): Job[] {
  return state.jobs
    .filter((j) => j.status !== "done" && !!j.date && j.date >= today)
    .filter((j) => (jobValue(state, j) ?? 0) <= 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
