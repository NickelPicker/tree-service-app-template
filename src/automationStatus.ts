/**
 * Automations page status: the last run of the hourly automatic-email
 * check, what was sent recently, and "Send a test to me".
 *
 * The run-automations edge function writes automation_runs and
 * automation_sends; office staff can read both (row-level security).
 * In demo mode (no Supabase project) there is nothing to show.
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";

export interface AutomationRun {
  startedAt: string;
  gmailReady: boolean;
  switchedOn: boolean;
  outcome: string;
  sent: number;
  failed: number;
  skipped: number;
  waiting: number;
  /** Held back by test mode (no try used; they go once test mode is off). */
  blocked?: number;
}

export interface AutomationSend {
  id: string;
  ruleKind: string;
  customerId: string;
  customerName: string;
  status: "sending" | "sent" | "failed";
  createdAt: string;
  sentAt: string | null;
}

export interface AutomationStatus {
  /** Newest scheduled run, or null before the first one. */
  lastRun: AutomationRun | null;
  /** Newest run of any kind that knew whether Gmail is set up. */
  gmailReady: boolean | null;
  /** Sends in the last 30 days, newest first (at most 100). */
  recent: AutomationSend[];
  /** Emails sent in the last 7 days (from `recent`). */
  sentLast7Days: number;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

type Row = Record<string, unknown>;

export function runFromRow(r: Row): AutomationRun {
  return {
    startedAt: String(r.started_at ?? ""),
    gmailReady: r.gmail_ready === true,
    switchedOn: r.switched_on === true,
    outcome: String(r.outcome ?? ""),
    sent: count(r.sent),
    failed: count(r.failed),
    skipped: count(r.skipped),
    waiting: count(r.waiting),
    blocked: count(r.blocked),
  };
}

export function sendFromRow(r: Row): AutomationSend {
  const status = r.status === "sent" || r.status === "failed" ? r.status : "sending";
  return {
    id: String(r.id ?? ""),
    ruleKind: String(r.rule_kind ?? ""),
    customerId: String(r.customer_id ?? ""),
    customerName: String(r.customer_name ?? ""),
    status,
    createdAt: String(r.created_at ?? ""),
    sentAt: typeof r.sent_at === "string" ? r.sent_at : null,
  };
}

/** Plain-English line for the last run. */
export function runOutcomeText(run: AutomationRun | null): string {
  if (!run) return "Not checked yet. Checks every hour.";
  switch (run.outcome) {
    case "waiting-for-gmail":
      return run.waiting > 0
        ? `Waiting for Gmail: nothing was sent. ${run.waiting} emails wait for your approval below.`
        : "Waiting for Gmail: nothing was sent.";
    case "switched-off":
      return "Automatic customer emails are off: nothing was sent.";
    case "quiet-hours":
      return "Outside sending hours (8 AM to 6 PM): nothing was sent.";
    case "daily-limit":
      return `Daily limit reached: ${run.waiting} waiting for tomorrow.`;
    case "error":
      return "Something went wrong on the last check. It tries again next hour.";
    case "needs-approval":
      return `${run.waiting} emails were due at once (more than 3), so none were sent. They wait for you below.`;
    case "gmail-refused":
      return "Gmail refused to send (check the Gmail app password, or the daily Gmail limit was reached). Nothing was lost: it tries again next hour.";
    case "done": {
      const parts = [`Sent ${run.sent}`];
      if (run.failed) parts.push(`${run.failed} failed (tried again later)`);
      if (run.waiting) parts.push(`${run.waiting} waiting for the next hour`);
      if (run.skipped) parts.push(`${run.skipped} skipped (no email or "No automatic emails")`);
      if (run.blocked) parts.push(`${run.blocked} held back by test mode (they go once test mode is off)`);
      return parts.join(", ") + ".";
    }
    default:
      return "Still running.";
  }
}

export async function loadAutomationStatus(): Promise<AutomationStatus | null> {
  if (!supabase) return null;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const cols = "started_at,gmail_ready,switched_on,outcome,sent,failed,skipped,waiting,blocked,kind,finished_at";
  const [last, any, sends] = await Promise.all([
    supabase
      .from("automation_runs")
      .select(cols)
      .eq("company_id", supabaseConfig.companyId)
      .eq("kind", "scheduled")
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("automation_runs")
      .select(cols)
      .eq("company_id", supabaseConfig.companyId)
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("automation_sends")
      .select("id,rule_kind,customer_id,customer_name,status,created_at,sent_at")
      .eq("company_id", supabaseConfig.companyId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (last.error || any.error || sends.error) return null;
  const lastRow = (last.data ?? [])[0] as Row | undefined;
  const anyRow = (any.data ?? [])[0] as Row | undefined;
  const recent = ((sends.data ?? []) as Row[]).map(sendFromRow);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return {
    lastRun: lastRow ? runFromRow(lastRow) : null,
    gmailReady: anyRow ? anyRow.gmail_ready === true : null,
    recent,
    sentLast7Days: recent.filter((x) => x.status === "sent" && x.createdAt >= weekAgo).length,
  };
}

export interface TestResult {
  sent: number;
  /** "demo" | "gmail-not-set-up" | "too-many-tests" | "error" */
  reason?: string;
}

export function parseTestReply(data: unknown): TestResult {
  if (!data || typeof data !== "object") return { sent: 0, reason: "error" };
  const d = data as Record<string, unknown>;
  const r: TestResult = { sent: count(d.sent) };
  if (typeof d.reason === "string" && d.reason) r.reason = d.reason;
  return r;
}

export function testResultText(r: TestResult): string {
  if (r.sent > 0) return "Test sent to the business Gmail inbox. No customer was emailed.";
  if (r.reason === "demo") return "Demo mode: no email sent.";
  if (r.reason === "gmail-not-set-up") return "Waiting for Gmail: the Gmail app password is not saved yet.";
  if (r.reason === "too-many-tests") return "That's a lot of tests: try again in an hour.";
  return "Could not send the test. Try again in a few minutes.";
}

/** Emails a sample of every rule to the business Gmail (never a customer). */
export async function sendAutomationTest(): Promise<TestResult> {
  if (!supabase) return { sent: 0, reason: "demo" };
  try {
    const { data, error } = await supabase.functions.invoke("run-automations", {
      body: { test: true, companyId: supabaseConfig.companyId },
    });
    if (error) {
      // A 429 still carries the reason in its body.
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        try {
          return parseTestReply(await ctx.json());
        } catch {
          /* fall through */
        }
      }
      return { sent: 0, reason: "error" };
    }
    return parseTestReply(data);
  } catch {
    return { sent: 0, reason: "error" };
  }
}

// ---------- Emails waiting for approval (more than 3 at once) ----------

/** One email the hourly check held back for the office (automation_batch_items). */
export interface HeldEmail {
  id: string;
  ruleKind: string;
  customerId: string;
  customerName: string;
  dueDay: string | null;
}

/** The company's open batch: "N emails are ready to send". */
export interface HeldBatch {
  id: string;
  createdAt: string;
  /** "waiting", or "sending" while "Send them" runs. */
  status: "waiting" | "sending";
  items: HeldEmail[];
}

export function heldEmailFromRow(r: Row): HeldEmail {
  return {
    id: String(r.id ?? ""),
    ruleKind: String(r.rule_kind ?? ""),
    customerId: String(r.customer_id ?? ""),
    customerName: String(r.customer_name ?? ""),
    dueDay: typeof r.due_day === "string" ? r.due_day : null,
  };
}

/** The open batch with its waiting emails, or null (none, demo mode, or no access). */
export async function loadHeldBatch(): Promise<HeldBatch | null> {
  if (!supabase) return null;
  const { data: batches, error } = await supabase
    .from("automation_batches")
    .select("id,status,created_at")
    .eq("company_id", supabaseConfig.companyId)
    .in("status", ["waiting", "sending"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const b = (batches ?? [])[0] as Row | undefined;
  if (!b) return null;
  const { data: items, error: itemsError } = await supabase
    .from("automation_batch_items")
    .select("id,rule_kind,customer_id,customer_name,due_day,created_at")
    .eq("batch_id", String(b.id))
    .eq("status", "waiting")
    .order("created_at")
    .limit(500);
  if (itemsError) return null;
  const list = ((items ?? []) as Row[]).map(heldEmailFromRow);
  if (list.length === 0) return null;
  return {
    id: String(b.id),
    createdAt: String(b.created_at ?? ""),
    status: b.status === "sending" ? "sending" : "waiting",
    items: list,
  };
}

export interface BatchSendResult {
  sent: number;
  failed: number;
  skipped: number;
  /** Still waiting in the batch (daily limit, one a day per customer, Gmail refused). */
  left: number;
  /** Of `left`: held back by test mode (they stay in the list). */
  blocked?: number;
  /** "demo" | "gmail-not-set-up" | "switched-off" | "quiet-hours" | "busy" | "nothing-to-send" | "daily-limit" | "gmail-refused" | "needs-confirm" | "error" */
  reason?: string;
}

export function parseBatchReply(data: unknown): BatchSendResult {
  if (!data || typeof data !== "object") return { sent: 0, failed: 0, skipped: 0, left: 0, reason: "error" };
  const d = data as Record<string, unknown>;
  const r: BatchSendResult = { sent: count(d.sent), failed: count(d.failed), skipped: count(d.skipped), left: count(d.left) };
  if (typeof d.reason === "string" && d.reason) r.reason = d.reason;
  if (count(d.blocked) > 0) r.blocked = count(d.blocked);
  return r;
}

export function batchResultText(r: BatchSendResult): string {
  switch (r.reason) {
    case "demo":
      return "Demo mode: no email sent.";
    case "gmail-not-set-up":
      return "Waiting for Gmail: the Gmail app password is not saved yet. Nothing was sent.";
    case "switched-off":
      return "Automatic customer emails are off: nothing was sent. Turn them on first.";
    case "quiet-hours":
      return "Outside sending hours (8 AM to 6 PM): nothing was sent. Try again after 8 AM.";
    case "busy":
      return "These are being sent already. Refresh in a minute.";
    case "nothing-to-send":
      return "Nothing left to send: these were already handled.";
    case "needs-confirm":
      return "Not sent: more than 3 emails need both \u201care you sure\u201d steps. Press Send them again.";
    case "error":
      if (r.sent === 0) return "Could not send them. Nothing was lost: try again in a few minutes.";
  }
  const parts = [`Sent ${r.sent}`];
  if (r.failed) parts.push(`${r.failed} failed (tried again next hour)`);
  if (r.skipped) parts.push(`${r.skipped} not sent (no longer due, already sent, or the customer said no)`);
  const blocked = Math.min(r.blocked ?? 0, r.left);
  if (blocked) parts.push(`${blocked} held back by test mode (only test addresses get emails)`);
  if (r.left - blocked > 0) {
    const why =
      r.reason === "gmail-refused"
        ? "Gmail refused to send"
        : r.reason === "daily-limit"
          ? "daily limit reached"
          : "the customer already got an email today";
    parts.push(`${r.left - blocked} still waiting (${why})`);
  }
  return parts.join(", ") + ".";
}

/** "Send them": sends exactly these approved emails (after the double confirm). */
export async function sendHeldBatch(
  batchId: string,
  itemIds: string[],
  /** How many emails the sender confirmed (the server refuses more than 3 without both confirms). */
  confirmed = itemIds.length,
): Promise<BatchSendResult> {
  if (!supabase) return { sent: 0, failed: 0, skipped: 0, left: 0, reason: "demo" };
  try {
    const { data, error } = await supabase.functions.invoke("run-automations", {
      body: { approve: true, companyId: supabaseConfig.companyId, batchId, itemIds, confirmed },
    });
    if (error) return { sent: 0, failed: 0, skipped: 0, left: 0, reason: "error" };
    return parseBatchReply(data);
  } catch {
    return { sent: 0, failed: 0, skipped: 0, left: 0, reason: "error" };
  }
}

/** "Don't send": these emails will not be sent. Returns how many, or null on an error. */
export async function discardHeldBatch(batchId: string, itemIds: string[]): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("discard_automation_batch", {
    p_batch_id: batchId,
    p_item_ids: itemIds,
  });
  if (error) return null;
  return typeof data === "number" ? data : 0;
}
