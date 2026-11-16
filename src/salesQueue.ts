import type { AppState, BookingRequest, Customer, Estimate } from "./types";
import { fmtDate, isBlankCustomer } from "./utils";
import { visitsOnDay } from "./salesCalendar";
import { bookedAddressDiffers, findDuplicates, type DuplicateMatch } from "./addresses";

/**
 * The Sales tab's queue — the single place that defines what counts
 * as sales work. Three lists, nothing else:
 * - newCustomers: customers with no estimates and no jobs yet
 *   (blank / nameless customers stay out of browse lists, as
 *   everywhere else in the app);
 * - draftEstimates: estimates with status "draft" — the ones still to
 *   write or finish. Accepted and closed estimates live on the
 *   Schedule page, not here;
 * - bookingRequests: online booking requests (new-customer intake).
 * No recency cutoff: every draft and every untouched customer counts
 * until the owner says otherwise. Customers carry no added date, so
 * the new-customers list is alphabetical, not "newest first".
 */
export interface SalesQueue {
  newCustomers: Customer[];
  draftEstimates: Estimate[];
  bookingRequests: BookingRequest[];
}

export function customerDisplayName(c: Customer): string {
  const name = `${c.firstName} ${c.lastName}`.trim();
  return name || c.company || c.email || "Unnamed customer";
}

export function salesQueue(state: AppState): SalesQueue {
  const estimateCustomerIds = new Set(
    state.estimates.map((e) => e.customerId),
  );
  const jobCustomerIds = new Set(state.jobs.map((j) => j.customerId));
  const newCustomers = state.customers
    .filter((c) => !isBlankCustomer(c))
    .filter(
      (c) => !estimateCustomerIds.has(c.id) && !jobCustomerIds.has(c.id),
    )
    .sort((a, b) =>
      customerDisplayName(a).localeCompare(customerDisplayName(b)),
    );
  const draftEstimates = state.estimates
    .filter((e) => e.status === "draft")
    .sort((a, b) => b.createdDate.localeCompare(a.createdDate));
  const bookingRequests = [...(state.bookingRequests ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return { newCustomers, draftEstimates, bookingRequests };
}

/**
 * The estimator's estimate visits on one day, in time order (any
 * estimate with a visit that day, except a closed one: a visit stays on
 * the calendar after the estimate is written and sent). Crew jobs never appear here —
 * separate calendars, separate people.
 */
export function visitsForDay(state: AppState, date: string): Estimate[] {
  return visitsOnDay(state.estimates, date);
}

/** Booking requests from the website still waiting for the office. */
export function pendingBookingCount(state: Pick<AppState, "bookingRequests">): number {
  return (state.bookingRequests ?? []).filter((r) => r.status === "pending").length;
}

/** Still waiting for the office (so Accept or Decline would change something). */
export function bookingIsPending(
  state: Pick<AppState, "bookingRequests"> | null | undefined,
  id: string,
): boolean {
  return (state?.bookingRequests ?? []).some((r) => r.id === id && r.status === "pending");
}

/** The customer a booking request would become, split into first and last name. */
export function bookingCustomerDraft(r: BookingRequest): {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
} {
  const parts = r.name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "Website",
    lastName: parts.slice(1).join(" "),
    phone: r.phone,
    email: r.email ?? "",
    address: r.address,
  };
}

/** Customers already in the app that look like the person who booked (same phone, email, or name + address). */
export function bookingMatches(customers: Customer[], r: BookingRequest): DuplicateMatch[] {
  return findDuplicates(customers, bookingCustomerDraft(r));
}

/**
 * The draft estimate an accepted booking request becomes. It has no
 * visit day yet, so it waits in "Needs a visit" (with a suggested day
 * and time) until the office books the visit; the day the customer
 * asked for is in the notes. For an existing customer whose address on
 * file is not the one booked, the booked address goes in the notes too.
 */
export function bookingEstimate(
  r: BookingRequest,
  ids: { estimateId: string; customerId: string; lineId: string },
  today: string,
  existing: Customer | null,
): Estimate {
  const otherPlace =
    existing && bookedAddressDiffers(existing, r.address)
      ? ` Booked for ${r.address.trim()} (not the address on file).`
      : "";
  return {
    id: ids.estimateId,
    customerId: ids.customerId,
    jobId: null,
    title: `${r.name} — Estimate visit`,
    lines: [
      {
        id: ids.lineId,
        description: r.details || "Estimate visit",
        quantity: 1,
        unitPrice: 0,
      },
    ],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "draft",
    createdDate: today,
    notes: `Booked online for ${fmtDate(r.date)} — ${r.phone}.${otherPlace}`,
    emailQueuedAt: null,
    options: null,
    acceptedOptionId: null,
    acceptedBy: null,
    acceptedAt: null,
    visitDate: null,
    visitTime: null,
  };
}
