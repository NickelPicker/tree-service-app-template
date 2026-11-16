// notify-suggestion — one email to the business Gmail when a Sales
// person suggests a customer change (business rule: "When a
// suggestion comes in an email should be sent to
// business@example.com").
//
// Called by the app right after the suggestion is saved, as the Sales
// person (their own login token), with { companyId, requestId }. It:
//   1. checks the login (getUser) and reads the suggestion AS THE CALLER
//      (row-level security: a Sales login reads only its own), then
//      checks the caller wrote it, it is still pending and at most
//      15 minutes old,
//   2. sends nothing while the Gmail app password is missing,
//   3. at most 20 of these an hour per company, and nothing once the
//      company's emails in the last 24 hours reach 400,
//   4. one email per suggestion (sends log, kind
//      'customer_edit_suggested', dedupe key per suggestion id),
//   5. emails ONLY the business address (GMAIL_ADDRESS); the request
//      never names a recipient. The email holds that one customer's
//      name and the suggested fields before → after, and the note.
// The suggestion is already saved; a failed email never undoes it. The
// email is not put in the customer's message thread (it is internal).
// Replies carry no customer data; nothing about customers is logged.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase; GMAIL_APP_PASSWORD (only while the owner has
// GMAIL_SENDING on) and ALLOWED_ORIGIN are set by the deploy.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { GMAIL_ADDRESS, gmailPassword, openMailer } from "../_shared/mail.ts";
import { composeSuggestionEmail, customerName, notifyRefusal } from "./compose.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_HOUR = 20;
const PER_DAY_ALL = 400;
const KIND = "customer_edit_suggested";

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
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!UUID_RE.test(companyId) || !UUID_RE.test(requestId)) return reply(400, { error: "Invalid request." });

  // 1. The caller wrote this suggestion, just now, and it still waits.
  const url = Deno.env.get("SUPABASE_URL")!;
  const apiKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const asCaller = createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser(authHeader.slice(7).trim());
  if (userError || !userData?.user) return reply(401, { error: "Please sign in." });
  const { data: row, error: rowError } = await asCaller
    .from("customer_edit_requests")
    .select("id,company_id,customer_id,requested_user,requested_name,changes,note,status,created_at")
    .eq("company_id", companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (rowError) return reply(500, { sent: 0, reason: "error" });
  const refusal = notifyRefusal(row, userData.user.id, Date.now());
  if (refusal === "not-allowed") return reply(403, { sent: 0, reason: refusal });
  if (refusal !== "") return reply(200, { sent: 0, reason: refusal });

  // 2. Nothing without Gmail.
  const password = gmailPassword();
  if (password === "") return reply(200, { sent: 0, reason: "gmail-not-set-up" });

  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Limits (counts only).
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: lastHour, error: hourError }, { count: lastDay, error: dayError }] = await Promise.all([
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("rule_kind", KIND).gte("created_at", hourAgo),
    db.from("automation_sends").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).in("status", ["sent", "sending"]).gte("created_at", dayAgo),
  ]);
  if (hourError || dayError) return reply(500, { sent: 0, reason: "error" });
  if ((lastHour ?? 0) >= PER_HOUR) return reply(429, { sent: 0, reason: "too-many" });
  if ((lastDay ?? 0) >= PER_DAY_ALL) return reply(429, { sent: 0, reason: "daily-limit" });

  // That one customer (this company only) and its primary address.
  const customerId = String(row!.customer_id);
  const { data: cust, error: custError } = await db
    .from("customers")
    .select("id,first_name,last_name,company,company_name,phone,email,address,city,zip,gate_code,property_notes,notes")
    .eq("company_id", companyId)
    .eq("id", customerId)
    .maybeSingle();
  if (custError) return reply(500, { sent: 0, reason: "error" });
  if (!cust) return reply(200, { sent: 0, reason: "no-customer" });
  const { data: addr, error: addrError } = await db
    .from("customer_addresses")
    .select("street,city,state,zip")
    .eq("company_id", companyId)
    .eq("customer_id", customerId)
    .order("is_primary", { ascending: false })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (addrError) return reply(500, { sent: 0, reason: "error" });

  const email = composeSuggestionEmail({
    suggestion: row!,
    customer: cust,
    address: addr ?? null,
    appUrl: allowedOrigin.startsWith("https://") ? allowedOrigin : "",
  });

  // 4. One per suggestion.
  const { data: sendId, error: claimError } = await db.rpc("claim_automation_send", {
    p_company_id: companyId,
    p_rule_kind: KIND,
    p_dedupe_key: `${KIND}:${requestId}`,
    p_target_id: requestId,
    p_customer_id: customerId,
    p_customer_name: customerName(cust),
  });
  if (claimError) return reply(500, { sent: 0, reason: "error" });
  if (!sendId) return reply(200, { sent: 0, reason: "already-sent" });

  // 5. To the business address only.
  const mailer = openMailer(password);
  let ok = false;
  try {
    ok = await mailer.send({ to: GMAIL_ADDRESS, subject: email.subject, text: email.text, html: email.html });
  } finally {
    mailer.close();
  }
  // Internal email: recorded in the sends log only, not in the customer's thread.
  await db
    .from("automation_sends")
    .update(ok ? { status: "sent", sent_at: new Date().toISOString() } : { status: "failed" })
    .eq("id", sendId)
    .eq("status", "sending");
  return reply(200, ok ? { sent: 1 } : { sent: 0, reason: "error" });
});
