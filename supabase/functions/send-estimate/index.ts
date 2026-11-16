// send-estimate — "Email estimate" in the app really emails the customer.
//
// Called by a signed-in office staff member (their own login token)
// with { companyId, estimateId, again? }. It:
//   1. checks the login (getUser) and that it is office staff
//      (is_company_staff, run as the caller),
//   2. sends nothing while the Gmail app password is missing,
//   3. makes a private link (32 random bytes; only the SHA-256 is
//      stored, works 60 days, ends when the estimate changes) with
//      create_estimate_accept_link — the same unchanged estimate is
//      not emailed twice unless the office presses "Email again",
//   4. emails the estimate with a "Review and accept" button to
//      https://<site>/accept/<token>,
//   5. records the email in the sends log and the customer's message
//      thread (without the working link) and marks the estimate emailed.
// Limits: 60 estimate emails an hour per company, and nothing once the
// company's emails in the last 24 hours reach 400 (Gmail allows ~500).
// Replies carry no customer data; nothing about customers is logged.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase; GMAIL_APP_PASSWORD and ALLOWED_ORIGIN are set by
// the deploy.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { GMAIL_ADDRESS, gmailPassword, openMailer } from "../_shared/mail.ts";
import { recipientAllowed } from "../_shared/testMode.ts";
import { sha256Hex } from "../_shared/turnstile.ts";
import {
  acceptUrl,
  composeEstimateEmail,
  siteOrigin,
  tokenFromBytes,
  type CustomerEstimate,
  type PublicCompany,
} from "../_shared/estimateEmail.ts";

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
  const estimateId = typeof body.estimateId === "string" ? body.estimateId.trim() : "";
  const again = body.again === true;
  if (!UUID_RE.test(companyId) || estimateId === "" || estimateId.length > 100) {
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

  const origin = siteOrigin(allowedOrigin, req.headers.get("origin"));
  if (origin === "") return reply(200, { sent: 0, reason: "error" });

  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: est, error: estError } = await db
    .from("estimates")
    .select("id,customer_id,status")
    .eq("company_id", companyId)
    .eq("id", estimateId)
    .maybeSingle();
  if (estError) return reply(500, { sent: 0, reason: "error" });
  if (!est) return reply(200, { sent: 0, reason: "not-saved" });
  const { data: cust, error: custError } = await db
    .from("customers")
    .select("id,first_name,last_name,company,company_name,email")
    .eq("company_id", companyId)
    .eq("id", est.customer_id)
    .maybeSingle();
  if (custError) return reply(500, { sent: 0, reason: "error" });
  const to = String(cust?.email ?? "").trim();
  if (!cust || !EMAIL_RE.test(to)) return reply(200, { sent: 0, reason: "no-email" });

  // Test mode (testMode.ts, the owner's lock): mail.ts would refuse this
  // address anyway. Say so before a new link is made: making one ends
  // the customer's earlier, still-working link.
  if (!recipientAllowed(to, Deno.env.get("EMAIL_TEST_MODE"), GMAIL_ADDRESS, Deno.env.get("EMAIL_TEST_RECIPIENTS"))) {
    return reply(200, { sent: 0, reason: "blocked-test-mode" });
  }

  // Limits (counts only).
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: lastHour }, { count: lastDay }] = await Promise.all([
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("rule_kind", "estimate_sent").gte("created_at", hourAgo),
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).in("status", ["sent", "sending"]).gte("created_at", dayAgo),
  ]);
  if ((lastHour ?? 0) >= PER_HOUR) return reply(429, { sent: 0, reason: "too-many" });
  if ((lastDay ?? 0) >= PER_DAY_ALL) return reply(429, { sent: 0, reason: "daily-limit" });

  // 3. The private link.
  const token = tokenFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const { data: made, error: makeError } = await db.rpc("create_estimate_accept_link", {
    p_company_id: companyId,
    p_estimate_id: estimateId,
    p_token_hash: await sha256Hex(token),
    p_again: again,
  });
  if (makeError || !made) return reply(500, { sent: 0, reason: "error" });
  const status = String((made as Record<string, unknown>).status ?? "");
  if (status === "already-sent") {
    return reply(200, { sent: 0, reason: "already-sent", sentAt: (made as Record<string, unknown>).sent_at ?? null });
  }
  if (status === "accepted" || status === "closed") return reply(200, { sent: 0, reason: status });
  if (status !== "ok") return reply(200, { sent: 0, reason: "not-saved" });
  const linkId = String((made as Record<string, unknown>).link_id);
  const expiresAt = String((made as Record<string, unknown>).expires_at);

  // 4. What the customer sees (the same copy the public page shows).
  const forCustomer = (made as Record<string, unknown>).estimate as CustomerEstimate | undefined;
  const company = ((made as Record<string, unknown>).company as PublicCompany | undefined) ?? null;
  if (!forCustomer) return reply(500, { sent: 0, reason: "error" });

  const greeting =
    String(cust.first_name ?? "").trim() || String(cust.company_name ?? "").trim() || String(cust.company ?? "").trim();
  const customerName =
    [cust.first_name, cust.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") ||
    String(cust.company_name ?? "").trim() || String(cust.company ?? "").trim() || "Customer";
  const email = composeEstimateEmail({
    estimate: forCustomer,
    greeting,
    company,
    link: acceptUrl(origin, token),
    expiresAt,
  });

  // 5. Claim, send, record.
  const { data: sendId, error: claimError } = await db.rpc("claim_automation_send", {
    p_company_id: companyId,
    p_rule_kind: "estimate_sent",
    p_dedupe_key: `estimate_sent:${linkId}`,
    p_target_id: linkId,
    p_customer_id: cust.id,
    p_customer_name: customerName,
  });
  if (claimError || !sendId) return reply(500, { sent: 0, reason: "error" });

  const mailer = openMailer(password);
  const ok = await mailer.send({ to, subject: email.subject, text: email.text, html: email.html });
  mailer.close();
  await db.rpc("finish_automation_send", {
    p_send_id: sendId,
    p_ok: ok,
    p_body: email.recordText,
    p_job_id: null,
    p_estimate_id: estimateId,
    p_sender_name: "Estimate email",
  });
  if (!ok) return reply(200, { sent: 0, reason: "error" });
  return reply(200, { sent: 1, emailedAt: new Date().toISOString(), expiresAt });
});
