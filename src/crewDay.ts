import type { Job, TimesheetEntry } from "./types";
import { addDaysISO, entryHours, mondayOf } from "./utils";
import { autoClosesOn, CLOCK_DAY_END, clockNow, dayBefore, eightPmClockOut } from "./clockTime";

/**
 * True when a job is on the crew's day: multi-day jobs count on every
 * day from `date` to `endDate` (the same rule as the planner,
 * planner/input.ts jobActiveOn, and the clock-in geofence).
 */
export function jobCoversDay(job: Pick<Job, "date" | "endDate">, day: string): boolean {
  const end = job.endDate && job.endDate >= job.date ? job.endDate : job.date;
  return job.date <= day && day <= end;
}

/**
 * Crew phone helpers (Today screen, My hours, Timesheets). Pure, so the
 * rules are unit-tested and every part of the screen agrees.
 */

/** When this person gets to the job: their plan-board arrival, else the job's start. */
export function arrivalTime(job: Job, crewId: string): string {
  return job.crewArrivals?.[crewId] || job.startTime || "";
}

/**
 * One route order for a person's day: by when THEY get to each job
 * (plan-board arrival, else start time), then start time, then id. The
 * big Navigate button, the stop numbers and "you come here after …" all
 * use this order, so they never disagree.
 */
export function myStopOrder(jobs: Job[], crewId: string): Job[] {
  return [...jobs].sort(
    (a, b) =>
      arrivalTime(a, crewId).localeCompare(arrivalTime(b, crewId)) ||
      a.startTime.localeCompare(b.startTime) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The person's next stop (for "Navigate to my next job", the "Stop N"
 * line and the default clock-in job): the first of their stops, in
 * route order, that they have not finished. A stop is finished when it
 * is done, or, for someone who cannot mark it done (a groundsman), when
 * they clocked out of it today and are not clocked in there now, or a
 * later stop of theirs has already started.
 */
export function nextStopFor(
  stops: Job[],
  timesheets: TimesheetEntry[],
  crewId: string,
  today: string,
  canClose: (job: Job) => boolean,
): Job | null {
  const finished = (j: Job, i: number): boolean => {
    if (j.status === "done") return true;
    if (canClose(j)) return false;
    const mine = timesheets.filter((t) => t.crewId === crewId && t.date === today && t.jobId === j.id);
    if (mine.some((t) => t.clockIn && !t.clockOut)) return false;
    if (mine.some((t) => t.clockIn && t.clockOut)) return true;
    return j.status === "in_progress" && stops.slice(i + 1).some((k) => k.status !== "scheduled");
  };
  return stops.find((j, i) => !finished(j, i)) ?? null;
}

/** Times at which two or more of this person's stops start ("ask the office which first"). */
export function clashingTimes(ordered: Job[], crewId: string): string[] {
  const count = new Map<string, number>();
  for (const j of ordered) {
    const t = arrivalTime(j, crewId);
    if (!t) continue;
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()].filter(([, n]) => n > 1).map(([t]) => t).sort();
}

/** "07:00" -> "7:00 AM". */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Clock in, closing whatever this person still has open TODAY first
 * (at the same minute), so the same minutes are never paid twice. An
 * open entry from an earlier day ended at 8 PM on its own day (the 8 PM
 * rule, the "crew day and 8pm clockout" rules): it is closed at 20:00, marked
 * closed automatically, as the database does. Clocking in to the job
 * you are already clocked in to changes nothing.
 */
export function switchClock(
  timesheets: TimesheetEntry[],
  entry: TimesheetEntry,
): { timesheets: TimesheetEntry[]; closed: TimesheetEntry[]; unchanged: boolean } {
  const open = timesheets.filter(
    (t) =>
      t.crewId === entry.crewId &&
      t.date === entry.date &&
      t.clockIn !== null &&
      t.clockOut === null &&
      t.id !== entry.id,
  );
  if (open.some((t) => (t.jobId ?? null) === (entry.jobId ?? null))) {
    return { timesheets, closed: [], unchanged: true };
  }
  const at = entry.clockIn;
  const closing = open.filter((t) => at !== null && (t.clockIn ?? "") <= at);
  const closeIds = new Set(closing.map((t) => t.id));
  const earlier = timesheets.filter(
    (t) =>
      t.crewId === entry.crewId &&
      t.date < entry.date &&
      autoClosesOn(t.date, entry.date) &&
      t.clockIn !== null &&
      t.clockIn.slice(0, 5) < CLOCK_DAY_END &&
      t.clockOut === null &&
      t.id !== entry.id,
  );
  const earlierIds = new Set(earlier.map((t) => t.id));
  const next = timesheets.map((t) =>
    closeIds.has(t.id)
      ? { ...t, clockOut: at }
      : earlierIds.has(t.id)
        ? { ...t, clockOut: CLOCK_DAY_END, autoClosed: true }
        : t,
  );
  if (!next.some((t) => t.id === entry.id)) next.push(entry);
  return {
    timesheets: next,
    closed: [
      ...earlier.map((t) => ({ ...t, clockOut: CLOCK_DAY_END, autoClosed: true })),
      ...closing.map((t) => ({ ...t, clockOut: at })),
    ],
    unchanged: false,
  };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Entries that overlap another entry of the same person on the same day
 * (two open at once, or clock times that cross). Timesheets shows these
 * in red: the same minutes would be paid twice.
 */
export function overlappingEntryIds(entries: TimesheetEntry[]): Set<string> {
  const out = new Set<string>();
  const groups = new Map<string, TimesheetEntry[]>();
  for (const t of entries) {
    if (!t.clockIn) continue;
    const k = `${t.crewId}|${t.date}`;
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let k = i + 1; k < g.length; k++) {
        const a = g[i];
        const b = g[k];
        const aStart = minutes(a.clockIn as string);
        const bStart = minutes(b.clockIn as string);
        // A clock-out earlier than the clock-in ran past midnight.
        const end = (start: number, out: string | null) => {
          if (!out) return Infinity;
          const m = minutes(out);
          return m < start ? m + 1440 : m;
        };
        const aEnd = end(aStart, a.clockOut);
        const bEnd = end(bStart, b.clockOut);
        if (aStart < bEnd && bStart < aEnd) {
          out.add(a.id);
          out.add(b.id);
        }
      }
    }
  }
  return out;
}

/**
 * Hours for one entry. An open entry counts up to now, and never past
 * 8 PM on its own day (the 8 PM rule): an open entry from an earlier
 * day counts to 20:00, as the database closes it. An open entry older
 * than the automatic close (autoClosesOn) is left for the office: 0 h.
 */
export function liveEntryHours(t: TimesheetEntry, today: string, nowHHMM: string): number {
  if (
    t.clockIn &&
    t.clockOut === null &&
    t.clockIn.slice(0, 5) < CLOCK_DAY_END &&
    t.date <= today &&
    autoClosesOn(t.date, today)
  ) {
    const until = t.date < today || nowHHMM >= CLOCK_DAY_END ? CLOCK_DAY_END : nowHHMM;
    return Math.max(0, Math.round(((minutes(until) - minutes(t.clockIn)) / 60) * 100) / 100);
  }
  return entryHours(t);
}

/** liveEntryHours at this moment (Denver), for office screens. */
export function entryHoursNow(t: TimesheetEntry, now: Date = new Date()): number {
  const c = clockNow(now);
  return liveEntryHours(t, c.date, c.time);
}

/** This week (Monday–Sunday) for one person: entries newest first, and the total. */
export function myWeek(
  timesheets: TimesheetEntry[],
  crewId: string,
  today: string,
  nowHHMM: string,
): { monday: string; sunday: string; entries: TimesheetEntry[]; total: number } {
  const monday = mondayOf(today);
  const sunday = addDaysISO(monday, 6);
  const entries = timesheets
    .filter((t) => t.crewId === crewId && t.date >= monday && t.date <= sunday)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.clockIn ?? "").localeCompare(a.clockIn ?? ""));
  const total =
    Math.round(entries.reduce((s, t) => s + liveEntryHours(t, today, nowHHMM), 0) * 100) / 100;
  return { monday, sunday, entries, total };
}

/**
 * This person's open entries that are still running now (today's, not
 * yet ended by the 8 PM rule). Today offers Clock out for these.
 */
export function runningEntries(
  timesheets: TimesheetEntry[],
  crewId: string,
  now: Date = new Date(),
): TimesheetEntry[] {
  const today = clockNow(now).date;
  return timesheets.filter(
    (t) =>
      t.crewId === crewId &&
      t.date === today &&
      t.clockIn !== null &&
      t.clockOut === null &&
      eightPmClockOut(t, now) === null,
  );
}

/**
 * Entries of this person the 8 PM rule ended, for the line on Today
 * ("Your clock from Mon, Nov 16 was closed at 8 PM."): open ones it has
 * ended (the database closes them within the hour), and ones it closed
 * today or yesterday. Newest first.
 */
export function closedAt8Entries(
  timesheets: TimesheetEntry[],
  crewId: string,
  now: Date = new Date(),
): TimesheetEntry[] {
  const today = clockNow(now).date;
  const yesterday = dayBefore(today);
  return timesheets
    .filter(
      (t) =>
        t.crewId === crewId &&
        (eightPmClockOut(t, now) !== null || (t.autoClosed === true && t.date >= yesterday && t.date <= today)),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}
