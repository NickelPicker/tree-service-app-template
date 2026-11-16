/**
 * Owner-marked unavailability: a crew member out for a stretch of
 * days, set by an owner/manager from the Schedule roster
 * (right-click → "Mark unavailable…"). Same shape as approved
 * time off — dates are inclusive YYYY-MM-DD strings — but with no
 * request/approval flow: it takes effect the moment it is saved.
 * Distinct from availableWeekdays (which weekdays they normally
 * work) and from time-off requests (crew asks, owner approves).
 */
import type { UnavailabilitySpan } from "./types";

/** True when any span marks this person unavailable on this day. */
export function isUnavailableOn(
  spans: UnavailabilitySpan[] | undefined,
  crewId: string,
  date: string,
): boolean {
  return (spans ?? []).some(
    (s) => s.crewId === crewId && s.startDate <= date && date <= s.endDate,
  );
}

/** Spans marking a person unavailable on a day (usually 0 or 1). */
export function unavailabilityOn(
  spans: UnavailabilitySpan[] | undefined,
  crewId: string,
  date: string,
): UnavailabilitySpan[] {
  return (spans ?? []).filter(
    (s) => s.crewId === crewId && s.startDate <= date && date <= s.endDate,
  );
}

/** All spans for one person, earliest first. */
export function spansForCrew(
  spans: UnavailabilitySpan[] | undefined,
  crewId: string,
): UnavailabilitySpan[] {
  return (spans ?? [])
    .filter((s) => s.crewId === crewId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/**
 * Merge a new span into a person's existing spans: overlapping or
 * directly adjacent spans become one span (Mon–Tue + Wed–Thu is
 * just Mon–Thu), so the list never holds two rows for the same
 * stretch. Returns the new list plus the merged span.
 */
export function mergeSpan(
  spans: UnavailabilitySpan[],
  crewId: string,
  startDate: string,
  endDate: string,
  newId: string,
): { spans: UnavailabilitySpan[]; merged: UnavailabilitySpan } {
  const lo = startDate <= endDate ? startDate : endDate;
  const hi = startDate <= endDate ? endDate : startDate;
  const overlapping = spans.filter(
    (s) =>
      s.crewId === crewId &&
      // Overlap or adjacency: s ends the day before the new span
      // starts (or later), and starts the day after it ends (or
      // earlier). Dates are YYYY-MM-DD strings, so a one-day step
      // is checked by comparing against the day after/before via
      // string math on the ISO form.
      s.startDate <= addOneDay(hi) && addOneDay(s.endDate) >= lo,
  );
  let start = lo;
  let end = hi;
  for (const s of overlapping) {
    if (s.startDate < start) start = s.startDate;
    if (s.endDate > end) end = s.endDate;
  }
  const merged: UnavailabilitySpan = {
    id: newId,
    crewId,
    startDate: start,
    endDate: end,
  };
  const absorbed = new Set(overlapping.map((s) => s.id));
  return {
    spans: [
      ...spans.filter((s) => !absorbed.has(s.id)),
      merged,
    ].sort((a, b) => a.startDate.localeCompare(b.startDate)),
    merged,
  };
}

/** The day after a YYYY-MM-DD date, as YYYY-MM-DD. */
function addOneDay(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
