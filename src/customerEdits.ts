/**
 * Suggested customer changes (the "customer edit requests" rules; business rule: "Pat can suggest an edit, but he can't commit it unless it
 * gets approval from the office").
 *
 * A Sales login (job title Sales, app role crew) cannot edit customers.
 * It sends a suggestion instead: only the allow-listed fields below,
 * keyed like the database's `customer_edit_requests.changes`. The
 * office approves (approve_customer_edit applies it, with change
 * history) or declines. These helpers are the app side: what changed,
 * how it reads, and the same "apply only allow-listed fields" rule the
 * database uses (demo mode applies it on the phone).
 */
import { primaryAddress } from "./addresses";
import type { Customer, CustomerAddress, CustomerEditRequest } from "./types";

/** The fields a suggestion may change, in form order (database keys). */
export const SUGGESTABLE_FIELDS = [
  "first_name",
  "last_name",
  "company",
  "phone",
  "email",
  "street",
  "city",
  "state",
  "zip",
  "gate_code",
  "property_notes",
  "notes",
] as const;
export type SuggestableField = (typeof SUGGESTABLE_FIELDS)[number];
export type CustomerChanges = Partial<Record<SuggestableField, string>>;

export const FIELD_LABELS: Record<SuggestableField, string> = {
  first_name: "first name",
  last_name: "last name",
  company: "company",
  phone: "phone",
  email: "email",
  street: "street",
  city: "city",
  state: "state",
  zip: "ZIP",
  gate_code: "gate code",
  property_notes: "property notes",
  notes: "general notes",
};

/** The free-text note fields (longer limit, multi-line inputs). */
export const NOTE_FIELDS: readonly SuggestableField[] = ["property_notes", "notes"];

/** Longest value the database accepts per field. */
export function maxLength(f: SuggestableField): number {
  return NOTE_FIELDS.includes(f) ? 4000 : 200;
}

const ADDRESS_FIELDS: readonly SuggestableField[] = ["street", "city", "state", "zip"];

function isSuggestable(k: string): k is SuggestableField {
  return (SUGGESTABLE_FIELDS as readonly string[]).includes(k);
}

/** The customer's current values for every suggestable field. */
export function currentValues(c: Customer): Record<SuggestableField, string> {
  const a = primaryAddress(c);
  return {
    first_name: c.firstName ?? "",
    last_name: c.lastName ?? "",
    company: c.company ?? "",
    phone: c.phone ?? "",
    email: c.email ?? "",
    street: a?.street ?? c.address ?? "",
    city: a?.city ?? c.city ?? "",
    state: a?.state ?? "CO",
    zip: a?.zip ?? c.zip ?? "",
    gate_code: c.gateCode ?? "",
    property_notes: c.propertyNotes ?? "",
    notes: c.notes ?? "",
  };
}

/**
 * Keep only allow-listed keys with text values (trimmed, cut to the
 * database's length). Anything else is dropped.
 */
export function sanitizeChanges(raw: unknown): CustomerChanges {
  const out: CustomerChanges = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSuggestable(k) || typeof v !== "string") continue;
    out[k] = v.trim().slice(0, maxLength(k));
  }
  return out;
}

/**
 * What the form changes compared with the customer now: only fields
 * whose (trimmed) value differs. Empty when nothing changed.
 */
export function diffSuggestion(c: Customer, form: Partial<Record<string, string>>): CustomerChanges {
  const now = currentValues(c);
  const clean = sanitizeChanges(form);
  const out: CustomerChanges = {};
  for (const f of SUGGESTABLE_FIELDS) {
    const v = clean[f];
    if (v === undefined) continue;
    if (v !== now[f].trim()) out[f] = v;
  }
  return out;
}

export interface ChangeLine {
  field: SuggestableField;
  label: string;
  before: string;
  after: string;
}

/** Before → after, one line per allow-listed field, in form order. */
export function changeLines(c: Customer, changes: CustomerChanges): ChangeLine[] {
  const now = currentValues(c);
  const clean = sanitizeChanges(changes);
  return SUGGESTABLE_FIELDS.filter((f) => clean[f] !== undefined).map((f) => ({
    field: f,
    label: FIELD_LABELS[f],
    before: now[f],
    after: clean[f] ?? "",
  }));
}

function shown(v: string): string {
  return v.trim() === "" ? "(blank)" : v;
}

/** "Pat suggested: phone → 555-555-0100, ZIP → 12302". */
export function suggestionSummary(r: Pick<CustomerEditRequest, "requestedName" | "changes">): string {
  const clean = sanitizeChanges(r.changes);
  const parts = SUGGESTABLE_FIELDS.filter((f) => clean[f] !== undefined).map(
    (f) => `${FIELD_LABELS[f]} → ${shown(clean[f] ?? "")}`,
  );
  return `${r.requestedName || "Sales"} suggested: ${parts.join(", ")}`;
}

/**
 * The customer with the suggestion applied: allow-listed fields only;
 * address fields go to the primary address (one is added when there is
 * none), and the legacy address/city/zip mirror it. Same rule as
 * approve_customer_edit.
 */
export function applySuggestion(c: Customer, changes: CustomerChanges): Customer {
  const clean = sanitizeChanges(changes);
  const next: Customer = { ...c };
  if (clean.first_name !== undefined) next.firstName = clean.first_name;
  if (clean.last_name !== undefined) next.lastName = clean.last_name;
  if (clean.company !== undefined) next.company = clean.company;
  if (clean.phone !== undefined) next.phone = clean.phone;
  if (clean.email !== undefined) next.email = clean.email;
  if (clean.gate_code !== undefined) next.gateCode = clean.gate_code;
  if (clean.property_notes !== undefined) next.propertyNotes = clean.property_notes;
  if (clean.notes !== undefined) next.notes = clean.notes;
  if (ADDRESS_FIELDS.some((f) => clean[f] !== undefined)) {
    const primary = primaryAddress(c);
    const base: CustomerAddress = primary ?? {
      id: `addr-${c.id}`,
      label: "",
      street: c.address,
      city: c.city,
      state: "CO",
      zip: c.zip,
      isPrimary: true,
    };
    const addr: CustomerAddress = {
      ...base,
      street: clean.street ?? base.street,
      city: clean.city ?? base.city,
      state: clean.state ?? base.state,
      zip: clean.zip ?? base.zip,
      isPrimary: true,
    };
    const others = (c.addresses ?? []).filter((a) => a.id !== addr.id).map((a) => ({ ...a, isPrimary: false }));
    next.addresses = [addr, ...others];
    next.address = addr.street;
    next.city = addr.city;
    next.zip = addr.zip;
  }
  return next;
}

/** Pending suggestions for one customer, oldest first. */
export function pendingFor(list: CustomerEditRequest[] | undefined, customerId: string): CustomerEditRequest[] {
  return (list ?? [])
    .filter((r) => r.customerId === customerId && r.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every pending suggestion, oldest first (the office's list). */
export function pendingAll(list: CustomerEditRequest[] | undefined): CustomerEditRequest[] {
  return (list ?? []).filter((r) => r.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * What the office sends with Approve after editing the "after" values
 * (approve_customer_edit p_changes). `edited` holds the office's value
 * per suggested field; a field missing from `keep` is left out (not
 * applied). Returns null when the result is exactly what was suggested
 * (a plain approve), {} when nothing would be applied.
 */
export function approvalChanges(
  suggested: Record<string, string>,
  edited: Partial<Record<string, string>>,
  keep?: ReadonlySet<string>,
): CustomerChanges | null {
  const base = sanitizeChanges(suggested);
  const out: CustomerChanges = {};
  for (const f of SUGGESTABLE_FIELDS) {
    if (base[f] === undefined) continue;
    if (keep && !keep.has(f)) continue;
    const v = edited[f];
    out[f] = typeof v === "string" ? v.trim().slice(0, maxLength(f)) : base[f];
  }
  const same =
    Object.keys(out).length === Object.keys(base).length &&
    SUGGESTABLE_FIELDS.every((f) => out[f] === base[f]);
  return same ? null : out;
}

/** True when the office applied something else than was suggested. */
export function approvedWithChanges(r: Pick<CustomerEditRequest, "status" | "changes" | "appliedChanges">): boolean {
  if (r.status !== "approved" || !r.appliedChanges) return false;
  return approvalChanges(r.changes, r.appliedChanges, new Set(Object.keys(sanitizeChanges(r.appliedChanges)))) !== null;
}

/** "phone → 555-555-0100, ZIP → 12302" for any set of changes. */
export function changesText(changes: Record<string, string> | null | undefined): string {
  const clean = sanitizeChanges(changes ?? {});
  return SUGGESTABLE_FIELDS.filter((f) => clean[f] !== undefined)
    .map((f) => `${FIELD_LABELS[f]} → ${shown(clean[f] ?? "")}`)
    .join(", ");
}

/** How long a Sales person sees their decided suggestions. */
export const RECENT_DAYS = 30;

/**
 * Decided (approved or declined) suggestions from the last 30 days,
 * newest first; one customer's when customerId is given. The list a
 * Sales login loads holds only its own rows (row-level security).
 */
export function recentDecided(
  list: CustomerEditRequest[] | undefined,
  now: Date,
  customerId?: string,
): CustomerEditRequest[] {
  const since = now.getTime() - RECENT_DAYS * 86_400_000;
  return (list ?? [])
    .filter(
      (r) =>
        r.status !== "pending" &&
        r.decidedAt !== null &&
        Date.parse(r.decidedAt) >= since &&
        (customerId === undefined || r.customerId === customerId),
    )
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
}

/** "Approved", "Approved with changes: phone → …", "Declined: reason". */
export function decisionText(r: CustomerEditRequest): string {
  if (r.status === "declined") {
    const why = r.declineReason.trim();
    return why ? `Declined: ${why}` : "Declined (no reason given)";
  }
  if (r.status === "approved") {
    return approvedWithChanges(r) ? `Approved with changes: ${changesText(r.appliedChanges)}` : "Approved";
  }
  return "Waiting for office approval";
}

/** Longest decline reason the database accepts. */
export const DECLINE_REASON_MAX = 500;
