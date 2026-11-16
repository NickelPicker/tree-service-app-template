// run-automations — sends the automatic customer emails set up on the
// Automations page (invoice reminders, overdue escalation, estimate
// follow-ups, day-before job reminders, thank-you after payment, PHC
// renewal reminders) and the invoices the database made when a job was
// marked done ("Auto-send invoices"), once their 2-hour grace period is
// over (see the "done creates invoice" rules). Never a review request: those
// are asked only from the invoice email a person sends (send-invoice;
// plan.ts NEVER_AUTOMATIC).
//
// Two ways in, both POST:
//   1. The hourly schedule (.github/workflows/automations.yml) with
//      "Authorization: Bearer <service role key>". Anything else that
//      is not a signed-in staff test is refused (401).
//   2. "Send a test to me" from the app: { test: true, companyId } with
//      the caller's own login token. Office staff only. Emails ONLY the
//      business Gmail address (the owner), never a customer.
//   3. "Send them" from the app: { approve: true, companyId, batchId,
//      itemIds } with the caller's own login token (office staff only),
//      after the app's two "are you sure" steps. Sends exactly those
//      waiting batch items, re-checking every rule below.
//
// Business rule (the "mass emails wait for approval" rules): a scheduled run
// that would send MORE THAN 3 customer emails sends none of them; it
// holds them all in the company's batch for the office to approve on the
// Automations page (batch.ts). 1 to 3 go as before. Held or turned-down
// emails are never sent by a later scheduled run.
//
// Safe by default. A scheduled run sends nothing unless ALL of these hold:
//   - the Gmail app password secret exists (else "waiting-for-gmail"),
//   - the company's master switch "Automatic customer emails" is on,
//   - the rule's own switch is on,
//   - for a "Done" invoice: it is still 'waiting' (not stopped, edited or
//     reopened; or stuck in 'sending' for 30+ minutes after a check that
//     stopped half way) and its grace period is over, and it is not
//     split between payers (those only a person emails, one share per
//     payer, from the invoice; they go to "Needs invoice review"),
//   - it is 8:00 to 17:59 in Denver,
//   - the item came due on or after the day the master switch was turned on,
//   - the customer has an email and is not marked "No automatic emails",
//   - the customer got no automatic email in the last 20 hours,
//   - the sends log has no row for it (claim_automation_send),
//   - fewer than MAX_PER_DAY were sent in the last 24 hours (MAX_PER_RUN per run).
// If Gmail refuses the whole account (app password, connection, daily
// limit), the run stops at once and that email does not count as one of
// its 3 tries (outcome "gmail-refused"; see run-automations/steps.ts).
// Each email is recorded in the customer's message thread and the
// sends log (finish_automation_send). Replies return counts only and
// nothing is logged except counts.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase; GMAIL_APP_PASSWORD is set by the deploy.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { GMAIL_ADDRESS, gmailPassword, openMailer, type Mailer } from "../_shared/mail.ts";
import { emailDoneInvoice, emailPlanned, type Allowed, type Rpc, type Send } from "./steps.ts";
import { recipientAllowed } from "../_shared/testMode.ts";
import { isMassEmail } from "../_shared/massEmail.ts";
import {
  approvalActions,
  customerTakesEmail,
  decideRun,
  heldItems,
  invoiceKey,
  type BatchItemRow,
} from "./batch.ts";
import {
  CATCH_UP_DAYS,
  MAX_PER_DAY,
  REVIEW_GAP_DAYS,
  addDays,
  allowedNow,
  composeInvoiceEmail,
  composeTestEmail,
  displayName,
  inSendingHours,
  isSplitInvoice,
  localNow,
  planAutomaticEmails,
  type AutoInvoiceRow,
  type CompanyProfile,
  type CustomerRow,
  type EstimateRow,
  type InvoiceRow,
  type JobRow,
  type PhcRow,
  type RuleRow,
} from "./plan.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TESTS_PER_HOUR = 5;
const PAGE = 1000;

const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Constant-time string compare (no early exit on the first difference). */
function sameSecret(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function adminClient(serviceKey: string): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// deno-lint-ignore no-explicit-any
type Query = any;

/** Every row of a query, 1,000 at a time (the API returns at most 1,000). */
async function allRows<T>(make: () => Query): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) throw new Error("load failed");
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

interface SettingsRow {
  company_id: string;
  auto_emails: boolean | null;
  auto_emails_since: string | null;
  company_profile: CompanyProfile | null;
}

interface RunCounts {
  outcome: string;
  sent: number;
  failed: number;
  skipped: number;
  waiting: number;
  /** Not sent because test mode refuses the address (no try used; they go once test mode is off). */
  blocked: number;
}

/** Test mode's check for this run (_shared/testMode.ts, the same rule as mail.ts). */
function testModeAllows(): Allowed {
  const mode = Deno.env.get("EMAIL_TEST_MODE");
  const extra = Deno.env.get("EMAIL_TEST_RECIPIENTS");
  return (to: string) => recipientAllowed(to, mode, GMAIL_ADDRESS, extra);
}

async function startRun(db: SupabaseClient, companyId: string, kind: "scheduled" | "test" | "approved", gmailReady: boolean, on: boolean) {
  const { data } = await db
    .from("automation_runs")
    .insert({ company_id: companyId, kind, gmail_ready: gmailReady, switched_on: on })
    .select("id")
    .single();
  return (data?.id as string | undefined) ?? null;
}

async function finishRun(db: SupabaseClient, runId: string | null, c: RunCounts) {
  if (!runId) return;
  const finishedAt = new Date().toISOString();
  const { error } = await db
    .from("automation_runs")
    .update({ ...c, finished_at: finishedAt })
    .eq("id", runId);
  if (error) {
    // Older database without a newer count column (e.g. "blocked"): still
    // mark the run finished with the counts it can hold.
    const rest: Partial<RunCounts> = { ...c };
    delete rest.blocked;
    await db.from("automation_runs").update({ ...rest, finished_at: finishedAt }).eq("id", runId);
  }
}

/** Everything one company's check needs, loaded with the service role. */
interface CompanyData {
  rules: RuleRow[];
  invoiceRule: RuleRow | null;
  invoices: InvoiceRow[];
  estimates: EstimateRow[];
  jobs: JobRow[];
  phc: PhcRow[];
  dueInvoices: AutoInvoiceRow[];
  customers: CustomerRow[];
  byId: Map<string, CustomerRow>;
  /** Sends-log keys that may not go again. */
  done: Set<string>;
  sentToday: number;
  emailedRecently: Set<string>;
  reviewedRecently: Set<string>;
  /** Keys in an open batch (waiting for the office), with their batch item. */
  waitingKeys: Set<string>;
  /** Keys the office turned down ("Don't send"). */
  discardedKeys: Set<string>;
}

async function loadCompany(db: SupabaseClient, companyId: string, now: Date, today: string): Promise<CompanyData> {
  const rules = await allRows<RuleRow>(() =>
    db.from("automations").select("kind,enabled,timing_days,template,label").eq("company_id", companyId).order("id"),
  );
  const invoiceRule = rules.find((r) => r.kind === "invoice_send" && r.enabled === true) ?? null;

  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const custGap = new Date(now.getTime() - 20 * 3600_000).toISOString();
  const keyWindow = new Date(now.getTime() - (CATCH_UP_DAYS + 3) * 86_400_000).toISOString();
  const staleClaim = new Date(now.getTime() - 30 * 60_000).toISOString();
  const reviewWindow = new Date(now.getTime() - REVIEW_GAP_DAYS * 86_400_000).toISOString();

  const [recent, reviews, invoices, estimates, jobs, phc, dueInvoices, waiting, discarded] = await Promise.all([
    allRows<{ dedupe_key: string; customer_id: string; status: string; attempts: number; created_at: string }>(() =>
      db
        .from("automation_sends")
        .select("dedupe_key,customer_id,status,attempts,created_at")
        .eq("company_id", companyId)
        .gte("created_at", keyWindow)
        .order("id"),
    ),
    allRows<{ customer_id: string }>(() =>
      db
        .from("automation_sends")
        .select("customer_id")
        .eq("company_id", companyId)
        .eq("rule_kind", "review_request")
        .in("status", ["sent", "sending"])
        .gte("created_at", reviewWindow)
        .order("id"),
    ),
    allRows<InvoiceRow>(() =>
      db
        .from("invoices")
        .select(
          "id,number,customer_id,job_id,status,issued_date,due_date,paid_date,lines,tax_rate,discount_type,discount_value,auto_send_status,auto_created,email_queued_at,emailed_at,splits",
        )
        .eq("company_id", companyId)
        .order("id"),
    ),
    allRows<EstimateRow>(() =>
      db
        .from("estimates")
        .select("id,title,customer_id,status,created_date,email_queued_at,lines,options,accepted_option_id,tax_rate,discount_type,discount_value")
        .eq("company_id", companyId)
        .eq("status", "sent")
        .order("id"),
    ),
    allRows<JobRow>(() =>
      db
        .from("jobs")
        .select("id,title,customer_id,date,status")
        .eq("company_id", companyId)
        .eq("status", "scheduled")
        .gt("date", today)
        .lte("date", addDays(today, 370))
        .order("id"),
    ),
    allRows<PhcRow>(() =>
      db
        .from("phc_programs")
        .select("id,name,customer_id,status,renewal_date")
        .eq("company_id", companyId)
        .eq("status", "active")
        .gte("renewal_date", today)
        .order("id"),
    ),
    // Invoices made by "Done" whose 2-hour grace period is over.
    invoiceRule
      ? allRows<AutoInvoiceRow>(() =>
          db
            .from("invoices")
            .select("id,number,customer_id,job_id,status,issued_date,due_date,lines,tax_rate,discount_type,discount_value,auto_send_at,splits")
            .eq("company_id", companyId)
            // 'waiting', or stuck in 'sending' for 30+ minutes (a check stopped half way)
            .or(
              `auto_send_status.eq.waiting,and(auto_send_status.eq.sending,or(auto_send_claimed_at.is.null,auto_send_claimed_at.lt."${staleClaim}"))`,
            )
            .lte("auto_send_at", now.toISOString())
            .order("auto_send_at")
            .order("id"),
        )
      : Promise.resolve([] as AutoInvoiceRow[]),
    allRows<{ dedupe_key: string }>(() =>
      db.from("automation_batch_items").select("dedupe_key").eq("company_id", companyId).eq("status", "waiting").order("id"),
    ),
    allRows<{ dedupe_key: string }>(() =>
      db
        .from("automation_batch_items")
        .select("dedupe_key")
        .eq("company_id", companyId)
        .eq("status", "discarded")
        .gte("created_at", keyWindow)
        .order("id"),
    ),
  ]);

  // A failed send with tries left is not "done": it may go again.
  const done = new Set(recent.filter((r) => !(r.status === "failed" && r.attempts < 3)).map((r) => r.dedupe_key));
  const sentRecently = recent.filter((r) => r.status !== "failed");
  const sentToday = sentRecently.filter((r) => r.created_at >= dayAgo).length;
  const emailedRecently = new Set(sentRecently.filter((r) => r.created_at >= custGap).map((r) => r.customer_id));

  const ids = [...new Set([...invoices, ...estimates, ...jobs, ...phc].map((x) => x.customer_id).filter(Boolean))];
  const customers: CustomerRow[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const { data, error } = await db
      .from("customers")
      .select("id,first_name,last_name,company,company_name,email,no_auto_emails")
      .eq("company_id", companyId)
      .in("id", chunk);
    if (error) throw new Error("load failed");
    customers.push(...((data ?? []) as CustomerRow[]));
  }
  return {
    rules,
    invoiceRule,
    invoices,
    estimates,
    jobs,
    phc,
    // Never an invoice split between payers (only a person emails those;
    // auto_invoice_send_claim refuses them too).
    dueInvoices: dueInvoices.filter((inv) => !isSplitInvoice(inv)),
    customers,
    byId: new Map(customers.map((c) => [c.id, c])),
    done,
    sentToday,
    emailedRecently,
    reviewedRecently: new Set(reviews.map((r) => r.customer_id)),
    waitingKeys: new Set(waiting.map((r) => r.dedupe_key)),
    discardedKeys: new Set(discarded.map((r) => r.dedupe_key)),
  };
}

/** The reminder plan for a company (see plan.ts). */
function planFor(
  s: SettingsRow,
  d: CompanyData,
  today: string,
  done: Set<string>,
  emailedRecently: Set<string>,
  onlyKeys?: Set<string>,
) {
  return planAutomaticEmails({
    today,
    since: s.auto_emails_since,
    rules: d.rules,
    customers: d.customers,
    invoices: d.invoices,
    estimates: d.estimates,
    jobs: d.jobs,
    phc: d.phc,
    company: s.company_profile,
    emailedRecently,
    reviewedRecently: d.reviewedRecently,
    done,
    onlyKeys,
  });
}

async function runCompany(
  db: SupabaseClient,
  s: SettingsRow,
  password: string,
  getMailer: () => Mailer,
  now: Date,
  gmail: { refused: boolean },
): Promise<RunCounts> {
  const companyId = s.company_id;
  const on = s.auto_emails === true;
  const runId = await startRun(db, companyId, "scheduled", password !== "", on);
  const counts: RunCounts = { outcome: "done", sent: 0, failed: 0, skipped: 0, waiting: 0, blocked: 0 };
  try {
    const local = localNow(now);
    // Gmail missing: nothing is sent, but a mass batch is still put in
    // the review list so the office can see what would go.
    const noGmail = password === "";
    // A "Done" email stopped for a hand send that provably never went is
    // put back first (the rules below then decide whether it may go).
    await db.rpc("auto_invoice_restore_hand_stops", { p_company_id: companyId });
    // A "Done" email of an invoice the office has since split between
    // payers is never sent automatically: it is stopped (note 'split')
    // and the job goes to "Needs invoice review", whatever the switches.
    await db.rpc("auto_invoice_stop_split", { p_company_id: companyId });
    if (noGmail) counts.outcome = "waiting-for-gmail";
    else if (gmail.refused) counts.outcome = "gmail-refused"; // found by an earlier company this run
    if (!on) {
      // "Done" invoices waiting for their email are cancelled, not sent later.
      if (!noGmail) await db.rpc("auto_invoice_stop_unsendable", { p_company_id: companyId, p_allowed: false });
      if (counts.outcome === "done") counts.outcome = "switched-off";
    } else if (!inSendingHours(local.hour) && counts.outcome === "done") counts.outcome = "quiet-hours";
    if (gmail.refused || !on || !inSendingHours(local.hour)) {
      await finishRun(db, runId, counts);
      return counts;
    }
    const today = local.day;

    if (!noGmail) {
      // Due "Done" invoices that may not go any more (rule off, or 2+ days late) are stopped.
      const anyInvoiceRule = await db
        .from("automations")
        .select("id")
        .eq("company_id", companyId)
        .eq("kind", "invoice_send")
        .eq("enabled", true)
        .limit(1);
      await db.rpc("auto_invoice_stop_unsendable", {
        p_company_id: companyId,
        p_allowed: (anyInvoiceRule.data ?? []).length > 0,
      });
    }
    const d = await loadCompany(db, companyId, now, today);
    if (!d.rules.some((r) => r.enabled === true)) {
      await finishRun(db, runId, counts);
      return counts;
    }

    // Held for the office or turned down: never sent by an automatic run.
    const blocked = new Set([...d.waitingKeys, ...d.discardedKeys]);
    const done = new Set([...d.done, ...blocked]);
    // Test mode: an email to an address it refuses is left out here (not
    // claimed, no try used, not held for approval) and counted as blocked.
    const allowed = testModeAllows();
    const refusedByTestMode = (inv: AutoInvoiceRow) => {
      const c = d.byId.get(inv.customer_id);
      return !d.done.has(invoiceKey(inv.id)) && customerTakesEmail(c) && !allowed(String(c?.email ?? "").trim());
    };
    const invoicesAll = d.dueInvoices.filter((inv) => !blocked.has(invoiceKey(inv.id)));
    const invoicesNow = invoicesAll.filter((inv) => !refusedByTestMode(inv));
    counts.blocked = invoicesAll.length - invoicesNow.length;
    // What would really be emailed (an invoice already in the sends log
    // is only tidied up by emailDoneInvoice, never emailed again).
    const invoiceEmails = invoicesNow.filter(
      (inv) => !d.done.has(invoiceKey(inv.id)) && customerTakesEmail(d.byId.get(inv.customer_id)),
    );
    // A customer whose invoice goes this hour gets no reminder this hour.
    const emailedRecently = new Set([...d.emailedRecently, ...invoiceEmails.map((inv) => inv.customer_id)]);
    const fullPlan = planFor(s, d, today, done, emailedRecently);
    const plan = { ...fullPlan, emails: fullPlan.emails.filter((m) => allowed(m.to)) };
    counts.blocked += fullPlan.emails.length - plan.emails.length;
    counts.skipped += plan.skippedNoEmail + plan.skippedOptedOut;

    const budget = allowedNow(d.sentToday);
    const decision = decideRun(invoiceEmails.length + plan.emails.length, budget);
    if (decision === "hold") {
      // Owner's rule: more than 3 at once go only after two "are you sure"
      // steps on the Automations page. None of them is sent now.
      const items = heldItems(invoiceEmails, d.byId, plan, today, displayName);
      const { error } = await db.rpc("hold_automation_emails", { p_company_id: companyId, p_items: items });
      if (error) throw new Error("hold failed");
      counts.waiting = items.length;
      if (counts.outcome === "done") counts.outcome = "needs-approval";
      await finishRun(db, runId, counts);
      return counts;
    }
    if (noGmail) {
      await finishRun(db, runId, counts);
      return counts;
    }

    let attempted = 0;
    const rpc: Rpc = (fn, args) => db.rpc(fn, args);
    const send: Send = (m) => getMailer().sendDetailed(m);
    const priorStatus = priorStatusOf(db, companyId);

    // 1. "Done" invoices first: the customer is expecting them.
    for (const inv of invoicesNow) {
      if (attempted >= budget || gmail.refused) break;
      const step = await sendDoneInvoice(rpc, companyId, inv, d, s, send, priorStatus, allowed);
      if (step === "skipped") counts.skipped++;
      if (step === "blocked-test-mode") counts.blocked = counts.blocked + 1;
      if (step === "sent" || step === "failed" || step === "account") attempted++;
      if (step === "sent") counts.sent++;
      else if (step === "failed") counts.failed++;
      else if (step === "account") gmail.refused = true;
    }

    // 2. The reminder rules.
    const invoiceAttempts = attempted;
    for (const m of plan.emails) {
      if (attempted >= budget || gmail.refused) break;
      const step = await emailPlanned(rpc, companyId, m, send, allowed);
      if (step === "taken") continue; // already sent or being sent elsewhere
      if (step === "blocked-test-mode") {
        counts.blocked = counts.blocked + 1;
        continue;
      }
      attempted++;
      if (step === "sent") counts.sent++;
      else if (step === "failed") counts.failed++;
      else gmail.refused = true;
    }
    counts.waiting = Math.max(0, plan.emails.length - (attempted - invoiceAttempts));
    if (decision === "daily-limit") counts.outcome = "daily-limit";
    // Gmail refused the account: nothing counted as a try; next hour tries again.
    if (gmail.refused) counts.outcome = "gmail-refused";
  } catch {
    counts.outcome = "error";
  }
  await finishRun(db, runId, counts);
  return counts;
}

function priorStatusOf(db: SupabaseClient, companyId: string) {
  return async (dedupeKey: string) => {
    const { data: prior, error } = await db
      .from("automation_sends")
      .select("status")
      .eq("company_id", companyId)
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    if (error) throw new Error("load failed");
    return (prior?.status as string | undefined) ?? null;
  };
}

function sendDoneInvoice(
  rpc: Rpc,
  companyId: string,
  inv: AutoInvoiceRow,
  d: CompanyData,
  s: SettingsRow,
  send: Send,
  priorStatus: (k: string) => Promise<string | null>,
  allowed: Allowed,
) {
  const cust = d.byId.get(inv.customer_id);
  return emailDoneInvoice(
    rpc,
    companyId,
    { id: inv.id, number: inv.number ?? null, jobId: inv.job_id ?? null, customer: cust, customerName: cust ? displayName(cust) : "" },
    () => composeInvoiceEmail(inv, cust!, d.invoiceRule?.template, s.company_profile, null),
    send,
    priorStatus,
    allowed,
  );
}

/**
 * "Send them" on the Automations page: a signed-in office member sends
 * exactly the batch items they approved (after the app's two "are you
 * sure" steps). Every rule is checked again: Gmail, master switch,
 * sending hours, rule switches, opt-outs, the sends log, the daily
 * limit and one email a day per customer. Items no longer due are
 * skipped; items held by the daily limit or the per-customer rule stay
 * in the batch for later.
 */
async function approveRun(
  req: Request,
  authHeader: string,
  companyId: string,
  batchId: string,
  itemIds: string[],
  confirmed: number,
  serviceKey: string,
): Promise<Response> {
  const caller = await staffCaller(req, authHeader, companyId);
  if (caller instanceof Response) return caller;
  // Owner's rule: more than 3 emails at once only after the app's two
  // "are you sure" steps, which send the number confirmed. Checked here
  // too, like send-invoice and send-day-plan.
  if (isMassEmail(itemIds.length) && confirmed < itemIds.length) {
    return reply(200, { sent: 0, failed: 0, skipped: 0, left: itemIds.length, reason: "needs-confirm", count: itemIds.length });
  }

  const db = adminClient(serviceKey);
  const password = gmailPassword();
  const result = { sent: 0, failed: 0, skipped: 0, left: 0 };
  if (password === "") return reply(200, { ...result, reason: "gmail-not-set-up" });
  const { data: sRow } = await db
    .from("settings")
    .select("company_id,auto_emails,auto_emails_since,company_profile")
    .eq("company_id", companyId)
    .maybeSingle();
  const s = sRow as SettingsRow | null;
  if (!s || s.auto_emails !== true) return reply(200, { ...result, reason: "switched-off" });
  const now = new Date();
  const local = localNow(now);
  if (!inSendingHours(local.hour)) return reply(200, { ...result, reason: "quiet-hours" });

  const { data: itemRows, error: itemsError } = await db
    .from("automation_batch_items")
    .select("id,rule_kind,dedupe_key,target_id,customer_id,status")
    .eq("company_id", companyId)
    .eq("batch_id", batchId)
    .eq("status", "waiting")
    .in("id", itemIds);
  if (itemsError) return reply(500, { error: "Could not load the emails." });
  const items = (itemRows ?? []) as BatchItemRow[];
  if (items.length === 0) return reply(200, { ...result, reason: "nothing-to-send" });

  const { data: claimed, error: claimError } = await db.rpc("automation_batch_claim", {
    p_batch_id: batchId,
    p_company_id: companyId,
    p_user: caller,
  });
  if (claimError) return reply(500, { error: "Could not start." });
  if (claimed !== true) return reply(200, { ...result, reason: "busy" });

  const runId = await startRun(db, companyId, "approved", true, true);
  const counts: RunCounts = { outcome: "done", sent: 0, failed: 0, skipped: 0, waiting: 0, blocked: 0 };
  let mailer: Mailer | null = null;
  try {
    const today = local.day;
    // Due "Done" invoices that may not go any more are stopped first.
    const rulesNow = await db
      .from("automations")
      .select("id")
      .eq("company_id", companyId)
      .eq("kind", "invoice_send")
      .eq("enabled", true)
      .limit(1);
    await db.rpc("auto_invoice_stop_unsendable", {
      p_company_id: companyId,
      p_allowed: (rulesNow.data ?? []).length > 0,
    });
    await db.rpc("auto_invoice_stop_split", { p_company_id: companyId });
    const d = await loadCompany(db, companyId, now, today);
    const approved = new Set(items.map((it) => it.dedupe_key));
    // Other waiting items (not approved here) and discarded ones never go.
    const done = new Set([
      ...d.done,
      ...d.discardedKeys,
      ...[...d.waitingKeys].filter((k) => !approved.has(k)),
    ]);
    // An approved invoice already in the sends log is tidied up by
    // emailDoneInvoice ("settled"), never emailed twice.
    const dueInvoices = new Map(
      d.dueInvoices.filter((inv) => approved.has(invoiceKey(inv.id))).map((inv) => [inv.id, inv]),
    );
    const invoiceCustomers = [...dueInvoices.values()]
      .filter((inv) => !d.done.has(invoiceKey(inv.id)) && customerTakesEmail(d.byId.get(inv.customer_id)))
      .map((inv) => inv.customer_id);
    const emailedRecently = new Set([...d.emailedRecently, ...invoiceCustomers]);
    const plan = planFor(s, d, today, done, emailedRecently, approved);
    const actions = approvalActions(items, new Set(dueInvoices.keys()), plan);
    const planned = new Map(plan.emails.map((m) => [m.dedupeKey, m]));

    const budget = allowedNow(d.sentToday);
    let attempted = 0;
    let refused = false;
    mailer = openMailer(password);
    const m0 = mailer;
    const rpc: Rpc = (fn, args) => db.rpc(fn, args);
    const send: Send = (m) => m0.sendDetailed(m);
    const priorStatus = priorStatusOf(db, companyId);
    const allowed = testModeAllows();
    const finishItem = (id: string, status: "sent" | "failed" | "skipped") =>
      db.rpc("automation_batch_item_finish", { p_item_id: id, p_status: status });

    // "Done" invoices first, then the reminders (same order as a scheduled run).
    const ordered = [
      ...items.filter((it) => it.rule_kind === "invoice_send"),
      ...items.filter((it) => it.rule_kind !== "invoice_send"),
    ];
    for (const it of ordered) {
      const action = actions.get(it.id) ?? "skip";
      if (action === "skip") {
        await finishItem(it.id, "skipped");
        counts.skipped++;
        continue;
      }
      if (action === "wait" || refused || attempted >= budget) {
        counts.waiting++;
        continue;
      }
      let step: string;
      if (it.rule_kind === "invoice_send") {
        step = await sendDoneInvoice(rpc, companyId, dueInvoices.get(it.target_id)!, d, s, send, priorStatus, allowed);
      } else {
        step = await emailPlanned(rpc, companyId, planned.get(it.dedupe_key)!, send, allowed);
      }
      if (step === "blocked-test-mode") {
        // Test mode: it stays in the batch, no try used.
        counts.blocked = counts.blocked + 1;
        counts.waiting++;
        continue;
      }
      if (step === "account") {
        // Gmail refused the whole account: this one stays in the batch.
        refused = true;
        counts.waiting++;
        continue;
      }
      if (step === "sent" || step === "failed") attempted++;
      if (step === "sent") {
        counts.sent++;
        await finishItem(it.id, "sent");
      } else if (step === "failed") {
        counts.failed++;
        await finishItem(it.id, "failed");
      } else {
        // taken / settled / skipped: not this call's to send
        counts.skipped++;
        await finishItem(it.id, "skipped");
      }
    }
    if (refused) counts.outcome = "gmail-refused";
    else if (counts.waiting > 0 && attempted >= budget) counts.outcome = "daily-limit";
  } catch {
    counts.outcome = "error";
  }
  mailer?.close();
  await db.rpc("automation_batch_release", { p_batch_id: batchId });
  await finishRun(db, runId, counts);
  return reply(200, {
    sent: counts.sent,
    failed: counts.failed,
    skipped: counts.skipped,
    left: counts.waiting,
    blocked: counts.blocked,
    ...(counts.outcome !== "done" ? { reason: counts.outcome } : {}),
  });
}

/** The signed-in caller's user id when they are office staff, else the refusal. */
async function staffCaller(req: Request, authHeader: string, companyId: string): Promise<string | Response> {
  const apiKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const asCaller = createClient(Deno.env.get("SUPABASE_URL")!, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser(authHeader.slice(7));
  if (userError || !userData?.user) return reply(401, { error: "Please sign in." });
  const { data: isStaff, error: staffError } = await asCaller.rpc("is_company_staff", { p_company_id: companyId });
  if (staffError) return reply(500, { error: "Could not check your access." });
  if (isStaff !== true) return reply(403, { error: "Only the office can do this." });
  return userData.user.id;
}

async function scheduledRun(serviceKey: string): Promise<Response> {
  const db = adminClient(serviceKey);
  // The 8 PM rule (the "crew day and 8pm clockout" rules): every open clock entry is
  // closed at 20:00 on its own day, for every company, whatever the
  // email switches. Never stops the email run (count only, no names).
  // A failure is reported in the reply (clockCloseFailed), so the
  // hourly workflow turns red.
  const closed = await db.rpc("close_open_clocks_at_8pm", { p_company_id: null });
  const clockCloseFailed = Boolean(closed.error);
  if (clockCloseFailed) console.warn("run-automations: the 8 PM clock close failed");
  const clocksClosed = clockCloseFailed ? 0 : Number(closed.data ?? 0);
  const password = gmailPassword();
  const { data, error } = await db
    .from("settings")
    .select("company_id,auto_emails,auto_emails_since,company_profile");
  if (error) return reply(500, { error: "Could not load settings." });

  let mailer: Mailer | null = null;
  const getMailer = () => (mailer ??= openMailer(password));
  const total = { companies: 0, sent: 0, failed: 0, skipped: 0, waiting: 0, blocked: 0, outcomes: [] as string[] };
  const now = new Date();
  // Same Gmail for every company: once it refuses the account, stop.
  const gmail = { refused: false };
  for (const s of (data ?? []) as SettingsRow[]) {
    const c = await runCompany(db, s, password, getMailer, now, gmail);
    total.companies++;
    total.sent += c.sent;
    total.failed += c.failed;
    total.skipped += c.skipped;
    total.waiting += c.waiting;
    total.blocked += c.blocked;
    if (!total.outcomes.includes(c.outcome)) total.outcomes.push(c.outcome);
  }
  (mailer as Mailer | null)?.close();
  // Keep the runs list short (one row per company per hour).
  await db.from("automation_runs").delete().lt("started_at", new Date(now.getTime() - 60 * 86_400_000).toISOString());
  if (total.failed > 0) console.warn(`run-automations: ${total.failed} emails failed`);
  if (gmail.refused) console.warn("run-automations: Gmail refused the account; stopped until next hour");
  return reply(200, { ...total, maxPerDay: MAX_PER_DAY, clocksClosed, clockCloseFailed });
}

async function testRun(req: Request, authHeader: string, companyId: string, serviceKey: string): Promise<Response> {
  const caller = await staffCaller(req, authHeader, companyId);
  if (caller instanceof Response) return caller;

  const db = adminClient(serviceKey);
  const password = gmailPassword();
  const { data: s } = await db
    .from("settings")
    .select("auto_emails,company_profile")
    .eq("company_id", companyId)
    .maybeSingle();
  const on = s?.auto_emails === true;

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db
    .from("automation_runs")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("kind", "test")
    .gte("started_at", hourAgo);
  if ((count ?? 0) >= TESTS_PER_HOUR) return reply(429, { sent: 0, reason: "too-many-tests" });

  const runId = await startRun(db, companyId, "test", password !== "", on);
  if (password === "") {
    await finishRun(db, runId, { outcome: "waiting-for-gmail", sent: 0, failed: 0, skipped: 0, waiting: 0, blocked: 0 });
    return reply(200, { sent: 0, reason: "gmail-not-set-up" });
  }
  const rules = await allRows<RuleRow>(() =>
    db.from("automations").select("kind,enabled,timing_days,template,label").eq("company_id", companyId).order("id"),
  );
  const email = composeTestEmail(rules, (s?.company_profile as CompanyProfile | null) ?? null, on, localNow(new Date()).day);
  const mailer = openMailer(password);
  const ok = await mailer.send({ to: GMAIL_ADDRESS, ...email });
  mailer.close();
  await finishRun(db, runId, { outcome: ok ? "done" : "error", sent: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: 0, waiting: 0, blocked: 0 });
  return reply(200, ok ? { sent: 1 } : { sent: 0, reason: "error" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey === "") return reply(500, { error: "Not configured." });
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply(401, { error: "Not allowed." });
  const token = authHeader.slice(7).trim();

  if (sameSecret(token, serviceKey)) return await scheduledRun(serviceKey);

  // Anything else must be a signed-in staff member asking for a test,
  // or sending a batch they approved ("Send them").
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return reply(401, { error: "Not allowed." });
  }
  const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
  if (!UUID_RE.test(companyId)) return reply(401, { error: "Not allowed." });
  if (body.test === true) return await testRun(req, authHeader, companyId, serviceKey);
  if (body.approve === true) {
    const batchId = typeof body.batchId === "string" ? body.batchId.trim() : "";
    const itemIds = Array.isArray(body.itemIds)
      ? [...new Set(body.itemIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))]
      : [];
    if (!UUID_RE.test(batchId) || itemIds.length === 0 || itemIds.length > 500) {
      return reply(400, { error: "Invalid request." });
    }
    const confirmed =
      typeof body.confirmed === "number" && Number.isFinite(body.confirmed) ? Math.max(0, Math.floor(body.confirmed)) : 0;
    return await approveRun(req, authHeader, companyId, batchId, itemIds, confirmed, serviceKey);
  }
  return reply(401, { error: "Not allowed." });
});
