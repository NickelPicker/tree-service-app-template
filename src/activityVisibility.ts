import type { AppState, AuditEntry, Job } from "./types";
import { addDaysISO, mondayOf } from "./utils";

/**
 * Crew scoping for the global Activity feed (see Activity.tsx).
 *
 * A crew viewer (app role "crew") sees only two kinds of entries:
 *  (a) changes to a job they are assigned to, and
 *  (b) changes to a week in which they have at least one scheduled day.
 * Owners and office see everything, unchanged.
 *
 * Weeks are Monday–Sunday, via the existing mondayOf() helper — the
 * same week definition the rest of the app uses (Dashboard, Ask AI).
 *
 * Which date anchors an entry for rule (b):
 *  - When the entry is about a job, the JOB's date (a reschedule made
 *    today for next week's job is a change to next week, not this
 *    one — the entry timestamp would get that backwards). A
 *    multi-day job counts for every week it spans.
 *  - When the entry has no job at all (a settings change, a customer
 *    note, an estimate with no job yet), the entry's own timestamp
 *    date is the only anchor, so it counts for the week it happened
 *    in. Those entries are visible to a crew viewer only when they
 *    work at least one day that week.
 */
export function entryJob(state: AppState, e: AuditEntry): Job | null {
  const directId =
    e.jobId ?? (e.entity === "Job" ? e.entityId : null);
  if (directId) {
    const j = state.jobs.find((x) => x.id === directId);
    if (j) return j;
  }
  // Some estimate/invoice entries were recorded without jobId even
  // though the record itself is linked to a job — resolve through
  // the record so those entries still find their job.
  if (e.entity === "Estimate") {
    const est = state.estimates.find((x) => x.id === e.entityId);
    if (est?.jobId) {
      return state.jobs.find((x) => x.id === est.jobId) ?? null;
    }
  }
  if (e.entity === "Invoice") {
    const inv = state.invoices.find((x) => x.id === e.entityId);
    if (inv?.jobId) {
      return state.jobs.find((x) => x.id === inv.jobId) ?? null;
    }
  }
  return null;
}

/** Every Monday of the weeks a job spans (single-day jobs: one). */
export function jobWeekMondays(job: Job): string[] {
  const start = mondayOf(job.date);
  const end = mondayOf(job.endDate ?? job.date);
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDaysISO(cur, 7);
  }
  return out;
}

/** Mondays of every week the viewer has at least one scheduled day. */
export function viewerWorkWeekMondays(
  state: AppState,
  viewerCrewId: string,
): Set<string> {
  const weeks = new Set<string>();
  for (const j of state.jobs) {
    if (!j.crewIds.includes(viewerCrewId)) continue;
    for (const m of jobWeekMondays(j)) weeks.add(m);
  }
  return weeks;
}

/** Weeks an entry belongs to, for rule (b): its job's weeks, or the week it happened in when it has no job. */
export function entryWeekMondays(state: AppState, e: AuditEntry): string[] {
  const job = entryJob(state, e);
  if (job) return jobWeekMondays(job);
  return [mondayOf(e.timestamp.slice(0, 10))];
}

/** Whether one entry is visible to the viewer under the crew rule. */
export function canSeeActivityEntry(
  state: AppState,
  e: AuditEntry,
  viewerCrewId: string,
  workWeeks: Set<string>,
  isCrew: boolean,
): boolean {
  if (!isCrew) return true;
  const job = entryJob(state, e);
  // (a) A change to a job they are assigned to.
  if (job && job.crewIds.includes(viewerCrewId)) return true;
  // (b) A change to a week they have at least one scheduled day on.
  return entryWeekMondays(state, e).some((m) => workWeeks.has(m));
}

/** The feed as the viewer may see it: owners/office get everything, crew get rules (a) and (b) only. */
export function filterActivityForViewer(
  state: AppState,
  entries: AuditEntry[],
  viewerCrewId: string,
  isCrew: boolean,
): AuditEntry[] {
  if (!isCrew) return entries;
  const workWeeks = viewerWorkWeekMondays(state, viewerCrewId);
  return entries.filter((e) =>
    canSeeActivityEntry(state, e, viewerCrewId, workWeeks, true),
  );
}

/**
 * Jobs a crew viewer may see activity for — their own jobs plus jobs
 * in weeks they work at least one day. Used to scope the Job filter
 * dropdown on the Activity page so it does not list jobs the viewer
 * cannot see entries for. Non-crew viewers get every job.
 */
export function visibleActivityJobs(
  state: AppState,
  viewerCrewId: string,
  isCrew: boolean,
): Job[] {
  if (!isCrew) return state.jobs;
  const workWeeks = viewerWorkWeekMondays(state, viewerCrewId);
  return state.jobs.filter(
    (j) =>
      j.crewIds.includes(viewerCrewId) ||
      jobWeekMondays(j).some((m) => workWeeks.has(m)),
  );
}
