import type { AuditEntry } from "./types";
import { ESTIMATE_STATUS_LABELS } from "./estimateStatus";

/**
 * Plain-English activity lines. The audit log stores raw field names
 * and values ("equipmentIds: eq-chip → eq-chip,eq-dump"); this turns
 * one entry into a sentence a person can read on a call:
 *
 *   Alex added the Chipper to Big oak
 *   Olive changed the start time of Big oak from 8:00 AM to 7:00 AM
 *   Alex marked Big oak Done
 *
 * The record name stays a separate piece (`label`) so the screen can
 * keep it clickable: `${actor} ${lead} ${label}${tail}`.
 * Database ids are never shown; entries where nothing changed are
 * hidden.
 */
export interface AuditSentence {
  lead: string;
  label: string;
  tail: string;
  /** Nothing worth showing (no real change). */
  hidden: boolean;
}

export interface AuditNames {
  /** Equipment id → name ("eq-chip" → "Chipper"). */
  equipment?: (id: string) => string | undefined;
}

const STATUS_WORDS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  done: "Done",
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  closed: ESTIMATE_STATUS_LABELS.closed,
  unpaid: "Unpaid",
  paid: "Paid",
  overdue: "Overdue",
  partial: "Partially paid",
  pending: "Waiting",
  approved: "Approved",
  denied: "Turned down",
  active: "Active",
};

const FIELD_WORDS: Record<string, string> = {
  startTime: "start time",
  endDate: "last day",
  serviceType: "type of work",
  customerNotes: "notes for the customer",
  teamNotes: "team notes",
  officeNotes: "office notes",
  pruneClass: "prune class",
  estimatedHours: "estimated hours",
  billingType: "billing",
  hourlyRate: "hourly rate",
  treeIds: "trees",
  recurringUntil: "repeat end",
  materialsCost: "materials cost",
  otherCost: "other costs",
  laborRate: "labor rate",
  timePromised: "promised time",
  visitDate: "visit date",
  visitTime: "visit time",
  taxRate: "tax rate",
  discountType: "discount",
  discountValue: "discount amount",
  acceptedOptionId: "accepted option",
  acceptedBy: "signed by",
  acceptedAt: "accepted on",
  expectedCrew: "expected crew",
  issuedDate: "issue date",
  dueDate: "due date",
  paidDate: "paid date",
  clockIn: "clock-in time",
  clockOut: "clock-out time",
  appRole: "app role",
  firstName: "first name",
  lastName: "last name",
  gateCode: "gate code",
  propertyNotes: "property notes",
  messageIntro: "message intro",
  payType: "pay type",
  payAmount: "pay",
  employmentType: "employment type",
  availableWeekdays: "work days",
  canDriveEquipment: "equipment they can drive",
  worksWellWith: "works well with",
  driverLicensed: "driver's licence",
  startDate: "start date",
  renewalDate: "renewal date",
  nextInspectionDate: "next inspection",
  intervalDays: "interval",
  weightLbs: "weight",
  weeklyDriverLimit: "weekly driving limit",
  homeSite: "parked at",
  customerId: "customer",
  customer: "customer",
  mapLat: "map pin",
  mapLng: "map pin",
};

const NOUNS: Record<string, string> = {
  Job: "the job",
  Estimate: "the estimate",
  Invoice: "invoice",
  Customer: "customer",
  Timesheet: "the time entry",
  User: "team member",
  Equipment: "equipment",
  "Time off": "time off",
  Automation: "the automation",
  Tree: "tree",
};

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLANK = "(blank)";

function fieldWord(field: string): string {
  if (FIELD_WORDS[field]) return FIELD_WORDS[field];
  // camelCase → "camel case"
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function isBlank(v: string): boolean {
  const t = v.trim();
  return t === "" || t === BLANK || t === "(none)" || t === "(not queued)";
}

/** "08:00" → "8:00 AM". */
export function plainTime(v: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return v;
  const h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** "2026-11-16" → "Mon Nov 16". */
export function plainDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return v;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** A value readable on screen, or null when it should not be shown (ids, blobs). */
function plainValue(field: string, v: string): string | null {
  const t = v.trim();
  if (isBlank(t)) return "nothing";
  if (ID_RE.test(t) || /^thread-/.test(t)) return null;
  if (t.startsWith("[") || t.startsWith("{") || t.length > 80) return null;
  if (field === "status" || field === "decision") return STATUS_WORDS[t] ?? t;
  if (t === "true") return "yes";
  if (t === "false") return "no";
  if (/^\d{1,2}:\d{2}$/.test(t)) return plainTime(t);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return plainDate(t);
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return plainDate(t.slice(0, 10));
  return t;
}

function listOf(v: string): string[] {
  if (isBlank(v)) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "the Chipper", "the Chipper and Dump trailer", "the Big Truck, Chipper and F-250". */
function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `the ${names[0]}`;
  return `the ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function sentence(lead: string, label: string, tail = ""): AuditSentence {
  return { lead, label, tail, hidden: false };
}

export function describeAudit(e: AuditEntry, names: AuditNames = {}): AuditSentence {
  const label = e.entityLabel || NOUNS[e.entity] || e.entity;
  const noun = NOUNS[e.entity];
  const oldV = e.oldValue ?? "";
  const newV = e.newValue ?? "";

  if (e.field === "(created)") {
    switch (e.entity) {
      case "Job":
        return sentence("added the job", label);
      case "Estimate":
        return sentence("wrote the estimate", label);
      case "Invoice":
        return sentence("made invoice", label);
      case "Customer":
        return sentence("added the customer", label);
      case "Message": {
        const call = /^Call log to (.+)$/.exec(label);
        if (call) return sentence("logged a call with", call[1]);
        return sentence("sent a", label.charAt(0).toLowerCase() + label.slice(1));
      }
      case "Note":
        return sentence("added a", label.charAt(0).toLowerCase() + label.slice(1));
      case "Timesheet":
        return sentence("added a time entry:", label);
      default:
        return sentence(`added${noun ? ` ${noun}` : ""}`, label);
    }
  }
  if (e.field === "(deleted)") {
    if (e.entity === "Note") return sentence("deleted a", label.charAt(0).toLowerCase() + label.slice(1));
    return sentence(`deleted${noun ? ` ${noun}` : ""}`, label);
  }
  if (e.field === "(line added)") return sentence("added a line to", label, newV ? `: ${newV}` : "");
  if (e.field === "(line removed)") return sentence("removed a line from", label, oldV ? `: ${oldV}` : "");
  if (e.field === "plan applied") return sentence("saved the day plan", label);

  // Nothing really changed ("(blank) → (blank)").
  if (oldV === newV || (isBlank(oldV) && isBlank(newV))) {
    return { lead: "", label, tail: "", hidden: true };
  }

  switch (e.field) {
    case "crew": {
      const added = /^added (.+)$/.exec(newV);
      if (added) return sentence(`added ${added[1]} to`, label);
      if (newV === "removed") return sentence(`took ${oldV} off`, label);
      break;
    }
    case "equipmentIds": {
      const before = listOf(oldV);
      const after = listOf(newV);
      const nameOf = (id: string) => names.equipment?.(id) ?? "a piece of equipment";
      const added = after.filter((x) => !before.includes(x)).map(nameOf);
      const removed = before.filter((x) => !after.includes(x)).map(nameOf);
      if (added.length > 0 && removed.length === 0) return sentence(`added ${joinNames(added)} to`, label);
      if (removed.length > 0 && added.length === 0) return sentence(`took ${joinNames(removed)} off`, label);
      if (added.length > 0)
        return sentence("changed the equipment on", label, ` (added ${joinNames(added)}; took off ${joinNames(removed)})`);
      return { lead: "", label, tail: "", hidden: true };
    }
    case "jobId":
      return isBlank(newV)
        ? sentence("unlinked the job from estimate", label)
        : sentence("made a job from estimate", label);
    case "estimateId":
      return isBlank(newV)
        ? sentence("unlinked the estimate from", label)
        : sentence("linked an estimate to", label);
    case "invoice":
      return isBlank(newV)
        ? sentence("unlinked the invoice from", label)
        : sentence("made an invoice for", label);
    case "email":
    case "emailQueuedAt":
      return sentence(`queued an email of ${noun ?? "the record"}`, label);
    case "emailed":
      return sentence(`emailed ${noun ?? ""}`.trim(), label, " to the customer with a link to accept it");
    case "status":
      return sentence("marked", label, ` ${plainValue("status", newV) ?? newV}`);
    case "paid":
      return sentence("updated the payment on", label);
    case "addresses":
      return sentence("updated the addresses of", label);
  }

  const word = fieldWord(e.field);
  const from = plainValue(e.field, oldV);
  const to = plainValue(e.field, newV);
  if (from === null || to === null) return sentence(`changed the ${word} of`, label);
  if (isBlank(oldV)) return sentence(`set the ${word} of`, label, ` to ${to}`);
  if (isBlank(newV)) return sentence(`cleared the ${word} of`, label, ` (was ${from})`);
  return sentence(`changed the ${word} of`, label, ` from ${from} to ${to}`);
}

/** The whole line as plain text (for search and tests). */
export function auditLine(e: AuditEntry, names: AuditNames = {}): string {
  const s = describeAudit(e, names);
  return `${e.actor} ${s.lead} ${s.label}${s.tail}`.replace(/\s+/g, " ").trim();
}

/**
 * Is this history entry signed by this team member? The database signs
 * a crew or Sales entry with the card name, plus the card id when two
 * people share a name ("Cal (c-12)", the "rls tightening" rules).
 */
export function actorIsMember(
  actor: string,
  member: { id: string; name: string },
): boolean {
  const name = member.name.trim();
  return actor === member.name || actor === name || actor === `${name} (${member.id})`;
}
