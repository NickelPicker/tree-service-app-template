// compose.ts — the office email for a suggested customer change
// (notify-suggestion). Pure functions, tested with vitest
// (src/__tests__/suggestionEmail.test.ts).
//
// Only the one customer the suggestion is about is read: its name, the
// current value of each suggested field (before) and the suggested value
// (after). Nothing else about the customer, and nothing about any other
// customer, goes in the email. Everything is escaped in the HTML part.

import { escapeHtml } from "../run-automations/plan.ts";

/** Same order and labels as the app's form (src/customerEdits.ts). */
export const FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["company", "Company"],
  ["phone", "Phone"],
  ["email", "Email"],
  ["street", "Street"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
  ["gate_code", "Gate code"],
  ["property_notes", "Property notes"],
  ["notes", "General notes"],
];
const KEYS = new Set(FIELDS.map(([k]) => k));

/** The suggestion as read from customer_edit_requests. */
export interface SuggestionRow {
  requested_name?: unknown;
  changes?: unknown;
  note?: unknown;
}

/** The customer row (customers) and its primary address (customer_addresses). */
export interface CustomerRow {
  first_name?: unknown;
  last_name?: unknown;
  company?: unknown;
  company_name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  city?: unknown;
  zip?: unknown;
  gate_code?: unknown;
  property_notes?: unknown;
  notes?: unknown;
}
export interface AddressRow {
  street?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
}

export interface FieldChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface OfficeEmail {
  subject: string;
  text: string;
  html: string;
}

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const shown = (v: string): string => (v.trim() === "" ? "(blank)" : v);
/** One line for subjects and names: no line breaks, at most n characters. */
const oneLine = (v: string, n: number): string => {
  const t = v.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function customerName(c: CustomerRow): string {
  return (
    [s(c.first_name).trim(), s(c.last_name).trim()].filter(Boolean).join(" ") ||
    s(c.company_name).trim() ||
    s(c.company).trim() ||
    "Customer"
  );
}

/** The customer's current value of one suggestable field. */
function current(key: string, c: CustomerRow, a: AddressRow | null): string {
  switch (key) {
    case "street":
      return s(a ? a.street : c.address);
    case "city":
      return s(a ? a.city : c.city);
    case "state":
      return a ? s(a.state) : "CO";
    case "zip":
      return s(a ? a.zip : c.zip);
    default:
      return s((c as Record<string, unknown>)[key]);
  }
}

/** Before → after for each allow-listed text field of the suggestion, in form order. */
export function fieldChanges(changes: unknown, c: CustomerRow, a: AddressRow | null): FieldChange[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const ch = changes as Record<string, unknown>;
  return FIELDS.filter(([k]) => KEYS.has(k) && typeof ch[k] === "string").map(([k, label]) => ({
    key: k,
    label,
    before: current(k, c, a),
    after: ch[k] as string,
  }));
}

const P = (t: string) => `<p style="margin:0 0 12px">${escapeHtml(t).replace(/\n/g, "<br>")}</p>`;

/**
 * The one email to the business Gmail: who suggested, which customer,
 * before → after per field, the note, and "open the app to approve".
 * `appUrl` (the site's address, optional) is shown as a link.
 */
export function composeSuggestionEmail(input: {
  suggestion: SuggestionRow;
  customer: CustomerRow;
  address: AddressRow | null;
  appUrl?: string;
}): OfficeEmail {
  const who = oneLine(s(input.suggestion.requested_name), 80) || "Sales";
  const name = oneLine(customerName(input.customer), 120);
  const lines = fieldChanges(input.suggestion.changes, input.customer, input.address);
  const note = s(input.suggestion.note).trim().slice(0, 1000);
  const url = /^https:\/\/[^\s"'<>]+$/.test(input.appUrl ?? "") ? (input.appUrl as string) : "";
  const subject = `Suggested change: ${name} (from ${who})`;
  const action = `Open the app${url ? ` (${url})` : ""} → Dashboard → "Suggested customer changes" to approve, change or decline it. Nothing changes on the customer until the office approves.`;

  const text = [
    `${who} suggested a change to ${name}.`,
    lines.map((l) => `${l.label}: ${shown(l.before)} → ${shown(l.after)}`).join("\n"),
    note ? `Note from ${who}: ${note}` : "",
    action,
  ]
    .filter(Boolean)
    .join("\n\n");

  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:4px 8px;vertical-align:top;font-weight:bold">${escapeHtml(l.label)}</td>` +
        `<td style="padding:4px 8px;vertical-align:top;color:#777;text-decoration:line-through">${escapeHtml(shown(l.before)).replace(/\n/g, "<br>")}</td>` +
        `<td style="padding:4px 8px;vertical-align:top">→ ${escapeHtml(shown(l.after)).replace(/\n/g, "<br>")}</td></tr>`,
    )
    .join("");
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:640px">` +
    P(`${who} suggested a change to ${name}.`) +
    `<table style="border-collapse:collapse;margin:0 0 12px">${rows}</table>` +
    (note ? P(`Note from ${who}: ${note}`) : "") +
    `<p style="margin:0 0 12px">Open the app${url ? ` (<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>)` : ""} → Dashboard → "Suggested customer changes" to approve, change or decline it. Nothing changes on the customer until the office approves.</p>` +
    `</div>`;
  return { subject, text, html };
}

/** How recent a suggestion must be for its author to ask for the email. */
export const RECENT_MS = 15 * 60_000;

/** Why the caller may not trigger the email for this row, or "" when they may. */
export function notifyRefusal(
  row: { requested_user?: unknown; status?: unknown; created_at?: unknown } | null,
  userId: string,
  now: number,
): "" | "not-allowed" | "decided" | "too-old" {
  if (!row || !userId || s(row.requested_user) !== userId) return "not-allowed";
  if (s(row.status) !== "pending") return "decided";
  const at = Date.parse(s(row.created_at));
  if (!Number.isFinite(at) || now - at > RECENT_MS || at - now > 60_000) return "too-old";
  return "";
}
