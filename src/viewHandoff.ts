/**
 * A button on one screen (the Dashboard To-do) can ask the next screen
 * to open in a certain place: Timesheets on a given week, Sales with the
 * Booking requests section open. The screen reads it when it mounts.
 *
 * It is read, not taken, so React's double mount in development still
 * sees it, and it lapses after a few seconds so a later visit opens as
 * usual.
 */
const LAPSE_MS = 5000;

interface Handoff {
  timesheetsWeek?: string;
  salesBookings?: boolean;
  at: number;
}

let pending: Handoff | null = null;

export function openTimesheetsOnWeek(monday: string, now = Date.now()): void {
  pending = { timesheetsWeek: monday, at: now };
}

export function openSalesBookings(now = Date.now()): void {
  pending = { salesBookings: true, at: now };
}

function fresh(now: number): Handoff | null {
  return pending && now - pending.at <= LAPSE_MS ? pending : null;
}

/** The week Timesheets should open on, or null for the current week. */
export function handedTimesheetsWeek(now = Date.now()): string | null {
  return fresh(now)?.timesheetsWeek ?? null;
}

/** True when Sales should open with Booking requests open. */
export function handedSalesBookings(now = Date.now()): boolean {
  return fresh(now)?.salesBookings === true;
}

export function clearHandoff(): void {
  pending = null;
}
