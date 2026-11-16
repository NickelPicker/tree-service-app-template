import type { Customer, Estimate, EstimateStatus, Job } from "./types";

/** "Needs attention" = work still open (drafts + sent, not accepted). */
export const NEEDS_ATTENTION_STATUSES: EstimateStatus[] = [
  "draft",
  "sent",
];
/** Finished: accepted (and booked) or closed. */
export const DONE_STATUSES: EstimateStatus[] = ["accepted", "closed"];

export function customerDisplayName(c: Customer | undefined): string {
  return c ? `${c.firstName} ${c.lastName}` : "Unknown";
}

/**
 * The Estimates tab's list logic: status pills filter the whole list
 * first, the search box filters by customer name or title, and the
 * survivors split into three groups, newest first within each:
 * - needsAttention: drafts and sent quotes,
 * - toSchedule: accepted, but no job yet ("Accepted — waiting to
 *   schedule"; accepted work is not "done"),
 * - finished: accepted with a job booked, or closed.
 * Without `jobs`, every accepted estimate counts as waiting to schedule
 * unless it carries a jobId.
 */
export function filterEstimates(
  estimates: Estimate[],
  customers: Customer[],
  statusFilter: string,
  search: string,
  jobs: Pick<Job, "estimateId">[] = [],
): { needsAttention: Estimate[]; toSchedule: Estimate[]; finished: Estimate[] } {
  const q = search.trim().toLowerCase();
  const nameById = new Map(
    customers.map((c) => [c.id, customerDisplayName(c)]),
  );
  const booked = new Set(jobs.map((j) => j.estimateId).filter(Boolean));
  const filtered = estimates
    .filter((e) => statusFilter === "all" || e.status === statusFilter)
    .filter(
      (e) =>
        q === "" ||
        (nameById.get(e.customerId) ?? "Unknown")
          .toLowerCase()
          .includes(q) ||
        e.title.toLowerCase().includes(q),
    )
    .sort((a, b) => b.createdDate.localeCompare(a.createdDate));
  const hasJob = (e: Estimate) => booked.has(e.id) || Boolean(e.jobId);
  return {
    needsAttention: filtered.filter((e) =>
      NEEDS_ATTENTION_STATUSES.includes(e.status),
    ),
    toSchedule: filtered.filter((e) => e.status === "accepted" && !hasJob(e)),
    finished: filtered.filter(
      (e) => e.status === "closed" || (e.status === "accepted" && hasJob(e)),
    ),
  };
}

/**
 * The estimates this person wrote (estimates.created_by_crew_id, set by
 * the database since the "sales access refine" rules). Estimates from before
 * that have no author and are never "mine". No card id = none.
 */
export function writtenBy(estimates: Estimate[], crewId: string | null | undefined): Estimate[] {
  if (!crewId) return [];
  return estimates.filter((e) => e.createdByCrewId === crewId);
}
