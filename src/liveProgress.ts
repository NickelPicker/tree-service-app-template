import type { Job, JobStatus, Role } from "./types";
import { isOwnerLike } from "./permissions";

/**
 * Live progress (day-plan part 3): the crew taps Arrived / Done on
 * each job, and the office sees where each crew is.
 *
 * A status tap is not a record edit — it is a crew member reporting
 * their own work, like clocking in. So anyone assigned to the job
 * may tap it, groundsmen included; owners and office may tap any
 * job. A crew member who is not on the job cannot change it, and a
 * job with no crew assigned can only be moved by owner/office.
 *
 * Status changes are audit-logged (setJobStatus in store.tsx) and
 * propagate live: jobs is in the "app-changes" realtime
 * subscription, so a tap on one phone shows on every signed-in
 * screen within about a second. Timesheets are untouched —
 * clock-in/out stays separate, and nothing auto-advances.
 */

/**
 * Pure transition: a new jobs array with one job's status changed.
 * No-op — returns the same array — when the job is missing or
 * already has that status. setJobStatus in the store uses this so
 * the no-op rule lives in one place.
 */
export function applyJobStatus(
  jobs: Job[],
  jobId: string,
  status: JobStatus,
): Job[] {
  const old = jobs.find((j) => j.id === jobId);
  if (!old || old.status === status) return jobs;
  return jobs.map((j) => (j.id === jobId ? { ...j, status } : j));
}

/**
 * May this viewer tap this job's status? Owners and office may tap
 * any job. Crew may tap only jobs they are assigned to — so a job
 * with no crew assigned can only be moved by owner/office.
 */
export function canTapJobStatus(
  job: Job,
  viewerId: string,
  role: Role,
): boolean {
  if (isOwnerLike(role) || role === "office") return true;
  return job.crewIds.includes(viewerId);
}

/**
 * May this viewer mark the job Done, or take Done off it? Owner
 * decision: anyone on the job (climbers and groundsmen),
 * the office and owners/managers. Groundsmen confirm with a second
 * tap (see doneNeedsConfirm). The database enforces the same rule
 * (limit_crew_job_edits, the "any crew marks done" rules).
 */
export function canMarkJobDone(
  job: Job,
  viewerId: string,
  role: Role,
): boolean {
  return canTapJobStatus(job, viewerId, role);
}

/**
 * Does Done need a second tap ("Yes, the job is finished") on a
 * separate spot of the screen? For crew who are not Climbers, so a
 * phone in a pocket cannot finish a job by itself. Climbers, the office
 * and owners mark Done with one tap (and all keep the Undo).
 */
export function doneNeedsConfirm(role: Role, jobRole: string | null | undefined): boolean {
  if (isOwnerLike(role) || role === "office") return false;
  return jobRole !== "Climber";
}

/**
 * Where a crew is, in plain words, from their jobs in start-time
 * order. Derived from job status only — never a guessed location.
 * - a job in progress → "On site at …"
 * - some done, a later one still scheduled → "Done at …, heading to …"
 * - all done → "All done for the day"
 * - none started → "Not started yet — first stop …"
 * No jobs → null (nothing to say).
 */
export function crewPositionText(jobs: Job[]): string | null {
  if (jobs.length === 0) return null;
  const ordered = [...jobs].sort(
    (a, b) =>
      a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id),
  );
  const onSite = ordered.find((j) => j.status === "in_progress");
  if (onSite) return `On site at ${onSite.title}`;
  const done = ordered.filter((j) => j.status === "done");
  const next = ordered.find((j) => j.status === "scheduled");
  if (done.length > 0 && next) {
    return `Done at ${done[done.length - 1].title}, heading to ${next.title}`;
  }
  if (done.length > 0) return "All done for the day";
  return `Not started yet — first stop ${ordered[0].startTime} · ${ordered[0].title}`;
}
