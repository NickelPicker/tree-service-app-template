/**
 * Suggested days for approved estimates.
 *
 * When a proposal is accepted, its job lands on today by default. This
 * engine finds a better day under the owner's suggestion rules
 * (Calendar settings): the nearest job that day must be within
 * suggestMaxMinutes' drive and suggestMaxMiles road miles, and the
 * day's booked total plus this job may exceed the daily target by at
 * most suggestMaxOver.
 *
 * Proximity uses real coordinates — the job's dropped pin, else the
 * customer's address geocoded via Nominatim (cached). Drive time and
 * road miles come from OSRM for the nearest job that day; when the
 * location is unknown, the suggestion ranks by room under the target
 * only and says so in the reason.
 */
import { jobCoversDay, myStopOrder } from "./crewDay";
import {
  formatMiles,
  formatMinutes,
  geocodeAddress,
  haversineMiles,
  resolveJobCoords,
  routeLeg,
  type LatLng,
} from "./routing";
import { federalHoliday, isWeekend } from "./holidays";
import { jobValue } from "./jobValue";
import { isVisitOn } from "./salesCalendar";
import type { AppState, Customer, Job } from "./types";
import {
  addressLine,
  jobCustomerAddress,
  primaryAddress,
} from "./addresses";
import { addDaysISO, money, todayStr } from "./utils";

/** How far ahead to look for a day. */
const DAYS_AHEAD = 14;

export interface SuggestedDay {
  date: string;
  dayTotal: number;
  room: number;
  fits: boolean;
  priceFits: boolean;
  locationFits: boolean;
  nearbyJobs: number;
  nearestMiles: number | null;
  nearestMinutes: number | null;
  reason: string;
}

/**
 * Clock-in autopopulation: the first job a crew member is assigned
 * to on a day (earliest start), or null when they have no assigned
 * job that day. Clocking in defaults to this job — there is no
 * picker of every location any more.
 */
export function firstAssignedJobToday(
  state: AppState,
  crewId: string,
  date: string = todayStr(),
): Job | null {
  // The same route order as the crew screen (their plan-board arrival).
  const mine = myStopOrder(
    state.jobs.filter((j) => jobCoversDay(j, date) && j.crewIds.includes(crewId)),
    crewId,
  );
  return mine[0] ?? null;
}

/**
 * Every job on a day, earliest first — the clock-in Change list. All
 * of the day's jobs, not just the viewer's own: a crew member may be
 * covering a job they were not assigned to. A multi-day job counts on
 * every day it spans (jobCoversDay).
 */
export function jobsOnDay(
  state: AppState,
  date: string = todayStr(),
): Job[] {
  return state.jobs
    .filter((j) => jobCoversDay(j, date))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export function fmtDayShort(iso: string): string {
  const d = new Date(
    parseInt(iso.slice(0, 4), 10),
    parseInt(iso.slice(5, 7), 10) - 1,
    parseInt(iso.slice(8, 10), 10),
  );
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function dayTotal(state: AppState, date: string, excludeJobId?: string | null): number {
  return state.jobs
    .filter((j) => j.date === date && j.id !== excludeJobId)
    .reduce((s, j) => s + (jobValue(state, j) ?? 0), 0);
}

/** The address a job routes to: the address picked for the job, else the commercial job-site address, else the customer's primary address. Null when there is no street address, so a bare "city, ZIP" never pins a stop in the wrong place. */
export function jobAddress(state: AppState, j: Job): string | null {
  const c = state.customers.find((x) => x.id === j.customerId);
  if (!c) return null;
  const chosen = jobCustomerAddress(c, j.addressId);
  if (chosen) {
    return chosen.street.trim() !== "" ? addressLine(chosen) : null;
  }
  if (c.type === "commercial" && c.jobSiteAddress) return c.jobSiteAddress;
  const primary = primaryAddress(c);
  if (!primary || primary.street.trim() === "") return null;
  return addressLine(primary);
}

/** Coordinates for a job: its pin, else its geocoded address. Null when neither exists. */
export async function jobCoords(state: AppState, j: Job): Promise<LatLng | null> {
  return resolveJobCoords(j, jobAddress(state, j));
}

/** Coordinates for a not-yet-created job: the customer's map location, else their geocoded primary address. */
export async function customerCoords(c: Customer | null | undefined): Promise<LatLng | null> {
  if (!c) return null;
  if (c.mapLat !== null && c.mapLng !== null) {
    return { lat: c.mapLat, lng: c.mapLng };
  }
  const primary = primaryAddress(c);
  const addr = primary ? addressLine(primary) : "";
  if (!addr) return null;
  return geocodeAddress(addr);
}

export async function suggestDay(
  state: AppState,
  value: number,
  coords: LatLng | null,
  excludeJobId?: string | null,
): Promise<SuggestedDay | null> {
  const today = todayStr();
  const dailyTarget = state.settings.dailyTarget ?? 0;
  // Suggestion rules from Calendar settings (0 minutes / 0 miles = no
  // limit on that one; 0 over = the daily target is a hard cap).
  const maxMinutes = state.settings.suggestMaxMinutes ?? 30;
  const maxMiles = state.settings.suggestMaxMiles ?? 5;
  const maxOver = state.settings.suggestMaxOver ?? 0;
  const skipWeekends = state.settings.suggestSkipWeekends ?? true;
  const skipHolidays = state.settings.suggestSkipHolidays ?? true;
  const candidates: SuggestedDay[] = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const date = addDaysISO(today, i);
    // Closed days are never suggested — the business is not booking.
    if (state.closedDays.some((d) => d.date === date)) continue;
    // Weekends and federal holidays are never suggested either, when
    // those rules are on (both default on).
    if (skipWeekends && isWeekend(date)) continue;
    if (skipHolidays && federalHoliday(date) !== null) continue;
    const total = dayTotal(state, date, excludeJobId);
    const room = dailyTarget > 0 ? dailyTarget - total : Number.POSITIVE_INFINITY;
    // Price rule: booked total + this job may exceed the daily target
    // by at most maxOver. No target set = no price rule.
    const priceFits =
      dailyTarget <= 0 || total + value <= dailyTarget + maxOver;
    let nearby = 0;
    let nearestMiles: number | null = null;
    let nearestMinutes: number | null = null;
    let nearestRoadMiles: number | null = null;
    // Location rule: the nearest job that day must be within maxMinutes'
    // drive and maxMiles road miles. A day with no other jobs, or an
    // unknown location, can't be ruled out — it passes and ranks last.
    let locationFits = true;
    if (coords) {
      const jobs = state.jobs.filter(
        (j) => j.date === date && j.id !== excludeJobId,
      );
      let bestHav: { c: LatLng; miles: number } | null = null;
      for (const j of jobs) {
        const c = await jobCoords(state, j);
        if (!c) continue;
        const miles = haversineMiles(coords, c);
        if (maxMiles <= 0 || miles <= maxMiles) nearby++;
        if (!bestHav || miles < bestHav.miles) bestHav = { c, miles };
      }
      if (bestHav) {
        nearestMiles = bestHav.miles;
        // Straight-line miles never exceed road miles, so a nearest job
        // already farther than the limit as the crow flies fails the
        // location rule without a routing call.
        if (maxMiles > 0 && bestHav.miles > maxMiles) {
          locationFits = false;
        } else {
          const leg = await routeLeg(coords, bestHav.c);
          if (leg.status === "unknown") {
            // Routing failed entirely — judge the day on the
            // straight-line distance only and skip the drive-time check.
            nearestMinutes = null;
          } else {
            nearestRoadMiles = leg.miles;
            nearestMinutes = leg.minutes;
            if (maxMiles > 0 && leg.miles > maxMiles) locationFits = false;
            if (maxMinutes > 0 && leg.minutes > maxMinutes)
              locationFits = false;
          }
        }
      }
    }
    const fits = priceFits && locationFits;
    const targetPart =
      dailyTarget > 0
        ? `${money(total)} booked (target ${money(dailyTarget)})`
        : `${money(total)} booked`;
    const nearPart =
      coords === null
        ? "location unknown"
        : nearestMinutes !== null
          ? `nearest job ${formatMinutes(nearestMinutes)} · ${formatMiles(nearestRoadMiles ?? nearestMiles ?? 0)} away`
          : nearestMiles !== null
            ? `nearest job ${nearestMiles.toFixed(1)} mi away (straight-line)`
            : "no other jobs that day";
    candidates.push({
      date,
      dayTotal: total,
      room,
      fits,
      priceFits,
      locationFits,
      nearbyJobs: nearby,
      nearestMiles,
      nearestMinutes,
      reason: `${fmtDayShort(date)} · ${targetPart} · ${nearPart}`,
    });
  }
  const fitting = candidates.filter((c) => c.fits);
  const pool = fitting.length > 0 ? fitting : candidates;
  pool.sort(
    (a, b) =>
      b.nearbyJobs - a.nearbyJobs ||
      (a.nearestMiles ?? Infinity) - (b.nearestMiles ?? Infinity) ||
      b.room - a.room ||
      a.date.localeCompare(b.date),
  );
  const best = pool[0] ?? null;
  if (!best) return null;
  if (fitting.length === 0) {
    const anyPrice = candidates.some((c) => c.priceFits);
    const anyLocation = candidates.some((c) => c.locationFits);
    if (dailyTarget > 0 && !anyPrice) {
      best.reason = `No day under the ${money(dailyTarget)} target (+${money(maxOver)} allowed) in the next 2 weeks — least full is ${best.reason}`;
    } else if (!anyLocation) {
      best.reason = `No day within ${maxMinutes > 0 ? formatMinutes(maxMinutes) : "any drive time"} / ${maxMiles > 0 ? formatMiles(maxMiles) : "any distance"} of other jobs in the next 2 weeks — closest is ${best.reason}`;
    } else {
      best.reason = `No day fits your suggestion rules in the next 2 weeks — least full is ${best.reason}`;
    }
  }
  return best;
}

/**
 * Suggested TIMES for the estimator's estimate visits (Sales tab).
 *
 * The pace the owner gave: estimates take 15–45 minutes, 2 per hour
 * including drive time — so visits book in 30-minute slots, on the
 * hour and half hour. A visit occupies one slot; the drive from the
 * previous visit (and to the next one) must fit in the time between
 * the two visits' starts, less a 15-minute minimum for the visit
 * itself (the low end of the 15–45 range — a working assumption, not
 * a measured number). A slot with an unknown location on either end
 * skips the drive check and follows the plain slot rule.
 *
 * Working-day window: 8:00 AM–5:00 PM. That window is a GUESS the
 * owner can correct — it lives in the two constants below, in one
 * place.
 */

/** Estimate visits run 8:00 AM–5:00 PM (owner-correctable guess). */
export const ESTIMATE_VISIT_START_HOUR = 8;
export const ESTIMATE_VISIT_END_HOUR = 17;
/** One visit per 30-minute slot: 2 per hour including drive time. */
export const ESTIMATE_VISIT_SLOT_MINUTES = 30;
/** Shortest an estimate visit runs (low end of the 15–45 min range). */
const MIN_VISIT_MINUTES = 15;

/** Every half-hour start a visit can have: "08:00" … "16:30". */
export function visitSlotOptions(): string[] {
  const out: string[] = [];
  for (
    let t = ESTIMATE_VISIT_START_HOUR * 60;
    t + ESTIMATE_VISIT_SLOT_MINUTES <= ESTIMATE_VISIT_END_HOUR * 60;
    t += ESTIMATE_VISIT_SLOT_MINUTES
  ) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  }
  return out;
}

/** "09:30" -> "9:30 AM". */
export function formatVisitTime(hhmm: string): string {
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(3, 5);
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${m} ${ampm}`;
}

function minutesOf(hhmm: string): number {
  return (
    parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10)
  );
}

function slotOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Pure drive-gap check, so the slot rule is unit-testable: a drive
 * leg fits when the time between the two visits' starts, less the
 * minimum visit length, covers it. An unknown leg (no location on
 * either end) never blocks a slot — the plain slot rule decides.
 */
export function driveFits(
  startGapMinutes: number,
  driveMinutes: number | null,
): boolean {
  if (driveMinutes === null) return true;
  return driveMinutes <= startGapMinutes - MIN_VISIT_MINUTES;
}

export interface SuggestedVisitTime {
  /** "HH:MM" on the half hour. */
  time: string;
  reason: string;
  /** Drive minutes on the binding leg, or null when no leg applied. */
  driveMinutes: number | null;
}

export interface ManualVisitCheck {
  /** Another draft visit already occupies this exact day + time. */
  taken: boolean;
  /** Amber warnings — never block the save; the estimator is choosing this
      deliberately for a customer request. */
  warnings: string[];
}

/**
 * Check a MANUALLY picked day + time for an estimate visit.
 * Same slot rule as the suggester (one visit per half-hour slot,
 * crew jobs never block), plus warnings for weekend / holiday /
 * closed days and for a drive that doesn't fit the gap to the
 * neighbouring visits that day. A past date warns too (the date
 * input's min is the first line of defence; this is the second).
 * `excludeEstimateId` is the visit being moved, so its own current
 * slot never counts as taken.
 */
export async function checkManualVisitSlot(
  state: AppState,
  date: string,
  time: string,
  coords: LatLng | null,
  excludeEstimateId?: string | null,
): Promise<ManualVisitCheck> {
  const warnings: string[] = [];
  const visits = state.estimates
    .filter(
      (e) => isVisitOn(e, date) && e.id !== excludeEstimateId,
    )
    .sort((a, b) => (a.visitTime ?? "").localeCompare(b.visitTime ?? ""));
  const taken = visits.some((v) => v.visitTime === time);

  if (date < todayStr()) {
    warnings.push("That day is in the past.");
  }
  if (isWeekend(date)) {
    warnings.push("That's a weekend — the estimator doesn't usually run estimate visits then.");
  }
  const holiday = federalHoliday(date);
  if (holiday !== null) {
    warnings.push(`That's ${holiday} — a federal holiday.`);
  }
  if (state.closedDays.some((d) => d.date === date)) {
    warnings.push("The business is marked closed that day.");
  }

  // Drive-gap warnings against the neighbouring visits that day,
  // same rule as the suggester: the drive must fit in the gap
  // between the two visits' starts, less the 15-minute minimum.
  if (coords) {
    const placed: Array<{ time: string; coords: LatLng | null }> = [];
    for (const v of visits) {
      const cust = state.customers.find((c) => c.id === v.customerId);
      placed.push({
        time: v.visitTime as string,
        coords: await customerCoords(cust),
      });
    }
    const t = minutesOf(time);
    const prev = [...placed].filter((p) => minutesOf(p.time) < t).pop();
    const next = placed.find((p) => minutesOf(p.time) > t);
    if (prev?.coords) {
      const leg = await routeLeg(prev.coords, coords);
      const drive = leg.status === "unknown" ? null : leg.minutes;
      if (!driveFits(t - minutesOf(prev.time), drive)) {
        warnings.push(
          `Tight drive from the ${formatVisitTime(prev.time)} visit — about ${drive !== null ? formatMinutes(drive) : "unknown time"} on the road for a ${t - minutesOf(prev.time)}-minute gap.`,
        );
      }
    }
    if (next?.coords) {
      const leg = await routeLeg(coords, next.coords);
      const drive = leg.status === "unknown" ? null : leg.minutes;
      if (!driveFits(minutesOf(next.time) - t, drive)) {
        warnings.push(
          `Tight drive to the ${formatVisitTime(next.time)} visit — about ${drive !== null ? formatMinutes(drive) : "unknown time"} on the road for a ${minutesOf(next.time) - t}-minute gap.`,
        );
      }
    }
  }
  return { taken, warnings };
}

/**
 * Earliest free half-hour slot for a new estimate visit on `date`.
 * `coords` is the new visit's location (null = unknown: plain slot
 * rule, no drive checks). Only the estimator's own visits block slots — crew
 * jobs are a separate calendar and never block an estimate visit.
 * Returns null when the day is full (every slot taken or
 * drive-blocked). routeLeg never throws: an unreachable OSRM falls
 * back to a straight-line drive estimate, so the only fallback here
 * is an unknown location.
 */
export async function suggestEstimateTime(
  state: AppState,
  date: string,
  coords: LatLng | null,
): Promise<SuggestedVisitTime | null> {
  const visits = state.estimates
    .filter(
      (e) => isVisitOn(e, date),
    )
    .sort((a, b) => (a.visitTime ?? "").localeCompare(b.visitTime ?? ""));
  const placed: Array<{ time: string; coords: LatLng | null }> = [];
  for (const v of visits) {
    const cust = state.customers.find((c) => c.id === v.customerId);
    placed.push({
      time: v.visitTime as string,
      coords: await customerCoords(cust),
    });
  }
  const start = ESTIMATE_VISIT_START_HOUR * 60;
  const end = ESTIMATE_VISIT_END_HOUR * 60;
  for (
    let t = start;
    t + ESTIMATE_VISIT_SLOT_MINUTES <= end;
    t += ESTIMATE_VISIT_SLOT_MINUTES
  ) {
    const time = slotOf(t);
    if (placed.some((p) => p.time === time)) continue;
    const prev = [...placed].filter((p) => minutesOf(p.time) < t).pop();
    const next = placed.find((p) => minutesOf(p.time) > t);
    let driveMinutes: number | null = null;
    let ok = true;
    if (coords && prev?.coords) {
      const leg = await routeLeg(prev.coords, coords);
      // routeLeg never throws, but its type allows an "unknown" leg
      // (no minutes at all) — an unknown leg never blocks a slot.
      driveMinutes = leg.status === "unknown" ? null : leg.minutes;
      if (!driveFits(t - minutesOf(prev.time), driveMinutes)) ok = false;
    }
    if (ok && coords && next?.coords) {
      const leg = await routeLeg(coords, next.coords);
      const nextDrive = leg.status === "unknown" ? null : leg.minutes;
      if (!driveFits(minutesOf(next.time) - t, nextDrive)) ok = false;
      else if (driveMinutes === null) driveMinutes = nextDrive;
    }
    if (!ok) continue;
    const prevPart = prev
      ? `after the ${formatVisitTime(prev.time)} visit`
      : "first visit of the day";
    const drivePart =
      driveMinutes !== null
        ? ` · ${formatMinutes(driveMinutes)} drive`
        : coords
          ? ""
          : " · drive unknown, plain slot rule";
    return {
      time,
      reason: `${formatVisitTime(time)} — first free half-hour slot, ${prevPart}${drivePart}`,
      driveMinutes,
    };
  }
  return null;
}

/** Minutes after midnight for "H:MM"/"HH:MM", or null. */
function clockMinutes(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((t ?? "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * When work on a job starts that day: the earliest planned crew arrival
 * (Plan board), else its start time. Null when it has neither.
 */
export function jobStartMinutes(j: Pick<Job, "startTime" | "crewArrivals">): number | null {
  const arrivals = Object.values(j.crewArrivals ?? {})
    .map(clockMinutes)
    .filter((x): x is number => x != null);
  if (arrivals.length > 0) return Math.min(...arrivals);
  return clockMinutes(j.startTime);
}

/**
 * Work order for lists of a day's jobs (business rule): the job the
 * crew does first is on top. Earliest start first; jobs with no time
 * last; ties keep a steady order by title. Value never decides.
 */
export function compareByWorkOrder(
  a: Pick<Job, "startTime" | "crewArrivals" | "title" | "id">,
  b: Pick<Job, "startTime" | "crewArrivals" | "title" | "id">,
): number {
  const x = jobStartMinutes(a);
  const y = jobStartMinutes(b);
  if (x !== y) return (x ?? 24 * 60) - (y ?? 24 * 60);
  return (a.title ?? "").localeCompare(b.title ?? "") || a.id.localeCompare(b.id);
}
