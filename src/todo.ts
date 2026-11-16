/**
 * Dashboard "To-do" (office staff): one short list of what needs a
 * person today, gathered from the attention lists the app already
 * keeps, each line with a button that opens the thing. No React here,
 * so it is unit tested on its own; the Dashboard passes in what is
 * loaded on demand (invoice reviews, the held email batch, the past
 * weeks' approvals).
 */
import type { AppState, Invoice } from "./types";
import type { View } from "./store";
import type { InvoiceReview } from "./autoInvoice";
import type { HeldBatch } from "./automationStatus";
import type { WeekApproval } from "./weekApprovals";
import { REVIEW_REASONS } from "./autoInvoice";
import { acceptedOnline } from "./acceptedOnline";
import { documentKindLabel, documentReminders, documentStatusLabel } from "./companyDocuments";
import { pendingAll } from "./customerEdits";
import { openProblems } from "./equipmentProblems";
import { jobsWithoutValue } from "./jobsWithoutValue";
import { overdueTasks } from "./maintenance";
import { unseenCrewChanges } from "./priceChange";
import { invoiceTotal } from "./splits";
import { isPastDueForOffice } from "./overdueInvoice";
import { addDaysISO, fmtDate, mondayOf, weekDates } from "./utils";
import { changedSinceApproval, weeklyPayRows, weekTotals } from "./weeklyPay";

export type TodoKind =
  | "problem"
  | "invoiceReview"
  | "bookingRequest"
  | "noValue"
  | "acceptedOnline"
  | "suggestion"
  | "priceChange"
  | "timeOff"
  | "week"
  | "heldEmails"
  | "overdueInvoice"
  | "unsentInvoice"
  | "licence"
  | "maintenance"
  | "account";

export type TodoAction =
  | { kind: "job"; id: string; edit?: boolean }
  | { kind: "estimate"; id: string }
  | { kind: "customer"; id: string }
  | { kind: "invoice"; id: string }
  | { kind: "view"; view: View }
  /** Timesheets opened on this Monday's week. */
  | { kind: "timesheetsWeek"; monday: string }
  /** Sales with the Booking requests section open. */
  | { kind: "salesBookings" };

export interface TodoItem {
  key: string;
  kind: TodoKind;
  /** What the line says. */
  text: string;
  /** Second, smaller line (may be empty). */
  detail: string;
  button: string;
  action: TodoAction;
}

export interface TodoGroup {
  kind: TodoKind;
  /** "3 equipment problems" */
  label: string;
  count: number;
  items: TodoItem[];
}

export interface TodoInput {
  state: AppState;
  today: string;
  /** Office staff (owner, manager, office). Crew get no to-do list. */
  staff: boolean;
  /** Owner or manager (accounts, week approval). */
  admin: boolean;
  showMoney: boolean;
  canEdit: boolean;
  /** Loaded on demand; null/empty while unknown. */
  invoiceReviews: InvoiceReview[];
  heldBatch: HeldBatch | null;
  /**
   * Approvals of past weeks, by Monday ('YYYY-MM-DD'); a week missing
   * here is not approved. undefined = not loaded yet (no week lines).
   */
  weekApprovals: Record<string, WeekApproval> | undefined;
}

/** Group order: what is most urgent first. */
const ORDER: TodoKind[] = [
  "problem",
  "invoiceReview",
  "bookingRequest",
  "acceptedOnline",
  "priceChange",
  "suggestion",
  "timeOff",
  "heldEmails",
  "week",
  "overdueInvoice",
  "unsentInvoice",
  "noValue",
  "licence",
  "maintenance",
  "account",
];

const LABELS: Record<TodoKind, [string, string]> = {
  problem: ["equipment problem", "equipment problems"],
  invoiceReview: ["job needs an invoice review", "jobs need an invoice review"],
  bookingRequest: ["booking request from the website", "booking requests from the website"],
  noValue: ["upcoming job has no value", "upcoming jobs have no value"],
  acceptedOnline: ["accepted online, call to schedule", "accepted online, call to schedule"],
  suggestion: ["suggested customer change", "suggested customer changes"],
  priceChange: ["crew price change", "crew price changes"],
  timeOff: ["time-off request", "time-off requests"],
  week: ["week to approve", "weeks to approve"],
  heldEmails: ["batch of emails waiting", "batches of emails waiting"],
  overdueInvoice: ["overdue invoice", "overdue invoices"],
  unsentInvoice: ["invoice not emailed yet", "invoices not emailed yet"],
  licence: ["licence or insurance expiring", "licences or insurance expiring"],
  maintenance: ["maintenance task overdue", "maintenance tasks overdue"],
  account: ["account waiting for approval", "accounts waiting for approval"],
};

export function groupLabel(kind: TodoKind, count: number): string {
  return `${count} ${LABELS[kind][count === 1 ? 0 : 1]}`;
}

/**
 * The customer has (most likely) got the invoice: it was emailed, the
 * automatic email went, or it is marked overdue or part paid by hand.
 * Only "queued" (emailQueuedAt) is not a send: the invoice panel says
 * "Not sent" for it, so it shows as "not emailed yet" here too.
 */
export function invoiceWasSent(inv: Invoice): boolean {
  return (
    !!inv.emailedAt ||
    !!inv.autoSentAt ||
    inv.status === "overdue" ||
    inv.status === "partial"
  );
}

/**
 * Unpaid, not zero, sent, and at least 10 business days past its due
 * date (business rule; see overdueInvoice.ts), or marked overdue.
 * `today` is the Denver date. An invoice that was only saved ("Save for
 * later") is never overdue: the customer has not had it. It shows as
 * "not emailed yet" instead.
 */
export function isOverdueInvoice(inv: Invoice, today: string): boolean {
  if (inv.status === "paid") return false;
  if (invoiceTotal(inv) <= 0) return false;
  if (!invoiceWasSent(inv)) return false;
  return inv.status === "overdue" || isPastDueForOffice(inv.dueDate, today);
}

/** Unpaid, not zero, and never emailed (saved for later). */
export function isUnsentInvoice(inv: Invoice): boolean {
  if (inv.status === "paid") return false;
  if (invoiceTotal(inv) <= 0) return false;
  return !invoiceWasSent(inv);
}

/**
 * How many finished weeks the To-do looks back for hours to approve
 * (business rule: "it can have the previous 2 weeks in the to do").
 */
export const TODO_PAST_WEEKS = 2;

/** Mondays of the previous TODO_PAST_WEEKS finished weeks, oldest first. */
export function todoWeekMondays(today: string): string[] {
  const thisMonday = mondayOf(today);
  const out: string[] = [];
  for (let k = TODO_PAST_WEEKS; k >= 1; k--) out.push(addDaysISO(thisMonday, -7 * k));
  return out;
}

/**
 * Mondays of the previous 2 finished weeks (not this week) that have
 * any time entry, oldest first. Each one with hours and no (or an
 * outdated) approval is a "week to approve". Older weeks are not
 * listed (business rule).
 */
export function pastWeeksWithEntries(state: Pick<AppState, "timesheets">, today: string): string[] {
  const listed = new Set(todoWeekMondays(today));
  const mondays = new Set<string>();
  for (const t of state.timesheets) {
    if (!t.date) continue;
    const m = mondayOf(t.date);
    if (listed.has(m)) mondays.add(m);
  }
  return [...mondays].sort();
}

export function buildTodo(input: TodoInput): TodoGroup[] {
  const { state, today, staff, admin, showMoney, canEdit } = input;
  if (!staff) return [];
  const customerName = (id: string | null | undefined) => {
    const c = state.customers.find((x) => x.id === id);
    return c ? `${c.firstName} ${c.lastName}`.trim() || c.company || "Customer" : "";
  };
  const jobTitle = (id: string) => state.jobs.find((j) => j.id === id)?.title || "Job";
  const crewName = (id: string) => state.crew.find((c) => c.id === id)?.name ?? "Someone";
  const items: TodoItem[] = [];

  for (const p of openProblems(state.equipmentProblems)) {
    const eq = state.equipment.find((e) => e.id === p.equipmentId);
    items.push({
      key: `problem:${p.id}`,
      kind: "problem",
      text: `${eq?.name ?? "Equipment"}: ${p.note.length > 80 ? `${p.note.slice(0, 79)}…` : p.note}`,
      detail: `${p.reportedName || "Someone"} · ${fmtDate(p.createdAt.slice(0, 10))}${p.hasPhoto ? " · photo" : ""}`,
      button: "Open Equipment",
      action: { kind: "view", view: "equipment" },
    });
  }

  for (const r of input.invoiceReviews) {
    const job = state.jobs.find((j) => j.id === r.jobId);
    items.push({
      key: `review:${r.id}`,
      kind: "invoiceReview",
      text: `${job?.title || "Job"}${customerName(job?.customerId ?? r.customerId) ? ` · ${customerName(job?.customerId ?? r.customerId)}` : ""}`,
      detail: REVIEW_REASONS[r.reason] ?? r.reason,
      button: "Open job",
      action: { kind: "job", id: r.jobId },
    });
  }

  if (canEdit) {
    for (const r of (state.bookingRequests ?? [])
      .filter((x) => x.status === "pending")
      .sort((a, b) => a.date.localeCompare(b.date))) {
      items.push({
        key: `booking:${r.id}`,
        kind: "bookingRequest",
        text: `${r.name || "Someone"}: wants an estimate visit ${fmtDate(r.date)}`,
        detail: [r.phone, r.address].filter(Boolean).join(" · "),
        button: "Open booking requests",
        action: { kind: "salesBookings" },
      });
    }
  }

  for (const a of acceptedOnline(state.estimates, state.jobs, state.customers)) {
    items.push({
      key: `accepted:${a.estimateId}`,
      kind: "acceptedOnline",
      text: `${a.customerName}: call to schedule`,
      detail: `${a.what} · accepted ${fmtDate(a.acceptedAt.slice(0, 10))}${a.phone ? ` · ${a.phone}` : ""}`,
      button: "Open estimate",
      action: { kind: "estimate", id: a.estimateId },
    });
  }

  for (const c of unseenCrewChanges(state.jobPriceChanges)) {
    items.push({
      key: `price:${c.id}`,
      kind: "priceChange",
      text: `${jobTitle(c.jobId)}: price changed by ${c.changedByName || "crew"}`,
      detail: c.reason ? `“${c.reason}”` : "",
      button: "Open job",
      action: { kind: "job", id: c.jobId },
    });
  }

  for (const r of pendingAll(state.customerEditRequests)) {
    if (!state.customers.some((c) => c.id === r.customerId)) continue;
    items.push({
      key: `suggest:${r.id}`,
      kind: "suggestion",
      text: `${customerName(r.customerId)}: change suggested by ${r.requestedName || "Sales"}`,
      detail: "Approve or decline it on the customer.",
      button: "Open customer",
      action: { kind: "customer", id: r.customerId },
    });
  }

  for (const t of state.timeOff
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    items.push({
      key: `timeoff:${t.id}`,
      kind: "timeOff",
      text: `${crewName(t.crewId)}: time off ${fmtDate(t.startDate)}${t.endDate !== t.startDate ? ` to ${fmtDate(t.endDate)}` : ""}`,
      detail: t.reason,
      button: "Open Schedule",
      action: { kind: "view", view: "schedule" },
    });
  }

  if (input.heldBatch && input.heldBatch.status === "waiting" && input.heldBatch.items.length > 0) {
    const n = input.heldBatch.items.length;
    items.push({
      key: `held:${input.heldBatch.id}`,
      kind: "heldEmails",
      text: `${n} automatic email${n === 1 ? "" : "s"} waiting for your OK`,
      detail: "More than 3 were due at once, so none were sent.",
      button: "Open Automations",
      action: { kind: "view", view: "automations" },
    });
  }

  if (admin && input.weekApprovals !== undefined) {
    const approvals = input.weekApprovals;
    for (const monday of pastWeeksWithEntries(state, today)) {
      const week = weekDates(monday);
      const rows = weeklyPayRows(state.crew, state.timesheets, week, today, {
        jobs: state.jobs,
        invoices: state.invoices,
      });
      const hours = weekTotals(rows).hours;
      const a = approvals[monday] ?? null;
      if (hours > 0 && (!a || changedSinceApproval(a.totalHours, hours))) {
        items.push({
          key: `week:${monday}`,
          kind: "week",
          text: `Week of ${fmtDate(monday)}: ${a ? "hours changed, approve again" : "approve the hours"}`,
          detail: `${hours} h`,
          button: "Open Timesheets",
          action: { kind: "timesheetsWeek", monday },
        });
      }
    }
  }

  if (showMoney) {
    for (const inv of state.invoices
      .filter((i) => isOverdueInvoice(i, today))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
      items.push({
        key: `overdue:${inv.id}`,
        kind: "overdueInvoice",
        text: `Invoice ${inv.number}${customerName(inv.customerId) ? ` · ${customerName(inv.customerId)}` : ""}`,
        detail: inv.dueDate ? `due ${fmtDate(inv.dueDate)}` : "overdue",
        button: "Open invoice",
        action: { kind: "invoice", id: inv.id },
      });
    }
  }

  if (showMoney) {
    for (const inv of state.invoices
      .filter((i) => isUnsentInvoice(i))
      .sort((a, b) => a.issuedDate.localeCompare(b.issuedDate))) {
      items.push({
        key: `unsent:${inv.id}`,
        kind: "unsentInvoice",
        text: `Invoice ${inv.number}${customerName(inv.customerId) ? ` · ${customerName(inv.customerId)}` : ""}`,
        detail: `Saved ${fmtDate(inv.issuedDate)}, not emailed yet`,
        button: "Open invoice",
        action: { kind: "invoice", id: inv.id },
      });
    }
  }

  if (showMoney && canEdit) {
    for (const j of jobsWithoutValue(state, today)) {
      items.push({
        key: `novalue:${j.id}`,
        kind: "noValue",
        text: `${j.title || "Untitled job"} · ${fmtDate(j.date)}`,
        detail: "No value: the Plan board can't work out how long it takes.",
        button: "Add value",
        action: { kind: "job", id: j.id, edit: true },
      });
    }
  }

  if (canEdit) {
    for (const r of documentReminders(state.companyDocuments, today)) {
      items.push({
        key: `doc:${r.doc.id}`,
        kind: "licence",
        text: `${documentKindLabel(r.doc.kind)}${r.doc.name ? ` (${r.doc.name})` : ""}`,
        detail: documentStatusLabel(r.status),
        button: "Open Licences & insurance",
        action: { kind: "view", view: "documents" },
      });
    }
  }

  for (const o of overdueTasks(state, today)) {
    items.push({
      key: `maint:${o.task.id}`,
      kind: "maintenance",
      text: `${o.equipment.name}: ${o.task.name}`,
      detail: `${o.daysOverdue} day${o.daysOverdue === 1 ? "" : "s"} overdue`,
      button: "Open Equipment",
      action: { kind: "view", view: "equipment" },
    });
  }

  if (admin) {
    for (const c of state.crew.filter((x) => x.status === "pending")) {
      items.push({
        key: `account:${c.id}`,
        kind: "account",
        text: `${c.name || "New signup"} wants access`,
        detail: "They can't see anything until you accept them.",
        button: "Review & accept",
        action: { kind: "view", view: "users" },
      });
    }
  }

  const groups: TodoGroup[] = [];
  for (const kind of ORDER) {
    const list = items.filter((i) => i.kind === kind);
    if (list.length > 0) groups.push({ kind, label: groupLabel(kind, list.length), count: list.length, items: list });
  }
  return groups;
}

/** The first `n` lines across the groups, in group order. */
export function topItems(groups: TodoGroup[], n = 5): TodoItem[] {
  return groups.flatMap((g) => g.items).slice(0, n);
}

export function todoCount(groups: TodoGroup[]): number {
  return groups.reduce((s, g) => s + g.count, 0);
}
