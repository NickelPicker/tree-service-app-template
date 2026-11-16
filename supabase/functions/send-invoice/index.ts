// send-invoice — "Email invoice" in the app really emails the customer.
//
// Called by a signed-in office staff member (their own login token)
// with { companyId, invoiceId, askReview?, again? }. One email per call.
//   1. checks the login (getUser) and that it is office staff
//      (is_company_staff, run as the caller),
//   2. sends nothing while the Gmail app password is missing,
//   3. loads the invoice, the customer's email and the company profile
//      (service role, this company only),
//   4. an invoice already emailed is not emailed again unless the
//      office presses "Email again"; one being emailed automatically
//      right now is left alone; one still waiting for its automatic
//      "Done" email is stopped first (note 'sent-by-hand'), so the
//      customer never gets it twice,
//   5. emails the thank-you + full invoice + "How to pay" and, only when
//      the sender ticked "Ask for a review in this email" and the review
//      link is set, a "Review us" button (_shared/invoiceEmail.ts, the
//      same code as the app's preview),
//   6. records it in the sends log ('invoice_emailed') and the
//      customer's message thread (no amounts, no link) and marks the
//      invoice emailed (emailed_at, server only; email_queued_at too for
//      older app builds) — all in finish_automation_send, only when
//      Gmail accepted it. If Gmail does not take it, an automatic email
//      this call stopped is put back to waiting.
// Split invoices (several payers, business rule: "Each payer should
// get an invoice for the amount they are going to pay"): one email per
// payer, to that payer's own address only, with "Your share: $X"
// (_shared/splitShares.ts, the app's math) — see splitSend below.
// Limits: 60 invoice emails an hour per company, and nothing once the
// company's emails in the last 24 hours reach 400 (Gmail allows ~500).
// Replies carry no customer data; nothing about customers is logged.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase; GMAIL_APP_PASSWORD (only while the owner has
// GMAIL_SENDING on) and ALLOWED_ORIGIN are set by the deploy.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { GMAIL_ADDRESS, gmailPassword, openMailer } from "../_shared/mail.ts";
import { recipientAllowed } from "../_shared/testMode.ts";
import { isMassEmail } from "../_shared/massEmail.ts";
import { exactInvoiceTotal } from "../_shared/splitShares.ts";
import {
  lastSentByPayer,
  payerDedupeKey,
  planSplitSend,
  SPLIT_ID_RE,
  type PayerPlan,
} from "../_shared/splitInvoiceSend.ts";

import { composeReceiptEmail, planReceipts, receiptStates, type ReceiptRow } from "../_shared/paymentReceipt.ts";
import {
  claimRefused,
  composeInvoiceEmailByHand,
  invoiceDedupeKey,
  reviewLink,
  type InvoiceCompany,
  type InvoiceForEmail,
} from "../_shared/invoiceEmail.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PER_HOUR = 60;
const PER_DAY_ALL = 400;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply(401, { error: "Please sign in." });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Invalid request." });
  }
  const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId.trim() : "";
  const askReview = body.askReview === true;
  const again = body.again === true;
  // Split invoices: a payment receipt for the payers just marked paid
  // (or "Resend receipt" for one payer, with again).
  const receipt = body.receipt === true;
  // Split invoices: "Email again" for some payers only, and how many
  // emails the sender confirmed (the two-step confirm for more than 3).
  const onlyPayers = Array.isArray(body.splitIds) ? body.splitIds : [];
  const confirmed =
    typeof body.confirmed === "number" && Number.isFinite(body.confirmed) ? Math.max(0, Math.floor(body.confirmed)) : 0;
  if (!UUID_RE.test(companyId) || invoiceId === "" || invoiceId.length > 100 || invoiceId.includes(":")) {
    return reply(400, { error: "Invalid request." });
  }
  if (onlyPayers.length > 50 || onlyPayers.some((x) => typeof x !== "string" || !SPLIT_ID_RE.test(x))) {
    return reply(400, { error: "Invalid request." });
  }

  // 1. Office staff only (checked as the caller, under their own rules).
  const url = Deno.env.get("SUPABASE_URL")!;
  const apiKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const asCaller = createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser(authHeader.slice(7).trim());
  if (userError || !userData?.user) return reply(401, { error: "Please sign in." });
  const { data: isStaff, error: staffError } = await asCaller.rpc("is_company_staff", { p_company_id: companyId });
  if (staffError) return reply(500, { sent: 0, reason: "error" });
  if (isStaff !== true) return reply(403, { sent: 0, reason: "not-allowed" });

  // 2. Nothing without Gmail.
  const password = gmailPassword();
  if (password === "") return reply(200, { sent: 0, reason: "gmail-not-set-up" });

  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. The invoice, the customer and the company profile.
  const { data: inv, error: invError } = await db
    .from("invoices")
    .select("id,number,customer_id,job_id,status,issued_date,due_date,lines,tax_rate,discount_type,discount_value,splits,emailed_at,auto_send_status,auto_send_note")
    .eq("company_id", companyId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (invError) return reply(500, { sent: 0, reason: "error" });
  if (!inv) return reply(200, { sent: 0, reason: "not-saved" });
  const isSplit = Array.isArray(inv.splits) && inv.splits.length > 0;
  const { data: cust, error: custError } = await db
    .from("customers")
    .select("id,first_name,last_name,company,company_name,email")
    .eq("company_id", companyId)
    .eq("id", inv.customer_id)
    .maybeSingle();
  if (custError) return reply(500, { sent: 0, reason: "error" });
  const to = String(cust?.email ?? "").trim();
  if (!isSplit && (!cust || !EMAIL_RE.test(to))) return reply(200, { sent: 0, reason: "no-email" });
  const { data: settings, error: settingsError } = await db
    .from("settings")
    .select("company_profile")
    .eq("company_id", companyId)
    .maybeSingle();
  if (settingsError) return reply(500, { sent: 0, reason: "error" });
  const company = (settings?.company_profile as InvoiceCompany | null) ?? null;
  if (receipt) {
    if (!isSplit) return reply(200, { sent: 0, reason: "not-split" });
    return await receiptSend({ db, companyId, invoiceId, inv: inv as SplitInvoiceRow, company, again, onlyPayers, confirmed, password });
  }
  if (askReview && reviewLink(company?.reviewUrl) === "") return reply(200, { sent: 0, reason: "no-review-link" });
  if (isSplit) {
    return await splitSend({ db, companyId, invoiceId, inv: inv as SplitInvoiceRow, cust, company, askReview, again, onlyPayers, confirmed, password });
  }

  if (!cust) return reply(200, { sent: 0, reason: "no-email" });

  // 4. Not twice. emailed_at is set only by the database on a real send
  // (never by the app; email_queued_at is not proof of anything).
  // The automatic "Done" email's own sends-log row counts too: Gmail may
  // have taken it while the invoice was not yet marked sent (a check
  // that stopped half way), and then it must not go a second time.
  const { data: autoRow, error: autoRowError } = await db
    .from("automation_sends")
    .select("status,sent_at,created_at")
    .eq("company_id", companyId)
    .eq("dedupe_key", `invoice_send:${invoiceId}`)
    .maybeSingle();
  if (autoRowError) return reply(500, { sent: 0, reason: "error" });
  const emailedAt0 = String(inv.emailed_at ?? "");
  // 'sending' for over 30 minutes: that check died, maybe after Gmail
  // took it, so it counts as emailed ("Email again" still sends).
  const autoSendingFor = autoRow?.status === "sending" ? Date.now() - new Date(String(autoRow.created_at)).getTime() : -1;
  const autoMailed = autoRow?.status === "sent" || autoSendingFor > 30 * 60_000;
  const emailedBefore = emailedAt0 !== "" || inv.auto_send_status === "sent" || autoMailed;
  if (emailedBefore && !again) {
    return reply(200, { sent: 0, reason: "already-sent", sentAt: inv.emailed_at ?? autoRow?.sent_at ?? null });
  }
  if (inv.auto_send_status === "sending" || (autoSendingFor >= 0 && autoSendingFor <= 30 * 60_000)) {
    return reply(200, { sent: 0, reason: "auto-sending" });
  }

  // Test mode (testMode.ts, the owner's lock): mail.ts would refuse this
  // address anyway; say so plainly, before anything is logged.
  if (!recipientAllowed(to, Deno.env.get("EMAIL_TEST_MODE"), GMAIL_ADDRESS, Deno.env.get("EMAIL_TEST_RECIPIENTS"))) {
    return reply(200, { sent: 0, reason: "blocked-test-mode" });
  }

  // Limits (counts only).
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: lastHour }, { count: lastDay }] = await Promise.all([
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("rule_kind", "invoice_emailed").gte("created_at", hourAgo),
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).in("status", ["sent", "sending"]).gte("created_at", dayAgo),
  ]);
  if ((lastHour ?? 0) >= PER_HOUR) return reply(429, { sent: 0, reason: "too-many" });
  if ((lastDay ?? 0) >= PER_DAY_ALL) return reply(429, { sent: 0, reason: "daily-limit" });

  // 5. What the customer gets.
  const greeting =
    String(cust.first_name ?? "").trim() || String(cust.company_name ?? "").trim() || String(cust.company ?? "").trim();
  const customerName =
    [cust.first_name, cust.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") ||
    String(cust.company_name ?? "").trim() || String(cust.company ?? "").trim() || "Customer";
  const email = composeInvoiceEmailByHand({
    invoice: inv as InvoiceForEmail,
    greeting,
    company,
    askReview,
  });

  // 6. Claim. The key holds the last real send time, so a double press
  // sends once, and "Email again" after a real send is a new email.
  const dedupeKey = invoiceDedupeKey(invoiceId, inv.emailed_at);
  const { data: claimed, error: claimError } = await db.rpc("claim_automation_send", {
    p_company_id: companyId,
    p_rule_kind: "invoice_emailed",
    p_dedupe_key: dedupeKey,
    p_target_id: invoiceId,
    p_customer_id: cust.id,
    p_customer_name: customerName,
  });
  if (claimError) return reply(500, { sent: 0, reason: "error" });
  let sendId = claimed as string | null;
  if (!sendId) {
    // Not claimable: say why. A send stuck in 'sending' for over 30
    // minutes may have reached the customer (the function died before
    // recording it): an ordinary press never sends then; only "Email
    // again", after the on-page confirm, takes it over.
    const { data: row, error: rowError } = await db
      .from("automation_sends")
      .select("status,created_at")
      .eq("company_id", companyId)
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    if (rowError) return reply(500, { sent: 0, reason: "error" });
    const why = claimRefused(row?.status ?? null, row?.created_at ?? null, again);
    if (why !== "reclaim") return reply(200, { sent: 0, reason: why });
    const { data: reclaimed, error: reclaimError } = await db.rpc("reclaim_invoice_email", {
      p_company_id: companyId,
      p_dedupe_key: dedupeKey,
    });
    if (reclaimError) return reply(500, { sent: 0, reason: "error" });
    sendId = (reclaimed as string | null) ?? null;
    if (!sendId) return reply(200, { sent: 0, reason: "in-progress" });
  }

  // A still-waiting automatic "Done" email is stopped before this one
  // goes (both sides only move 'waiting', so whichever is first wins),
  // and put back if Gmail does not take this one. An earlier hand send
  // that stopped it and never went (it is still stopped 'sent-by-hand'
  // and the invoice was never emailed) counts as stopped by this send.
  let stoppedAuto =
    inv.auto_send_status === "stopped" && inv.auto_send_note === "sent-by-hand" && emailedAt0 === "";
  if (inv.auto_send_status === "waiting") {
    const { data: stopped, error: stopError } = await db
      .from("invoices")
      .update({ auto_send_status: "stopped", auto_send_note: "sent-by-hand" })
      .eq("company_id", companyId)
      .eq("id", invoiceId)
      .eq("auto_send_status", "waiting")
      .select("id");
    const fail = async (reason: string, status: number) => {
      await db.rpc("finish_automation_send", { p_send_id: sendId, p_ok: false });
      return reply(status, { sent: 0, reason });
    };
    if (stopError) return await fail("error", 500);
    stoppedAuto = Array.isArray(stopped) && stopped.length > 0;
    if (!stoppedAuto) {
      const { data: now, error: nowError } = await db
        .from("invoices")
        .select("auto_send_status")
        .eq("company_id", companyId)
        .eq("id", invoiceId)
        .maybeSingle();
      if (nowError || !now) return await fail("error", 500);
      if (now.auto_send_status === "sending") return await fail("auto-sending", 200);
      if (now.auto_send_status === "sent" && !again) return await fail("already-sent", 200);
    }
  }

  // 7. Send, record. finish_automation_send also marks the invoice
  // emailed (emailed_at) in the same transaction, only on success.
  const mailer = openMailer(password);
  const ok = await mailer.send({ to, subject: email.subject, text: email.text, html: email.html });
  mailer.close();
  if (!ok && stoppedAuto) {
    await db
      .from("invoices")
      .update({ auto_send_status: "waiting", auto_send_note: null })
      .eq("company_id", companyId)
      .eq("id", invoiceId)
      .eq("auto_send_status", "stopped")
      .eq("auto_send_note", "sent-by-hand");
  }
  const finish = () =>
    db.rpc("finish_automation_send", {
      p_send_id: sendId,
      p_ok: ok,
      p_body: email.recordText,
      p_job_id: inv.job_id ?? null,
      p_estimate_id: null,
      p_sender_name: "Invoice email",
    });
  const recorded = (r: { data: unknown; error: unknown }) => !r.error && typeof r.data === "string" && r.data !== "";
  if (!ok) {
    await finish();
    return reply(200, { sent: 0, reason: "error" });
  }
  // Gmail took it: record it (sends log 'sent', thread, emailed_at). One
  // retry; a retry that finds it already recorded (the first call worked
  // but its answer was lost) counts as recorded.
  let marked = recorded(await finish());
  if (!marked) marked = recorded(await finish());
  if (!marked) {
    const { data: row } = await db.from("automation_sends").select("status").eq("id", sendId).maybeSingle();
    marked = row?.status === "sent";
  }
  // Not recorded: the row stays 'sending'; a later ordinary press is
  // answered "may-have-sent", never sent again by itself.
  return reply(200, { sent: 1, emailedAt: new Date().toISOString(), review: email.hasReview, marked });
});

// ---------------------------------------------------------------------
// Split invoices: one email per payer.
// ---------------------------------------------------------------------

type Db = SupabaseClient;

interface SplitInvoiceRow extends InvoiceForEmail {
  id: string;
  status?: string | null;
  customer_id: string;
  job_id?: string | null;
  splits: unknown;
  emailed_at?: string | null;
  auto_send_status?: string | null;
  auto_send_note?: string | null;
}

interface PayerResult {
  /** The split id (the app shows the payer's name from its own copy). */
  id: string;
  sent: 0 | 1;
  reason?: string;
  /** False when Gmail took it but the database could not record it. */
  marked?: boolean;
}

/**
 * Every payer of a split invoice gets their own email: the invoice
 * (number, lines, total), "Your share: $X", How to pay and, only when
 * ticked, the "Review us" section. Each email goes to that payer's
 * address alone, so no payer sees another's email or share.
 *   - The shares must add up (splitsSendProblem): otherwise nothing is
 *     sent and the reply says why.
 *   - Per payer: a paid share, a missing email, a $0 share, an earlier
 *     real send (unless "Email again") or test mode means no email for
 *     that payer, with the reason.
 *   - More than 3 emails in one press need the app's two-step confirm
 *     ({ confirmed: N }); otherwise nothing is sent ("needs-confirm").
 *   - Every email counts toward the hourly and daily limits; when they
 *     would not all fit, none is sent. The payers' rows are claimed in one
 *     call (claim_invoice_payer_sends) that counts the limits with this
 *     press included, one press per company at a time.
 *   - A waiting automatic "Done" email is stopped (note 'split') and is
 *     never put back to waiting, even if no payer's email goes.
 *   - Each payer has their own sends-log row (key
 *     invoice_emailed:<invoice>:payer-<split id>:<their last send|first>);
 *     finish_automation_send sets invoices.emailed_at on the first one
 *     Gmail takes, so emailed_at means "at least one payer was emailed".
 */
async function splitSend(a: {
  db: Db;
  companyId: string;
  invoiceId: string;
  inv: SplitInvoiceRow;
  cust: Record<string, unknown> | null;
  company: InvoiceCompany | null;
  askReview: boolean;
  again: boolean;
  onlyPayers: string[];
  confirmed: number;
  password: string;
}): Promise<Response> {
  const { db, companyId, invoiceId, inv, company } = a;
  if (inv.auto_send_status === "sending") return reply(200, { sent: 0, reason: "auto-sending" });

  // Each payer's last real send (their own rows in the sends log).
  const { data: rows, error: rowsError } = await db
    .from("automation_sends")
    .select("dedupe_key,status,sent_at")
    .eq("company_id", companyId)
    .eq("rule_kind", "invoice_emailed")
    .eq("target_id", invoiceId)
    .limit(1000);
  if (rowsError) return reply(500, { sent: 0, reason: "error" });
  const lastSent = lastSentByPayer(invoiceId, (rows ?? []) as Array<{ dedupe_key: string; status: string; sent_at: string | null }>);

  const total = exactInvoiceTotal(inv.lines, inv.tax_rate, inv.discount_type, inv.discount_value);
  const mode = Deno.env.get("EMAIL_TEST_MODE");
  const extra = Deno.env.get("EMAIL_TEST_RECIPIENTS");
  const plan = planSplitSend({
    splits: inv.splits,
    total,
    again: a.again,
    only: a.onlyPayers,
    lastSent,
    allowed: (email) => recipientAllowed(email, mode, GMAIL_ADDRESS, extra),
    invoicePaid: inv.status === "paid",
  });
  if (!plan.ok) {
    return reply(200, { sent: 0, reason: plan.reason, ...(plan.reason === "split-shares" ? { detail: plan.detail } : {}) });
  }
  const results = new Map<string, PayerResult>(
    plan.payers.map((p) => [p.payer.id, { id: p.payer.id, sent: 0, ...(p.skip ? { reason: p.skip } : {}) }]),
  );
  const answer = (more: Record<string, unknown> = {}) => {
    const payers = [...results.values()];
    const sent = payers.filter((p) => p.sent === 1).length;
    const body: Record<string, unknown> = { sent, split: true, payers, ...more };
    if (sent > 0) {
      body.emailedAt = new Date().toISOString();
      body.marked = payers.every((p) => p.sent === 0 || p.marked !== false);
    } else if (!body.reason) {
      // Nobody emailed: the panel shows each payer's reason.
      body.reason = "no-payers";
    }
    return reply(200, body);
  };
  const count = plan.toSend.length;
  if (count === 0) return answer();
  // Owner's rule: more than 3 emails at once only after the two-step confirm.
  if (isMassEmail(count) && a.confirmed < count) {
    return reply(200, { sent: 0, reason: "needs-confirm", count });
  }

  // Limits, quick check first: every payer's email counts; all of them
  // must fit. The real check is in claim_invoice_payer_sends below.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: lastHour, error: hourError }, { count: lastDay, error: dayError }] = await Promise.all([
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("rule_kind", "invoice_emailed").gte("created_at", hourAgo),
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).in("status", ["sent", "sending"]).gte("created_at", dayAgo),
  ]);
  if (hourError || dayError) return reply(500, { sent: 0, reason: "error" });
  if ((lastHour ?? 0) + count > PER_HOUR) return reply(429, { sent: 0, reason: "too-many" });
  if ((lastDay ?? 0) + count > PER_DAY_ALL) return reply(429, { sent: 0, reason: "daily-limit" });

  // A still-waiting automatic "Done" email is stopped first (the hourly
  // run never sends a split invoice, and would stop it too). It stays
  // stopped whatever happens to the payers' emails: a split invoice is
  // only ever emailed by a person.
  if (inv.auto_send_status === "waiting") {
    const { data: stopped, error: stopError } = await db
      .from("invoices")
      .update({ auto_send_status: "stopped", auto_send_note: "split" })
      .eq("company_id", companyId)
      .eq("id", invoiceId)
      .eq("auto_send_status", "waiting")
      .select("id");
    if (stopError) return reply(500, { sent: 0, reason: "error" });
    if (!(Array.isArray(stopped) && stopped.length > 0)) {
      const { data: now } = await db
        .from("invoices")
        .select("auto_send_status")
        .eq("company_id", companyId)
        .eq("id", invoiceId)
        .maybeSingle();
      if (now?.auto_send_status === "sending") return reply(200, { sent: 0, reason: "auto-sending" });
    }
  }

  const customerName =
    [a.cust?.first_name, a.cust?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") ||
    String(a.cust?.company_name ?? "").trim() || String(a.cust?.company ?? "").trim() || "Customer";
  // Claim every payer's row in ONE call: presses of the company wait for
  // each other there, and the limits are counted with this press's
  // emails included (all or nothing), so two presses at once cannot both
  // slip under the limit.
  const keyOf = (p: PayerPlan) => payerDedupeKey(invoiceId, p.payer.id, p.lastSentAt);
  const { data: claimData, error: claimError } = await db.rpc("claim_invoice_payer_sends", {
    p_company_id: companyId,
    p_invoice_id: invoiceId,
    p_customer_id: String(inv.customer_id),
    p_items: plan.toSend.map((p) => ({
      key: keyOf(p),
      name: `${p.payer.name || "Payer"} (for ${customerName})`.slice(0, 200),
    })),
    p_per_hour: PER_HOUR,
    p_per_day: PER_DAY_ALL,
  });
  if (claimError || !claimData || typeof claimData !== "object") return reply(500, { sent: 0, reason: "error" });
  const claimReply = claimData as { refused?: string; claims?: Record<string, string | null> };
  if (claimReply.refused === "too-many" || claimReply.refused === "daily-limit") {
    return reply(429, { sent: 0, reason: claimReply.refused });
  }
  const claims = claimReply.claims ?? {};

  const mailer = openMailer(a.password);
  let accountRefused = false;
  try {
    for (const p of plan.toSend) {
      const r = results.get(p.payer.id)!;
      const claimed = claims[keyOf(p)] ?? null;
      if (accountRefused) {
        // Release the claim: this payer was never tried.
        if (claimed) await db.rpc("finish_automation_send", { p_send_id: claimed, p_ok: false });
        r.reason = "error";
        continue;
      }
      const outcome = await sendToPayer(db, companyId, invoiceId, inv, company, a.askReview, a.again, keyOf(p), claimed, p, mailer);
      if (outcome === "account") {
        // Gmail refused the whole account: nobody else is tried now.
        accountRefused = true;
        r.reason = "error";
      } else if (typeof outcome === "string") {
        r.reason = outcome;
      } else {
        r.sent = 1;
        if (!outcome.marked) r.marked = false;
      }
    }
  } finally {
    mailer.close();
  }
  const anySent = [...results.values()].some((r) => r.sent === 1);
  return answer({ review: anySent && a.askReview });
}

/** One payer: send (on their claimed row, or a stuck one taken over by Email again), record. A reason string when not sent. */
async function sendToPayer(
  db: Db,
  companyId: string,
  invoiceId: string,
  inv: SplitInvoiceRow,
  company: InvoiceCompany | null,
  askReview: boolean,
  again: boolean,
  dedupeKey: string,
  /** The send row claimed for this payer by claim_invoice_payer_sends, or null. */
  claimed: string | null,
  p: PayerPlan,
  mailer: ReturnType<typeof openMailer>,
): Promise<string | "account" | { marked: boolean }> {
  const email = composeInvoiceEmailByHand({
    invoice: inv,
    greeting: p.payer.name,
    company,
    askReview,
    share: {
      name: p.payer.name,
      amount: p.share,
      kind: p.payer.kind,
      ...(p.payer.kind === "percentage" ? { percent: p.payer.value } : {}),
    },
  });
  let sendId = claimed;
  if (!sendId) {
    const { data: row, error: rowError } = await db
      .from("automation_sends")
      .select("status,created_at")
      .eq("company_id", companyId)
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    if (rowError) return "error";
    const why = claimRefused(row?.status ?? null, row?.created_at ?? null, again);
    if (why !== "reclaim") return why;
    const { data: reclaimed, error: reclaimError } = await db.rpc("reclaim_invoice_email", {
      p_company_id: companyId,
      p_dedupe_key: dedupeKey,
    });
    if (reclaimError) return "error";
    sendId = (reclaimed as string | null) ?? null;
    if (!sendId) return "in-progress";
  }
  // To this payer's address only: one recipient, never a list.
  const result = await mailer.sendDetailed({ to: p.payer.email, subject: email.subject, text: email.text, html: email.html });
  const finish = () =>
    db.rpc("finish_automation_send", {
      p_send_id: sendId,
      p_ok: result === "sent",
      p_body: email.recordText,
      p_job_id: inv.job_id ?? null,
      p_estimate_id: null,
      p_sender_name: "Invoice email",
    });
  if (result !== "sent") {
    await finish();
    return result === "account" ? "account" : "error";
  }
  const recorded = (r: { data: unknown; error: unknown }) => !r.error && typeof r.data === "string" && r.data !== "";
  let marked = recorded(await finish());
  if (!marked) marked = recorded(await finish());
  if (!marked) {
    const { data: row } = await db.from("automation_sends").select("status").eq("id", sendId).maybeSingle();
    marked = row?.status === "sent";
  }
  return { marked };
}

// ---------------------------------------------------------------------
// Split invoices: a payment receipt for each payer marked paid.
// ---------------------------------------------------------------------

const RECEIPTS_PER_HOUR = 60;

/**
 * Owner: "I want the person who has paid to get a receipt of payment and
 * no further information if the other portions have been paid or not."
 * One receipt per payer per payment (_shared/paymentReceipt.ts): only
 * their own amount, the date, the invoice number and the company's
 * details. To that payer's address alone, through the normal mail path
 * (test mode applies). More than 3 at once need the two-step confirm.
 * All payers of a press are claimed in one call
 * (claim_payment_receipts: one per company at a time, limits counted
 * with this press included, all or nothing).
 */
async function receiptSend(a: {
  db: Db;
  companyId: string;
  invoiceId: string;
  inv: SplitInvoiceRow;
  company: InvoiceCompany | null;
  again: boolean;
  onlyPayers: string[];
  confirmed: number;
  password: string;
}): Promise<Response> {
  const { db, companyId, invoiceId, inv } = a;
  const { data: rows, error: rowsError } = await db
    .from("automation_sends")
    .select("dedupe_key,status,sent_at,created_at,attempts")
    .eq("company_id", companyId)
    .eq("rule_kind", "payment_receipt")
    .eq("target_id", invoiceId)
    .limit(1000);
  if (rowsError) return reply(500, { sent: 0, reason: "error" });
  const mode = Deno.env.get("EMAIL_TEST_MODE");
  const extra = Deno.env.get("EMAIL_TEST_RECIPIENTS");
  const plan = planReceipts({
    invoiceId,
    splits: inv.splits,
    total: exactInvoiceTotal(inv.lines, inv.tax_rate, inv.discount_type, inv.discount_value),
    only: a.onlyPayers,
    again: a.again,
    states: receiptStates(invoiceId, (rows ?? []) as ReceiptRow[]),
    allowed: (email) => recipientAllowed(email, mode, GMAIL_ADDRESS, extra),
  });
  if (!plan.ok) return reply(200, { sent: 0, receipt: true, reason: plan.reason });
  const results = new Map<string, PayerResult>(
    plan.payers.map((p) => [p.payer.id, { id: p.payer.id, sent: 0, ...(p.skip ? { reason: p.skip } : {}) }]),
  );
  const answer = () => {
    const payers = [...results.values()];
    const sent = payers.filter((p) => p.sent === 1).length;
    return reply(200, { sent, receipt: true, payers, ...(sent === 0 ? { reason: "no-payers" } : {}) });
  };
  const count = plan.toSend.length;
  if (count === 0) return answer();
  if (isMassEmail(count) && a.confirmed < count) {
    return reply(200, { sent: 0, receipt: true, reason: "needs-confirm", count });
  }
  const { data: claimData, error: claimError } = await db.rpc("claim_payment_receipts", {
    p_company_id: companyId,
    p_invoice_id: invoiceId,
    p_customer_id: String(inv.customer_id),
    p_items: plan.toSend.map((p) => ({ key: p.key, name: `${p.payer.name || "Payer"} (receipt)`.slice(0, 200) })),
    p_per_hour: RECEIPTS_PER_HOUR,
    p_per_day: PER_DAY_ALL,
  });
  if (claimError || !claimData || typeof claimData !== "object") return reply(500, { sent: 0, reason: "error" });
  const claimReply = claimData as { refused?: string; claims?: Record<string, string | null> };
  if (claimReply.refused === "too-many" || claimReply.refused === "daily-limit") {
    return reply(429, { sent: 0, receipt: true, reason: claimReply.refused });
  }
  const claims = claimReply.claims ?? {};
  // A key the claim refused: "already-sent" only when it really went or
  // is being sent; a failed one is reported as failed.
  const refusedKeys = plan.toSend.map((p) => p.key).filter((k) => !claims[k]);
  const failedKeys = new Set<string>();
  if (refusedKeys.length > 0) {
    const { data: refusedRows } = await db
      .from("automation_sends")
      .select("dedupe_key,status")
      .eq("company_id", companyId)
      .eq("rule_kind", "payment_receipt")
      .in("dedupe_key", refusedKeys);
    for (const row of (refusedRows ?? []) as { dedupe_key: string; status: string }[]) {
      if (row.status === "failed") failedKeys.add(String(row.dedupe_key));
    }
  }
  const mailer = openMailer(a.password);
  let accountRefused = false;
  try {
    for (const p of plan.toSend) {
      const r = results.get(p.payer.id)!;
      const sendId = claims[p.key] ?? null;
      if (!sendId) {
        // Already sent or being sent; or failed 3 times (Resend follows it).
        r.reason = failedKeys.has(p.key) ? "error" : "already-sent";
        continue;
      }
      if (accountRefused) {
        await db.rpc("finish_automation_send", { p_send_id: sendId, p_ok: false });
        r.reason = "error";
        continue;
      }
      const email = composeReceiptEmail({
        payerName: p.payer.name,
        amount: p.amount,
        paidDay: p.paidDay,
        invoiceNumber: String(inv.number ?? ""),
        company: a.company,
      });
      // To this payer's address only: one recipient, never a list.
      const result = await mailer.sendDetailed({ to: p.payer.email, subject: email.subject, text: email.text, html: email.html });
      const finish = () =>
        db.rpc("finish_automation_send", {
          p_send_id: sendId,
          p_ok: result === "sent",
          p_body: email.recordText,
          p_job_id: inv.job_id ?? null,
          p_estimate_id: null,
          p_sender_name: "Receipt email",
        });
      if (result !== "sent") {
        await finish();
        if (result === "account") accountRefused = true;
        r.reason = "error";
        continue;
      }
      r.sent = 1;
      const recorded = (x: { data: unknown; error: unknown }) => !x.error && typeof x.data === "string" && x.data !== "";
      let marked = recorded(await finish());
      if (!marked) marked = recorded(await finish());
      if (!marked) r.marked = false;
    }
  } finally {
    mailer.close();
  }
  return answer();
}
