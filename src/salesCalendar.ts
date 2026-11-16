import type { Customer, Estimate } from "./types";
import { customerMatches } from "./customerSearch";
import { isBlankCustomer } from "./utils";

/**
 * The Sales calendar's data rules (no React, unit tested in
 * src/__tests__/salesCalendar.test.ts):
 * - which estimate visits sit on which day, in time order;
 * - moving a visit to another day (keep the time or pick a new one);
 * - "Create estimate": one form for an existing customer (picked from
 *   suggestions, details autofilled) or a new one (details typed in),
 *   which reuses the customer's open draft estimate or starts a new
 *   draft, with an optional visit day and time.
 *
 * Estimate visits live only on the Sales calendar (business rule); the Schedule page's month calendar is for crew jobs.
 */

/**
 * A visit is on the calendar while it has a day and a time, whatever
 * happens to the estimate afterwards (sent, accepted, closed/lost): the
 * Sales calendar is the record of every sales visit (business rule:
 * "it should not get removed unless we remove it"). Only Clear visit,
 * or deleting the estimate, takes it off.
 */
export function isVisitOn(e: Estimate, date: string): boolean {
  return e.visitDate === date && !!e.visitTime;
}

function byVisitTime(a: Estimate, b: Estimate): number {
  return (a.visitTime ?? "").localeCompare(b.visitTime ?? "");
}

/** The estimate visits on one day, in time order. */
export function visitsOnDay(estimates: Estimate[], date: string): Estimate[] {
  return estimates.filter((e) => isVisitOn(e, date)).sort(byVisitTime);
}

/** Visits for each of the given days (one pass), each day in time order. */
export function visitsByDay(
  estimates: Estimate[],
  dates: string[],
): Map<string, Estimate[]> {
  const out = new Map<string, Estimate[]>(dates.map((d) => [d, []]));
  for (const e of estimates) {
    if (!e.visitDate || !e.visitTime) continue;
    out.get(e.visitDate)?.push(e);
  }
  for (const list of out.values()) list.sort(byVisitTime);
  return out;
}

/** "9:30" / "13:00" → "9:30" / "1:00" (12-hour, no AM/PM: chips are short). */
export function shortTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, "0")}`;
}

/** Chip text: "9:30 · Smith — oak removal". */
export function visitChipLabel(e: Estimate, customer: Customer | undefined): string {
  const who = customer
    ? customer.lastName.trim() ||
      customer.firstName.trim() ||
      customer.companyName?.trim() ||
      customer.company.trim() ||
      "Customer"
    : "Customer";
  const what = e.title.trim();
  return `${shortTime(e.visitTime)} · ${who}${what ? ` — ${what}` : ""}`;
}

/**
 * The visit fields after dragging a visit onto another day. With no
 * new time the visit keeps its time.
 */
export function movedVisit(
  e: Estimate,
  date: string,
  time?: string | null,
): { visitDate: string; visitTime: string | null } {
  return { visitDate: date, visitTime: time ?? e.visitTime ?? null };
}

/**
 * Customers matching what is typed in the name box (name, phone
 * digits, email, address), best first: names that start with the
 * text, then the rest by name. Blank customers never show.
 */
export function customerSuggestions(
  customers: Customer[],
  query: string,
  limit = 6,
): Customer[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const name = (c: Customer) => `${c.firstName} ${c.lastName}`.trim().toLowerCase();
  const hits = customers.filter(
    (c) => !isBlankCustomer(c) && customerMatches(c, q),
  );
  hits.sort((a, b) => {
    const as = name(a).startsWith(q) || a.lastName.toLowerCase().startsWith(q) ? 0 : 1;
    const bs = name(b).startsWith(q) || b.lastName.toLowerCase().startsWith(q) ? 0 : 1;
    return as - bs || name(a).localeCompare(name(b));
  });
  return hits.slice(0, limit);
}

/**
 * The customer's open draft estimate to reuse for a new visit: the
 * newest draft with no job and no visit booked yet. A draft that
 * already has a visit is a different trip, so a new draft is started.
 */
export function openDraftFor(
  estimates: Estimate[],
  customerId: string,
): Estimate | null {
  const drafts = estimates
    .filter(
      (e) =>
        e.customerId === customerId &&
        e.status === "draft" &&
        !e.jobId &&
        !e.visitDate,
    )
    .sort((a, b) => b.createdDate.localeCompare(a.createdDate));
  return drafts[0] ?? null;
}

export interface NewCustomerDetails {
  /** As typed: "Jane Smith" (first word = first name, the rest = last name). */
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  zip: string;
}

export interface CreateEstimateInput {
  /** The picked existing customer, or null for a new one. */
  customerId: string | null;
  /** Details for a new customer (ignored when customerId is set). */
  newCustomer: NewCustomerDetails | null;
  /** What the visit is for ("oak removal"); the estimate's title. */
  title: string;
  notes: string;
  visitDate: string | null;
  visitTime: string | null;
}

export interface CreateEstimatePlan {
  customer: Customer;
  customerIsNew: boolean;
  estimate: Estimate;
  /** The draft as it was before, when an open draft is reused. */
  previous: Estimate | null;
}

/** "Jane van Smith" → first "Jane", last "van Smith". */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function newCustomerFrom(id: string, d: NewCustomerDetails): Customer {
  const { firstName, lastName } = splitName(d.name);
  return {
    id,
    firstName,
    lastName,
    company: "",
    phone: d.phone.trim(),
    email: d.email.trim(),
    address: d.address.trim(),
    city: d.city.trim(),
    zip: d.zip.trim(),
    propertyNotes: "",
    gateCode: "",
    notes: "",
    mapLat: null,
    mapLng: null,
    boundary: null,
    type: "residential",
    companyName: null,
    contacts: [],
    projectName: null,
    projectNumber: null,
    poNumber: null,
    contractNumber: null,
    jobSiteAddress: null,
    billingTerms: null,
  };
}

/**
 * What "Create estimate" saves: the customer (new, or the picked one)
 * and the estimate (the customer's open draft with the visit added, or
 * a new draft). Returns null when there is no customer to use (no
 * name typed and none picked, or the picked id no longer exists).
 */
export function planCreateEstimate(
  data: { customers: Customer[]; estimates: Estimate[] },
  input: CreateEstimateInput,
  ids: { customerId: string; estimateId: string; lineId: string },
  today: string,
): CreateEstimatePlan | null {
  let customer: Customer | undefined;
  let customerIsNew = false;
  if (input.customerId) {
    customer = data.customers.find((c) => c.id === input.customerId);
  } else if (input.newCustomer && input.newCustomer.name.trim() !== "") {
    customer = newCustomerFrom(ids.customerId, input.newCustomer);
    customerIsNew = true;
  }
  if (!customer) return null;
  const visitDate = input.visitDate || null;
  const visitTime = visitDate ? input.visitTime || null : null;
  const title = input.title.trim();
  const notes = input.notes.trim();
  const reuse = customerIsNew ? null : openDraftFor(data.estimates, customer.id);
  if (reuse) {
    const mergedNotes =
      notes && !reuse.notes.includes(notes)
        ? [reuse.notes.trim(), notes].filter(Boolean).join("\n")
        : reuse.notes;
    return {
      customer,
      customerIsNew,
      previous: reuse,
      estimate: {
        ...reuse,
        title: reuse.title.trim() || title || "Estimate visit",
        notes: mergedNotes,
        visitDate,
        visitTime,
      },
    };
  }
  return {
    customer,
    customerIsNew,
    previous: null,
    estimate: {
      id: ids.estimateId,
      customerId: customer.id,
      jobId: null,
      title: title || "Estimate visit",
      lines: [{ id: ids.lineId, description: "", quantity: 1, unitPrice: 0 }],
      taxRate: 0,
      discountType: "none",
      discountValue: 0,
      status: "draft",
      createdDate: today,
      notes,
      emailQueuedAt: null,
      options: null,
      acceptedOptionId: null,
      acceptedBy: null,
      acceptedAt: null,
      expectedCrew: null,
      visitDate,
      visitTime,
    },
  };
}
