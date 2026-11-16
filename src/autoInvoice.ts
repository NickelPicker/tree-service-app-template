/**
 * "Done" creates the invoice (the "done creates invoice" rules).
 *
 * The database makes the invoice when a job is marked done and, when
 * "Automatic customer emails" and "Auto-send invoices" are both on,
 * emails it after a 2-hour grace period. This file holds the app side:
 *   - the same "what cancels the email" rules applied to the screen
 *     right away (the database applies them for real),
 *   - the "Sends at 3:40 PM" wording,
 *   - Stop, and the Dashboard's "Needs invoice review" list.
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";
import type { AppState, Invoice } from "./types";
import { BUSINESS_TIME_ZONE } from "./businessSettings";

const AUTO_KEYS = ["autoCreated", "autoSendAt", "autoSendStatus", "autoSendNote", "autoSentAt"] as const;

function content(i: Invoice): string {
  const copy: Record<string, unknown> = { ...i };
  for (const k of AUTO_KEYS) delete copy[k];
  return JSON.stringify(copy);
}

/**
 * Mirrors the database's rules on the screen after a change: an edited
 * waiting invoice is stopped ("edited"); a job taken back from done
 * stops its waiting invoice ("reopened") — the database may instead
 * remove it (see reopenedJobWithAutoInvoice), which the reload after
 * the save shows. Returns `next` unchanged when nothing applies.
 */
export function applyAutoSendRules(prev: AppState, next: AppState): AppState {
  if (prev.invoices === next.invoices && prev.jobs === next.jobs) return next;
  const before = new Map(prev.invoices.map((i) => [i.id, i]));
  const reopened = new Set<string>();
  const deleted = new Set<string>();
  if (prev.jobs !== next.jobs) {
    const oldJobs = new Map(prev.jobs.map((j) => [j.id, j]));
    for (const j of next.jobs) {
      if (oldJobs.get(j.id)?.status === "done" && j.status !== "done") reopened.add(j.id);
    }
    const kept = new Set(next.jobs.map((j) => j.id));
    for (const j of prev.jobs) if (!kept.has(j.id)) deleted.add(j.id);
  }
  let changed = false;
  const invoices = next.invoices.map((i) => {
    if (i.autoSendStatus !== "waiting") return i;
    if (i.jobId && (reopened.has(i.jobId) || deleted.has(i.jobId))) {
      changed = true;
      return { ...i, autoSendStatus: "stopped" as const, autoSendNote: deleted.has(i.jobId) ? "job-deleted" : "reopened" };
    }
    const old = before.get(i.id);
    if (old && old !== i && content(old) !== content(i)) {
      changed = true;
      return { ...i, autoSendStatus: "stopped" as const, autoSendNote: "edited" };
    }
    return i;
  });
  return changed ? { ...next, invoices } : next;
}

/** The jobs this change marked done (the database may have made their invoice). */
export function jobsMarkedDone(prev: AppState, next: AppState): string[] {
  if (prev.jobs === next.jobs) return [];
  const oldJobs = new Map(prev.jobs.map((j) => [j.id, j]));
  return next.jobs
    .filter((j) => j.status === "done" && oldJobs.has(j.id) && oldJobs.get(j.id)?.status !== "done")
    .map((j) => j.id);
}

/** True when the change marked a job done (the database may have made an invoice). */
export function markedAJobDone(prev: AppState, next: AppState): boolean {
  return jobsMarkedDone(prev, next).length > 0;
}

/**
 * True when the change took a job back from done while this screen
 * holds an automatic invoice for it. The database removes that invoice
 * when nothing has happened to it yet (the "undo done removes fresh invoice" rules), so the
 * screen loads the real data once the save is through instead of
 * guessing.
 */
export function reopenedJobWithAutoInvoice(prev: AppState, next: AppState): boolean {
  if (prev.jobs === next.jobs) return false;
  const oldJobs = new Map(prev.jobs.map((j) => [j.id, j]));
  const reopened = new Set(
    next.jobs.filter((j) => oldJobs.get(j.id)?.status === "done" && j.status !== "done").map((j) => j.id),
  );
  if (reopened.size === 0) return false;
  return next.invoices.some((i) => i.autoCreated === true && i.jobId !== null && reopened.has(i.jobId));
}

/** "3:40 PM" in the business's time zone. */
export function clockText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE });
}

/** The business's date and hour for an instant. */
function denver(d: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) % 24 };
}

const STOP_REASONS: Record<string, string> = {
  stopped: "stopped by the office",
  edited: "the invoice was changed",
  reopened: "the job was reopened",
  "job-deleted": "the job was deleted",
  "another-invoice": "another invoice was made for the job",
  "switched-off": "automatic emails were off",
  "too-late": "it was more than 2 days late",
  "no-email": "the customer has no email address",
  "opted-out": "the customer is marked “No automatic emails”",
  failed: "Gmail did not accept it (3 tries)",
  "not-approved": "it was in a batch of more than 3 emails and the office chose “Don't send”",
  "sent-by-hand": "the office pressed Email invoice instead",
  split: "the invoice is split between payers; email each payer their share from the invoice",
};

/**
 * One plain line about the invoice's automatic email, or null when it
 * has none. `emailsOn` = master switch and "Auto-send invoices" both on.
 */
export function autoSendText(i: Invoice, emailsOn: boolean, now = new Date()): string | null {
  switch (i.autoSendStatus) {
    case "waiting": {
      if (!emailsOn) return "Waiting to be emailed, but automatic emails are off now: it will not be sent.";
      const at = i.autoSendAt ? new Date(i.autoSendAt) : null;
      if (!at || Number.isNaN(at.getTime())) return "Waiting to be emailed.";
      const when = denver(at);
      const today = denver(now).day;
      if (when.hour >= 18) return `Sends tomorrow morning (after 8 AM)`;
      if (when.hour < 8) return when.day === today ? "Sends at 8 AM" : "Sends tomorrow at 8 AM";
      return `Sends at ${clockText(i.autoSendAt!)}${when.day === today ? "" : " tomorrow"}`;
    }
    case "sending":
      return "Being emailed now.";
    case "sent":
      return i.autoSentAt ? `Emailed to the customer automatically at ${clockText(i.autoSentAt)}.` : "Emailed to the customer automatically.";
    case "stopped":
      return `Not emailed automatically: ${STOP_REASONS[i.autoSendNote ?? ""] ?? "stopped"}. Send it yourself when it is ready.`;
    default:
      return null;
  }
}

export const ALREADY_EMAILED = "It was already emailed or is being emailed now.";

export interface StopResult {
  /** Plain text for the office, or null when it was stopped. */
  error: string | null;
  /** True when the screen is out of date and should load the real data. */
  reload: boolean;
}

type Client = typeof supabase;

/**
 * Stop the automatic email of one invoice. Only a still-"waiting"
 * invoice can be stopped; when no row changed, the email already went
 * (or is going right now), so the caller reloads instead of showing
 * "stopped".
 */
export async function stopAutoSend(invoiceId: string, client: Client = supabase): Promise<StopResult> {
  if (!client) return { error: null, reload: false };
  const { data, error } = await client
    .from("invoices")
    .update({ auto_send_status: "stopped" })
    .eq("id", invoiceId)
    .eq("company_id", supabaseConfig.companyId)
    .eq("auto_send_status", "waiting")
    .select("id");
  if (error) return { error: "Could not stop it. Check your connection and try again.", reload: false };
  if (!Array.isArray(data) || data.length === 0) return { error: ALREADY_EMAILED, reload: true };
  return { error: null, reload: false };
}

export type ReviewReason =
  | "has_invoice"
  | "hourly"
  | "extra_costs"
  | "multi_day"
  | "recurring"
  | "no_estimate"
  | "no_price"
  | "split_invoice";

export interface InvoiceReview {
  id: string;
  jobId: string;
  customerId: string;
  reason: ReviewReason | string;
  createdAt: string;
}

export const REVIEW_REASONS: Record<string, string> = {
  has_invoice: "Already has an invoice",
  hourly: "Billed by the hour",
  extra_costs: "Materials or other costs on the job",
  multi_day: "Multi-day job marked done before its last day",
  recurring: "Repeating service",
  no_estimate: "No accepted estimate",
  no_price: "Estimate has no price",
  // The "split invoice emails" rules: the automatic "Done" email never goes to a
  // split invoice; a person emails each payer their share from the invoice.
  split_invoice: "Split between payers: email each payer their share from the invoice",
};

export function reviewFromRow(r: Record<string, unknown>): InvoiceReview {
  return {
    id: String(r.id ?? ""),
    jobId: String(r.job_id ?? ""),
    customerId: String(r.customer_id ?? ""),
    reason: String(r.reason ?? ""),
    createdAt: String(r.created_at ?? ""),
  };
}

/** The "Needs invoice review" list (office only; empty in demo mode). */
export async function loadInvoiceReviews(): Promise<InvoiceReview[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("invoice_reviews")
    .select("id,job_id,customer_id,reason,created_at")
    .eq("company_id", supabaseConfig.companyId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(reviewFromRow);
}

/** "Done" on a review item: it leaves the list. */
export async function dismissInvoiceReview(id: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("invoice_reviews").delete().eq("id", id);
  return !error;
}
