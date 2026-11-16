/**
 * On-demand crew location ("Where is my crew").
 *
 * The static app has NO push server, so a ping CANNOT wake a closed
 * phone or track anyone in the background. What happens instead:
 * the office taps Ping, a request row is stored in the DB, and the
 * crew member answers by opening the app (or having it open — the
 * realtime reload shows the banner) and tapping Share. One tap = one
 * location point + time, read at that moment from the phone, never
 * stored before and never tracked continuously. A denied or failed
 * location read shows a message and writes nothing.
 */
import type { AppState, CrewLocation, Job, LocationRequest } from "./types";
import { todayStr } from "./utils";

/** Read the phone's position once, at tap time (same options as the clock-in geofence). */
export function readCurrentPosition(
  timeoutMs = 15000,
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("geolocation-unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 60000,
    });
  });
}

/** The newest location a person has shared, or null when never. */
export function lastLocationFor(
  state: AppState,
  crewId: string,
): CrewLocation | null {
  const mine = (state.crewLocations ?? []).filter((l) => l.crewId === crewId);
  if (mine.length === 0) return null;
  return mine.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
}

/**
 * Requests still open for this person: targeting them (or everyone)
 * and asked after their last share. Sharing once answers every open
 * request — the next ping starts a fresh one.
 */
export function openRequestsFor(
  state: AppState,
  crewId: string,
): LocationRequest[] {
  const last = lastLocationFor(state, crewId);
  return (state.locationRequests ?? []).filter(
    (r) =>
      (r.targetCrewId === null || r.targetCrewId === crewId) &&
      (!last || r.requestedAt > last.recordedAt),
  );
}

/** Whole minutes since an ISO timestamp. */
export function minutesAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 60000));
}

/** "just now" / "12 min ago" / "2 hr ago" for a shared point. */
export function formatAge(iso: string): string {
  const m = minutesAgo(iso);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} hr${h === 1 ? "" : "s"} ago`;
}

/**
 * What job a person is on right now, for the "On site at" line: the
 * in-progress job they are on today, else their next scheduled job
 * today, else null. Never a guessed location — the job comes from
 * the schedule, the pin comes from their share.
 */
export function currentJobFor(
  state: AppState,
  crewId: string,
  date: string,
): Job | null {
  const todays = state.jobs
    .filter((j) => j.date === date && j.crewIds.includes(crewId))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  return (
    todays.find((j) => j.status === "in_progress") ??
    todays.find((j) => j.status === "scheduled") ??
    null
  );
}

/** Today's date as YYYY-MM-DD, for callers that need "today". */
export function todayISO(): string {
  return todayStr();
}
