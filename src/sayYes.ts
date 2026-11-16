import type { Estimate, Job } from "./types";
import { fmtDayShort } from "./scheduling";
import { plainTime } from "./auditText";

/**
 * "Customer said yes → Schedule job" on an estimate: which step to
 * show, which option to preselect, and the confirmation line.
 */
export type SayYesStep = "ask" | "schedule" | "booked" | "closed";

export function sayYesStep(est: Estimate, jobs: Pick<Job, "estimateId">[]): SayYesStep {
  if (est.status === "closed") return "closed";
  const hasJob = Boolean(est.jobId) || jobs.some((j) => j.estimateId === est.id);
  if (hasJob) return "booked";
  return est.status === "accepted" ? "schedule" : "ask";
}

/** The option to start with: the accepted one, or the only one. Null when the office must pick. */
export function defaultOptionId(est: Estimate): string | null {
  const opts = est.options ?? [];
  if (opts.length === 0) return null;
  if (est.acceptedOptionId && opts.some((o) => o.id === est.acceptedOptionId)) return est.acceptedOptionId;
  return opts.length === 1 ? opts[0].id : null;
}

/** Needs an option picked before "yes" can be recorded. */
export function needsOptionPick(est: Estimate, picked: string | null): boolean {
  return (est.options ?? []).length > 1 && !picked;
}

/** "Scheduled for Mon, Nov 16 at 7:00 AM". */
export function scheduledText(date: string, time: string): string {
  return `Scheduled for ${fmtDayShort(date)} at ${plainTime(time)}`;
}
