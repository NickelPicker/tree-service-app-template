// plan.ts — decides which automatic customer emails are due, and writes them.
//
// Pure code with no Deno or browser globals, so the edge function
// (index.ts) and the app's vitest tests both import it. Rows use the
// database's column names (snake_case) exactly as Supabase returns them.
//
// The rules come from the Automations page (on/off, timing in days,
// message template). Each email has a "dedupe key"; the sends log keeps
// one row per key, so nothing is ever sent twice.

import { firstOverdueDay } from "../_shared/businessDays.ts";
import { BUSINESS_TIME_ZONE } from "../_shared/businessSettings.ts";

export type RuleKind =
  | "invoice_reminder"
  | "review_request"
  | "estimate_reminder"
  | "thank_you"
  | "job_reminder"
  | "overdue_escalation"
  | "phc_renewal"
  | "invoice_send";

export const RULE_KINDS: RuleKind[] = [
  "invoice_send",
  "job_reminder",
  "overdue_escalation",
  "invoice_reminder",
  "estimate_reminder",
  "phc_renewal",
  "thank_you",
  "review_request",
];

/** Where the business is: sending hours and "today" use this clock. */
export const TIME_ZONE = BUSINESS_TIME_ZONE;
/** Customer emails only go out between these local hours (8:00 to 17:59). */
export const SEND_FROM_HOUR = 8;
export const SEND_UNTIL_HOUR = 18;
/** Throttle, well under Gmail's ~500 a day (day plans and logins share it). */
export const MAX_PER_RUN = 25;
export const MAX_PER_DAY = 150;
/** Something that came due more than this many days ago is left alone. */
export const CATCH_UP_DAYS = 14;
/** A customer is asked for a review at most once in this many days. */
export const REVIEW_GAP_DAYS = 180;

export interface RuleRow {
  kind: string;
  enabled: boolean | null;
  timing_days: number | null;
  template: string | null;
  label?: string | null;
}

export interface CustomerRow {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  company_name?: string | null;
  email?: string | null;
  no_auto_emails?: boolean | null;
}

interface Line {
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
}

export interface InvoiceRow {
  id: string;
  number?: string | null;
  customer_id: string;
  job_id?: string | null;
  status: string;
  issued_date?: string | null;
  due_date?: string | null;
  paid_date?: string | null;
  lines?: Line[] | null;
  tax_rate?: number | string | null;
  discount_type?: string | null;
  discount_value?: number | string | null;
  /** "Done" invoices only: waiting | sending | sent | stopped (null = not emailed automatically). */
  auto_send_status?: string | null;
  /** Made by the database when the job was marked done. */
  auto_created?: boolean | null;
  /** Set when the office pressed Email (older builds wrote it without sending: proves nothing). */
  email_queued_at?: string | null;
  /** Set only by the database when the invoice was really emailed (the "invoice email by hand" rules). */
  emailed_at?: string | null;
  /** Split between payers (invoices.splits); [] or missing = billed to the customer in full. */
  splits?: unknown;
}

/**
 * True for an invoice split between payers. The automatic paths never
 * email those (the "Done" email, reminders, past-due emails, the
 * thank-you after payment): each payer
 * must get their own share, so only a person sends them, from the
 * invoice (send-invoice). The hourly run moves a waiting "Done" email
 * of a split invoice to "Needs invoice review" (auto_invoice_stop_split).
 */
export function isSplitInvoice(i: { splits?: unknown }): boolean {
  return Array.isArray(i.splits) && i.splits.length > 0;
}

export interface EstimateRow {
  id: string;
  title?: string | null;
  customer_id: string;
  status: string;
  created_date?: string | null;
  email_queued_at?: string | null;
  lines?: Line[] | null;
  options?: Array<{ id: string; lines?: Line[] | null }> | null;
  accepted_option_id?: string | null;
  tax_rate?: number | string | null;
  discount_type?: string | null;
  discount_value?: number | string | null;
}

export interface JobRow {
  id: string;
  title?: string | null;
  customer_id: string;
  date: string;
  status?: string | null;
}

export interface PhcRow {
  id: string;
  name?: string | null;
  customer_id: string;
  status?: string | null;
  renewal_date?: string | null;
}

export interface CompanyProfile {
  name?: string | null;
  phone?: string | null;
  zelleNumber?: string | null;
  checkPayee?: string | null;
  checkMailingAddress?: string | null;
}

export interface PlanInput {
  /** Local "YYYY-MM-DD". */
  today: string;
  /** Day the master switch was turned on ("YYYY-MM-DD"); null = never. */
  since: string | null;
  rules: RuleRow[];
  customers: CustomerRow[];
  invoices: InvoiceRow[];
  estimates: EstimateRow[];
  jobs: JobRow[];
  phc: PhcRow[];
  company: CompanyProfile | null;
  /** Customers who already got an automatic email in the last day. */
  emailedRecently?: Set<string>;
  /** Customers asked for a review in the last REVIEW_GAP_DAYS days. */
  reviewedRecently?: Set<string>;
  /** Dedupe keys already sent (or being sent) — skipped before anything else. */
  done?: Set<string>;
  /**
   * Only these dedupe keys may be planned ("Send them" on a batch the
   * office approved). Missing = every due email.
   */
  onlyKeys?: Set<string>;
}

export interface PlannedEmail {
  kind: RuleKind;
  dedupeKey: string;
  targetId: string;
  customerId: string;
  customerName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * What goes in the customer's message thread: a short line with no
   * money in it (crew who may not see prices can read the thread).
   */
  record: string;
  jobId: string | null;
  estimateId: string | null;
  /** The day it came due (oldest first within a rule). */
  dueDay: string;
}

export interface Plan {
  emails: PlannedEmail[];
  /** Due, but the customer has no usable email address. */
  skippedNoEmail: number;
  /** Due, but the customer is marked "No automatic emails". */
  skippedOptedOut: number;
  /** Due, but the customer already got one today (sent on a later day). */
  heldForCustomer: number;
  /** The dedupe keys counted in heldForCustomer. */
  heldKeys: string[];
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

// ---------- small helpers ----------

/** "YYYY-MM-DD" plus n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first 10 characters when they look like a date, else "". */
function dayOf(v: string | null | undefined): string {
  return v && DAY_RE.test(v) ? v.slice(0, 10) : "";
}

/** Local date and hour in TIME_ZONE for an instant. */
export function localNow(now: Date, timeZone = TIME_ZONE): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) % 24 };
}

/** True during the hours customer emails may go out. */
export function inSendingHours(hour: number): boolean {
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

/** "2026-11-16" -> "Monday, November 16". */
export function niceDate(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (!day || Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

/** $1,250 or $1,250.50 (same as the app). */
export function money(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** Same math as the app: discount first, then tax. */
export function documentTotal(
  lines: Line[] | null | undefined,
  taxRate: unknown,
  discountType: unknown,
  discountValue: unknown,
): number {
  const subtotal = (lines ?? []).reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0);
  let discount = 0;
  const dv = num(discountValue);
  if (discountType === "percent") discount = subtotal * (Math.min(100, Math.max(0, dv)) / 100);
  else if (discountType === "fixed") discount = Math.min(subtotal, Math.max(0, dv));
  const discounted = subtotal - discount;
  return Math.round((discounted + discounted * (num(taxRate) / 100)) * 100) / 100;
}

function invoiceTotal(i: InvoiceRow): number {
  return documentTotal(i.lines, i.tax_rate, i.discount_type, i.discount_value);
}

function estimateTotal(e: EstimateRow): number {
  const accepted = e.accepted_option_id ? e.options?.find((o) => o.id === e.accepted_option_id) : undefined;
  return documentTotal(accepted?.lines ?? e.lines, e.tax_rate, e.discount_type, e.discount_value);
}

/** What the email calls the customer: first name, else the business name. */
export function greetingName(c: CustomerRow): string {
  return (
    (c.first_name ?? "").trim() ||
    (c.company_name ?? "").trim() ||
    (c.company ?? "").trim() ||
    "there"
  );
}

/** Full name for the sends log (shown in the app, never in CI logs). */
export function displayName(c: CustomerRow): string {
  const full = [c.first_name, c.last_name].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
  return (full || (c.company_name ?? "").trim() || (c.company ?? "").trim() || "Customer").slice(0, 200);
}

export function renderTemplate(
  template: string,
  values: { customer: string; amount: string; title: string; date: string },
): string {
  return template
    .replaceAll("{customer}", values.customer)
    .replaceAll("{amount}", values.amount)
    .replaceAll("{title}", values.title)
    .replaceAll("{date}", values.date);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function howToPay(invoiceNumber: string, company: CompanyProfile | null): string {
  const zelle = (company?.zelleNumber ?? "").trim();
  const payee = (company?.checkPayee ?? "").trim();
  const mail = (company?.checkMailingAddress ?? "").trim();
  const lines: string[] = [];
  if (zelle) lines.push(`Zelle — send to ${zelle}.`);
  if (payee) lines.push(`Check — payable to ${payee}${mail ? `, mail to ${mail}.` : "."}`);
  if (lines.length === 0) return "";
  return `How to pay:\n${lines.join("\n")}\nPlease put invoice ${invoiceNumber} in the memo.`;
}

export function optOutLine(company: CompanyProfile | null): string {
  const name = (company?.name ?? "").trim() || "Your Tree Company";
  return `This is an automatic email from ${name}. Prefer not to get these? Reply "stop" and we will turn them off.`;
}

function signature(company: CompanyProfile | null): string {
  const name = (company?.name ?? "").trim() || "Your Tree Company";
  const phone = (company?.phone ?? "").trim();
  return phone ? `${name}\n${phone}` : name;
}

/** Plain text + simple HTML of the same message. */
export function composeBody(
  message: string,
  extra: string,
  company: CompanyProfile | null,
): { text: string; html: string } {
  const blocks = [message.trim(), extra.trim(), signature(company)].filter(Boolean);
  const optOut = optOutLine(company);
  const text = `${blocks.join("\n\n")}\n\n--\n${optOut}`;
  const p = (s: string) => `<p>${escapeHtml(s).replace(/\n/g, "<br>")}</p>`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.4;color:#222">` +
    blocks.map(p).join("") +
    `<p style="color:#777;font-size:13px;border-top:1px solid #ddd;padding-top:8px">${escapeHtml(optOut)}</p></div>`;
  return { text, html };
}

// ---------- the plan ----------

interface Candidate {
  kind: RuleKind;
  dedupeKey: string;
  targetId: string;
  customerId: string;
  dueDay: string;
  title: string;
  amount: string;
  date: string;
  subject: string;
  extra: string;
  jobId: string | null;
  estimateId: string | null;
}

/**
 * Rules that never send by themselves, whatever their switch says.
 * Business rule: reviews are asked only from the invoice email, by
 * the person sending it ("Ask for a review in this email"), never
 * automatically.
 */
export const NEVER_AUTOMATIC: ReadonlySet<string> = new Set(["review_request"]);

function enabledRules(rules: RuleRow[]): Map<RuleKind, RuleRow> {
  const m = new Map<RuleKind, RuleRow>();
  for (const r of rules) {
    if (NEVER_AUTOMATIC.has(r.kind)) continue;
    if (r.enabled === true && (RULE_KINDS as string[]).includes(r.kind) && !m.has(r.kind as RuleKind)) {
      m.set(r.kind as RuleKind, r);
    }
  }
  return m;
}

function timing(r: RuleRow): number {
  const n = Math.floor(num(r.timing_days));
  return n < 0 ? 0 : Math.min(n, 365);
}

const UNPAID = new Set(["unpaid", "overdue", "partial"]);

/**
 * The day the automatic past-due email may go for an invoice due on
 * `due`, with the rule set to `days` on the Automations page: at least
 * `days` calendar days past the due date AND at least 10 business days
 * past it (Denver, Mon–Fri), whichever is later (business rule: the
 * email waits until the invoice is overdue, the same rule as the office
 * uses: _shared/businessDays.ts). The days setting can only make it
 * later, never earlier than the 10 business days.
 */
export function pastDueEmailDay(due: string, days: number): string {
  const byDays = addDays(due, days);
  const floor = firstOverdueDay(due.slice(0, 10));
  return floor && floor > byDays ? floor : byDays;
}


/**
 * True when a reminder about this invoice makes sense: it has something
 * to pay, and the customer has received it: emailed automatically, or
 * emailed by the office from the app (also after its automatic email
 * was stopped), or made by the office (who sends it themselves). An
 * invoice made by "Done" that was never emailed (auto-send off, still
 * waiting, being emailed, or stopped and not sent by hand) never
 * reached the customer, so it gets no reminder or past-due email. An
 * invoice split between payers never gets one either.
 */
export function invoiceMayBeChased(i: InvoiceRow): boolean {
  if (!(invoiceTotal(i) > 0)) return false;
  // Split between payers: a reminder would ask the customer for the
  // whole amount, so a person chases each payer instead.
  if (isSplitInvoice(i)) return false;
  if (i.auto_send_status === "sent" || (i.emailed_at ?? "") !== "") return true;
  return i.auto_send_status == null && i.auto_created !== true;
}

function candidates(input: PlanInput, rules: Map<RuleKind, RuleRow>): Candidate[] {
  const out: Candidate[] = [];
  const company = input.company;
  const push = (c: Candidate) => out.push(c);

  for (const i of input.invoices) {
    const number = (i.number ?? "").trim() || "invoice";
    const amount = money(invoiceTotal(i));
    const issued = dayOf(i.issued_date);
    const due = dayOf(i.due_date);
    const paid = dayOf(i.paid_date);
    const base = { targetId: i.id, customerId: i.customer_id, title: number, amount, jobId: i.job_id ?? null, estimateId: null };
    if (UNPAID.has(i.status) && invoiceMayBeChased(i)) {
      const r = rules.get("invoice_reminder");
      if (r && issued) {
        push({
          ...base,
          kind: "invoice_reminder",
          dedupeKey: `invoice_reminder:${i.id}`,
          dueDay: addDays(issued, timing(r)),
          date: due ? niceDate(due) : "",
          subject: `Reminder: invoice ${number}`,
          extra: howToPay(number, company),
        });
      }
      const o = rules.get("overdue_escalation");
      if (o && due) {
        push({
          ...base,
          kind: "overdue_escalation",
          dedupeKey: `overdue_escalation:${i.id}`,
          dueDay: pastDueEmailDay(due, timing(o)),
          date: niceDate(due),
          subject: `Past due: invoice ${number}`,
          extra: howToPay(number, company),
        });
      }
    }
    // Split between payers: a person handles every email about it (the
    // thank-you too; review requests are never automatic anyway).
    if (i.status === "paid" && paid && !isSplitInvoice(i)) {
      const t = rules.get("thank_you");
      if (t) {
        push({
          ...base,
          kind: "thank_you",
          dedupeKey: `thank_you:${i.id}`,
          dueDay: addDays(paid, timing(t)),
          date: niceDate(paid),
          subject: "Thank you",
          extra: "",
        });
      }
      const rv = rules.get("review_request");
      if (rv && !input.reviewedRecently?.has(i.customer_id)) {
        push({
          ...base,
          kind: "review_request",
          dedupeKey: `review_request:${i.id}`,
          dueDay: addDays(paid, timing(rv)),
          date: niceDate(paid),
          subject: "How did we do?",
          extra: "",
        });
      }
    }
  }

  const er = rules.get("estimate_reminder");
  if (er) {
    for (const e of input.estimates) {
      if (e.status !== "sent") continue;
      const sentDay = dayOf(e.email_queued_at) || dayOf(e.created_date);
      if (!sentDay) continue;
      const title = (e.title ?? "").trim() || "your estimate";
      push({
        kind: "estimate_reminder",
        dedupeKey: `estimate_reminder:${e.id}`,
        targetId: e.id,
        customerId: e.customer_id,
        dueDay: addDays(sentDay, timing(er)),
        title,
        amount: money(estimateTotal(e)),
        date: niceDate(sentDay),
        subject: `Your estimate: ${title}`,
        extra: "",
        jobId: null,
        estimateId: e.id,
      });
    }
  }

  const jr = rules.get("job_reminder");
  if (jr) {
    const before = Math.max(1, timing(jr));
    for (const j of input.jobs) {
      const day = dayOf(j.date);
      if (!day || (j.status ?? "scheduled") !== "scheduled") continue;
      // Only before the job: a reminder on the day or after is useless.
      if (!(input.today < day)) continue;
      const title = (j.title ?? "").trim() || "your job";
      push({
        kind: "job_reminder",
        dedupeKey: `job_reminder:${j.id}:${day}`,
        targetId: j.id,
        customerId: j.customer_id,
        dueDay: addDays(day, -before),
        title,
        amount: "",
        date: niceDate(day),
        subject: `See you ${niceDate(day)}`,
        extra: "",
        jobId: j.id,
        estimateId: null,
      });
    }
  }

  const pr = rules.get("phc_renewal");
  if (pr) {
    for (const p of input.phc) {
      const renew = dayOf(p.renewal_date);
      if (!renew || (p.status ?? "active") !== "active") continue;
      if (input.today > renew) continue;
      const title = (p.name ?? "").trim() || "plant health care";
      push({
        kind: "phc_renewal",
        dedupeKey: `phc_renewal:${p.id}:${renew}`,
        targetId: p.id,
        customerId: p.customer_id,
        dueDay: addDays(renew, -timing(pr)),
        title,
        amount: "",
        date: niceDate(renew),
        subject: `Your plant health care program renews ${niceDate(renew)}`,
        extra: "",
        jobId: null,
        estimateId: null,
      });
    }
  }
  return out;
}

/**
 * Everything due today, at most one email per customer, most urgent
 * first. Only things that came due since the master switch was turned
 * on (and within CATCH_UP_DAYS) count, so old backlog is never mailed.
 * The caller still applies the run/day limits and the sends log.
 */
export function planAutomaticEmails(input: PlanInput): Plan {
  const plan: Plan = { emails: [], skippedNoEmail: 0, skippedOptedOut: 0, heldForCustomer: 0, heldKeys: [] };
  if (!input.since || !DAY_RE.test(input.since)) return plan;
  const rules = enabledRules(input.rules);
  if (rules.size === 0) return plan;
  const earliest = [input.since.slice(0, 10), addDays(input.today, -CATCH_UP_DAYS)].sort()[1];

  const due = candidates(input, rules)
    .filter(
      (c) =>
        c.dueDay >= earliest &&
        c.dueDay <= input.today &&
        !input.done?.has(c.dedupeKey) &&
        (!input.onlyKeys || input.onlyKeys.has(c.dedupeKey)),
    )
    .sort(
      (a, b) =>
        RULE_KINDS.indexOf(a.kind) - RULE_KINDS.indexOf(b.kind) ||
        a.dueDay.localeCompare(b.dueDay) ||
        a.dedupeKey.localeCompare(b.dedupeKey),
    );

  const customers = new Map(input.customers.map((c) => [c.id, c]));
  const taken = new Set(input.emailedRecently ?? []);
  for (const c of due) {
    const cust = customers.get(c.customerId);
    if (!cust) continue;
    if (cust.no_auto_emails === true) {
      plan.skippedOptedOut++;
      continue;
    }
    const to = (cust.email ?? "").trim();
    if (!EMAIL_RE.test(to)) {
      plan.skippedNoEmail++;
      continue;
    }
    if (taken.has(cust.id)) {
      plan.heldForCustomer++;
      plan.heldKeys.push(c.dedupeKey);
      continue;
    }
    const rule = rules.get(c.kind)!;
    const message = renderTemplate(rule.template ?? "", {
      customer: greetingName(cust),
      amount: c.amount,
      title: c.title,
      date: c.date,
    });
    if (!message.trim()) continue;
    const { text, html } = composeBody(message, c.extra, input.company);
    taken.add(cust.id);
    plan.emails.push({
      kind: c.kind,
      dedupeKey: c.dedupeKey,
      targetId: c.targetId,
      customerId: cust.id,
      customerName: displayName(cust),
      to,
      subject: c.subject,
      text,
      html,
      record: recordLine(c.kind, c.title, c.date),
      jobId: c.jobId,
      estimateId: c.estimateId,
      dueDay: c.dueDay,
    });
  }
  return plan;
}

/**
 * The message-thread copy of an automatic email: what was sent, never
 * the amount, the line items or the owner's template (which may hold
 * {amount}). Crew without "see money" can read the thread.
 */
export function recordLine(kind: RuleKind, title: string, date = ""): string {
  const t = title.trim();
  switch (kind) {
    case "invoice_send":
      return t ? `Automatic email: invoice ${t} sent` : "Automatic email: invoice sent";
    case "invoice_reminder":
      return `Automatic email: payment reminder for ${t || "an invoice"}`;
    case "overdue_escalation":
      return `Automatic email: past-due notice for ${t || "an invoice"}`;
    case "thank_you":
      return `Automatic email: thank you for paying ${t || "an invoice"}`;
    case "review_request":
      return "Automatic email: review request";
    case "estimate_reminder":
      return `Automatic email: estimate reminder (${t || "estimate"})`;
    case "job_reminder":
      return `Automatic email: job reminder${date ? ` for ${date}` : ""}`;
    case "phc_renewal":
      return `Automatic email: plant health care renewal${date ? ` on ${date}` : ""}`;
    default:
      return "Automatic email sent";
  }
}

/** How many of the plan may go now, given what was already sent today. */
export function allowedNow(sentToday: number): number {
  return Math.max(0, Math.min(MAX_PER_RUN, MAX_PER_DAY - Math.max(0, sentToday)));
}

/** The "Send a test to me" email: every rule's message with sample values. */
export function composeTestEmail(
  rules: RuleRow[],
  company: CompanyProfile | null,
  masterOn: boolean,
  today: string,
): { subject: string; text: string; html: string } {
  const sample = { customer: "Sample Customer", amount: "$1,250", title: "INV-1040", date: niceDate(addDays(today, 1)) };
  const known = rules.filter((r) => (RULE_KINDS as string[]).includes(r.kind) && !NEVER_AUTOMATIC.has(r.kind));
  const parts = known.map((r) => {
    const state = r.enabled ? "On" : "Off";
    return `${(r.label ?? r.kind).trim()} (${state}):\n${renderTemplate(r.template ?? "", sample)}`;
  });
  const intro =
    `This is a test. Only you get it: no customer was emailed.\n` +
    `Automatic customer emails are ${masterOn ? "ON" : "OFF"}.\n` +
    `Below is what each rule's email says, with sample values.`;
  const { text, html } = composeBody([intro, ...parts].join("\n\n"), "", company);
  return { subject: "Test: automatic customer emails", text, html };
}

// ---------- "Done" invoices (stage 3) ----------

/** Wording when the office has not edited the "Auto-send invoices" rule. */
export const DEFAULT_INVOICE_TEMPLATE =
  "Hi {customer}, thank you for choosing us! Your invoice {title} for {amount} is below. It is due {date}.";

/** An invoice the database made when its job was marked done. */
export interface AutoInvoiceRow extends InvoiceRow {
  auto_send_at?: string | null;
}

/** "on receipt" when due the day it was issued, else "Monday, November 16". */
export function dueText(issued: string, due: string): string {
  if (!due) return "on receipt";
  if (issued && due.slice(0, 10) <= issued.slice(0, 10)) return "on receipt";
  return `by ${niceDate(due)}`;
}

/**
 * The email for an invoice made by "Done": the rule's message, the line
 * items and total, how to pay (Zelle / check from the company profile),
 * an optional link to view it online, signature and opt-out line.
 */
export function composeInvoiceEmail(
  invoice: AutoInvoiceRow,
  customer: CustomerRow,
  template: string | null | undefined,
  company: CompanyProfile | null,
  viewUrl: string | null = null,
): { subject: string; text: string; html: string } {
  const number = (invoice.number ?? "").trim() || "invoice";
  const total = invoiceTotal(invoice);
  const issued = dayOf(invoice.issued_date);
  const due = dayOf(invoice.due_date);
  const when = dueText(issued, due);
  const message = renderTemplate((template ?? "").trim() || DEFAULT_INVOICE_TEMPLATE, {
    customer: greetingName(customer),
    amount: money(total),
    title: number,
    date: when,
  });
  const lines = (invoice.lines ?? []).map((l) => {
    const q = num(l.quantity);
    const p = num(l.unitPrice);
    const what = (l.description ?? "").trim() || "Work";
    return q === 1 ? `- ${what}: ${money(p)}` : `- ${what}: ${q} x ${money(p)} = ${money(q * p)}`;
  });
  const extra = [
    `Invoice ${number}`,
    ...lines,
    `Total: ${money(total)}`,
    `Due ${when}.`,
    viewUrl ? `\nView it online: ${viewUrl}` : "",
    "",
    howToPay(number, company),
  ]
    .join("\n")
    .trim();
  const { text, html } = composeBody(message, extra, company);
  return { subject: `Invoice ${number}: ${money(total)}`, text, html };
}
