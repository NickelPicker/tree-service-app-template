import type { Job, TimesheetEntry } from "./types";
import { clock12 } from "./crewDay";

/**
 * Plain-words helpers for the crew's day (review, #12, #13 and
 * the "clock out now" quick win). Pure functions, tested in
 * src/__tests__/fieldDay.test.ts.
 */

/**
 * When to be at a job, for one person. The job's saved start time is the
 * time; a personal arrival from the Plan board (crewArrivals) that differs
 * from it is labelled as theirs: "You arrive ~3:17 PM" with "job starts
 * 7:00 AM" beside it, so two people on the same job never see two
 * unexplained times.
 */
export function arrivalLabel(job: Job, crewId: string): { main: string; sub: string | null } {
  const start = job.startTime || "";
  const mine = job.crewArrivals?.[crewId] || "";
  if (mine && mine !== start) {
    return {
      main: `You arrive ~${clock12(mine)}`,
      sub: start ? `job starts ${clock12(start)}` : null,
    };
  }
  return { main: start ? clock12(start) : "No time set", sub: null };
}

/**
 * The address line on a job sheet or card. A job with a map pin but no
 * street address can still be reached with Navigate: say so instead of
 * sending the crew to the office.
 */
export function whereLine(address: string | null | undefined, job: Pick<Job, "lat" | "lng">): string {
  if (address && address.trim()) return address;
  if (job.lat != null && job.lng != null) return "Dropped pin — tap Navigate";
  return "No address — ask the office";
}

/**
 * True when every one of this person's jobs today is Done and they are
 * still clocked in: time for "That was the last job. Clock out now".
 */
export function shouldOfferClockOut(myJobsToday: Job[], openEntry: TimesheetEntry | null): boolean {
  if (!openEntry || myJobsToday.length === 0) return false;
  return myJobsToday.every((j) => j.status === "done");
}

/** "HH:MM" -> minutes after midnight, or null. */
function toMin(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Plan board: the saved start time next to the board's suggested time,
 * when they differ ("Saved start 2:05 PM: the board suggests 7:00 AM.
 * Save day to use it."). Null when they agree or there is nothing to say.
 */
export function planTimeNote(savedStart: string | null | undefined, boardStartMin: number | null | undefined): string | null {
  const saved = toMin(savedStart);
  if (saved === null || boardStartMin == null) return null;
  if (saved === boardStartMin) return null;
  const hh = String(Math.floor(boardStartMin / 60)).padStart(2, "0");
  const mm = String(boardStartMin % 60).padStart(2, "0");
  return `Saved start ${clock12(savedStart as string)}: the board suggests ${clock12(`${hh}:${mm}`)}. Save day to use it.`;
}
