/**
 * Clock-in geofence.
 *
 * A crew member may clock in only when their phone is within
 * CLOCK_IN_RADIUS_MILES of one of the company's shop/yard spots
 * (the addresses the setup wizard asks for, stored on the company
 * profile), or of one of their job sites today that is not done, or
 * of the job they are clocking in to. Clock-out is
 * never restricted — anyone can clock out from anywhere, any time.
 *
 * The check runs in the browser (navigator.geolocation), so it works
 * in this static app with no backend: the phone's position is read at
 * the moment they tap Clock in, compared against the allowed spots,
 * and never stored or sent anywhere. A failed or denied location
 * read blocks clock-in with an explanation, it never silently
 * passes. If someone legitimately can't get a GPS lock, the office
 * can still add their hours with the manual entry on Timesheets.
 */
import { jobCoversDay, myStopOrder } from "./crewDay";
import { clockInSites } from "./company";
import { haversineMiles, type LatLng } from "./routing";
import { jobCoords } from "./scheduling";
import type { AppState, Job } from "./types";
import { todayStr } from "./utils";

/** Clock-in opens within this many miles of an allowed spot. */
export const CLOCK_IN_RADIUS_MILES = 0.25;

export interface ClockInPoint {
  label: string;
  coords: LatLng;
}

export type ClockInCheck =
  | { allowed: true; matchedLabel: string; distanceMiles: number }
  | {
      allowed: false;
      reason: "no-location" | "too-far" | "after-8pm";
      message: string;
      nearestMiles: number | null;
      nearestLabel: string | null;
    };

function getCurrentPosition(timeoutMs = 15000): Promise<GeolocationPosition> {
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

/**
 * The jobs whose sites open clock-in for this person today: the job
 * they tapped (Clock in here / Switch to this job, or the job picked
 * under "Clock in somewhere else"), and every job of theirs on today
 * that is not done (multi-day jobs count on every day they span), in
 * route order. Before audit 3 only the first unfinished stop counted,
 * so standing at stop 2 while stop 1 was still open was refused.
 */
export function clockInJobsToday(
  state: AppState,
  crewId: string,
  jobId: string | null = null,
  today: string = todayStr(),
): Job[] {
  const mine = myStopOrder(
    state.jobs.filter((j) => j.crewIds.includes(crewId) && j.status !== "done" && jobCoversDay(j, today)),
    crewId,
  );
  const tapped = jobId ? state.jobs.find((j) => j.id === jobId) : undefined;
  if (tapped && !mine.some((j) => j.id === tapped.id)) return [tapped, ...mine];
  if (tapped) return [tapped, ...mine.filter((j) => j.id !== tapped.id)];
  return mine;
}

/** Check whether this crew member may clock in right now, from here. */
export async function checkClockIn(
  state: AppState,
  crewId: string,
  jobId: string | null = null,
): Promise<ClockInCheck> {
  const points: ClockInPoint[] = clockInSites(state);
  const jobs = clockInJobsToday(state, crewId, jobId);
  const located: string[] = [];
  let tappedUnknown: Job | null = null;
  for (const j of jobs) {
    const coords = await jobCoords(state, j);
    if (coords) {
      points.push({ label: j.title, coords });
      located.push(j.title);
    } else if (jobId && j.id === jobId) {
      tappedUnknown = j;
    }
  }
  const shopNames = clockInSites(state).map((p) => p.label);
  const spots =
    [...shopNames, ...located].join(", ") || "a shop or yard address";
  const noPin = tappedUnknown
    ? ` Couldn't find ${tappedUnknown.title} on the map — ask the office to drop a pin on the job.`
    : "";

  let pos: GeolocationPosition;
  try {
    pos = await getCurrentPosition();
  } catch {
    return {
      allowed: false,
      reason: "no-location",
      message:
        `Couldn't get your location — clock-in needs location turned on to confirm you're at ${spots}.` +
        " Turn on location for this site and try again." +
        noPin,
      nearestMiles: null,
      nearestLabel: null,
    };
  }
  const here: LatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  let nearest: { label: string; miles: number } | null = null;
  for (const p of points) {
    const miles = haversineMiles(here, p.coords);
    if (!nearest || miles < nearest.miles) nearest = { label: p.label, miles };
  }
  if (nearest && nearest.miles <= CLOCK_IN_RADIUS_MILES) {
    return {
      allowed: true,
      matchedLabel: nearest.label,
      distanceMiles: nearest.miles,
    };
  }
  return {
    allowed: false,
    reason: "too-far",
    message:
      (nearest
        ? `You're ${nearest.miles.toFixed(1)} mi from the nearest clock-in spot (${nearest.label}). Clock-in opens within 0.25 mi of ${spots}.`
        : `Clock-in opens within 0.25 mi of ${spots}.`) + noPin,
    nearestMiles: nearest?.miles ?? null,
    nearestLabel: nearest?.label ?? null,
  };
}
