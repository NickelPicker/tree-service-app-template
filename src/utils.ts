import type { ClosedDay, Customer, TimeOffRequest } from "./types";

/**
 * A customer with no name at all — no first name, last name, company, or
 * company name. These come from the Breezeworks import (rows that were
 * just an email, or just an address). They stay in the database and are
 * findable by search (email / phone / address), but they never appear in
 * browse lists, so they don't crowd the A–Z list.
 */
export function isBlankCustomer(c: Customer): boolean {
  return (
    !(c.firstName || "").trim() &&
    !(c.lastName || "").trim() &&
    !(c.company || "").trim() &&
    !(c.companyName || "").trim()
  );
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Local date as YYYY-MM-DD (no UTC shift). */
export function todayStr(): string {
  const d = new Date();
  return toISODate(d);
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/**
 * The next business day after a date: tomorrow, skipping Saturday
 * and Sunday. A Friday job's next business day is Monday; a Saturday
 * job's is Monday too. Used by the "Still to invoice" overdue rule.
 */
export function nextBusinessDay(iso: string): string {
  let next = addDaysISO(iso, 1);
  while (true) {
    const d = new Date(next + "T12:00:00");
    const w = d.getDay();
    if (w !== 0 && w !== 6) return next;
    next = addDaysISO(next, 1);
  }
}

/** Payment terms in days as the words on an invoice: 0 = due on receipt. */
export function termsLabel(days: number): string {
  return days <= 0 ? "Due on receipt" : `Net ${days}`;
}

/** Whole days between two YYYY-MM-DD dates (to − from). */
export function daysBetweenISO(from: string, to: string): number {
  const ms = parseISO(to).getTime() - parseISO(from).getTime();
  return Math.round(ms / 86400000);
}

/** True when an approved time-off request covers this person on this day. */
export function isTimeOffOn(
  requests: TimeOffRequest[],
  crewId: string,
  date: string,
): boolean {
  return requests.some(
    (r) =>
      r.crewId === crewId &&
      r.status === "approved" &&
      r.startDate <= date &&
      date <= r.endDate,
  );
}

/** True when the business is closed to bookings on this day. */
export function isClosedDay(closedDays: ClosedDay[], date: string): boolean {
  return closedDays.some((d) => d.date === date);
}

/** Approved time-off requests covering a person on a day (usually 0 or 1). */
export function timeOffOn(
  requests: TimeOffRequest[],
  crewId: string,
  date: string,
): TimeOffRequest[] {
  return requests.filter(
    (r) =>
      r.crewId === crewId &&
      r.status === "approved" &&
      r.startDate <= date &&
      date <= r.endDate,
  );
}

export function parseISO(iso: string): Date {
  return new Date(iso + "T12:00:00");
}

export function fmtDate(iso: string): string {
  return parseISO(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtDateLong(iso: string): string {
  return parseISO(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** ISO timestamp -> "Oct 31, 2026, 2:14 PM" for audit entries and notes. */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function money(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

/** Monday of the week containing `iso` (weeks start Monday). */
export function mondayOf(iso: string): string {
  const d = parseISO(iso);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return addDaysISO(iso, diff);
}

export function weekDates(mondayIso: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(mondayIso, i));
}

/**
 * Hours between two HH:MM strings, rounded to 2 decimals. An end
 * earlier than the start ran past midnight (an overnight entry the
 * office typed): it counts to the next day, as weekly pay does
 * (overtime.ts entryMinutes), never a silent 0. See endsNextDay.
 */
export function hoursBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 1440;
  return Math.round((mins / 60) * 100) / 100;
}

/** True when an entry's clock-out is earlier than its clock-in (it ran past midnight). */
export function endsNextDay(e: { clockIn: string | null; clockOut: string | null }): boolean {
  return !!e.clockIn && !!e.clockOut && e.clockOut.slice(0, 5) < e.clockIn.slice(0, 5);
}

/** Hours an entry counts for: clock times win, otherwise manual hours. */
export function entryHours(
  e: { clockIn: string | null; clockOut: string | null; hours: number | null },
): number {
  if (e.clockIn && e.clockOut) return hoursBetween(e.clockIn, e.clockOut);
  return e.hours ?? 0;
}

export function isOpenEntry(e: {
  clockIn: string | null;
  clockOut: string | null;
}): boolean {
  return e.clockIn !== null && e.clockOut === null;
}
