import type { AppState, AuditEntry, Job } from "./types";
import { entryJob } from "./activityVisibility";

/**
 * Who may open a job's full detail (the JobEditor drawer).
 *
 * Owners, office, and the estimator (app role office) may open any job, and a
 * crew member with the per-person seeAllJobs override granted may
 * too. Every other crew member may open only jobs they are assigned
 * to. This is the same rule Schedule's visibleJobs uses — it lives
 * here so the store's openJob gate, the per-customer job lists, the
 * per-customer activity logs, and the activity feed's tap-through
 * all enforce exactly the same thing.
 *
 * Note the deliberate split from the Activity feed filter: the feed
 * shows a crew member entries for weeks they work even when the
 * entry's job is not theirs (see activityVisibility.ts). Those
 * entries stay visible — they just must not open the job drawer.
 */
export function canOpenJob(
  state: AppState,
  jobId: string,
  viewerCrewId: string,
  canSeeAllJobs: boolean,
): boolean {
  if (canSeeAllJobs) return true;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return false;
  return job.crewIds.includes(viewerCrewId);
}

/** Jobs the viewer may open, newest first — the per-customer lists. */
export function visibleJobsForViewer(
  state: AppState,
  viewerCrewId: string,
  canSeeAllJobs: boolean,
): Job[] {
  if (canSeeAllJobs) return state.jobs;
  return state.jobs.filter((j) => j.crewIds.includes(viewerCrewId));
}

/**
 * Whether one audit entry may appear in a per-customer activity log
 * for this viewer. Entries about a job the viewer cannot open are
 * hidden; entries that name no job at all (customer edits, notes,
 * messages, an estimate with no job yet) stay — they reveal nothing
 * about another job. Estimate/invoice entries resolve to their job
 * through the record itself (entryJob), so an estimate linked to a
 * hidden job is hidden too.
 */
export function canSeeCustomerLogEntry(
  state: AppState,
  e: AuditEntry,
  viewerCrewId: string,
  canSeeAllJobs: boolean,
): boolean {
  if (canSeeAllJobs) return true;
  const job = entryJob(state, e);
  if (!job) return true;
  return job.crewIds.includes(viewerCrewId);
}
