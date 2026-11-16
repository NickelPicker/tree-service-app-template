// send-day-plan — emails each crew member their day once the plan is saved.
//
// Called by the app (src/dayPlanEmail.ts) right after "Save day" with
// { date: "YYYY-MM-DD", companyId }. It:
//   1. signs in AS THE CALLER (their own login token), so row-level
//      security decides what can be read; the service_role key is never used,
//   2. refuses unless the caller is office staff (is_company_staff),
//   3. loads that day's jobs, crew, equipment and customer addresses,
//   4. sends each crew member on a job that day ONE email from the
//      business Gmail: their stops in order with arrival times,
//      directions, who else is there, what they drive and team notes.
// Returns counts only: { sent, skipped, unchanged, blocked, failed }
// (skipped = no email saved; blocked = held back by test mode; failed =
// Gmail refused it, or this exact email already failed 3 times).
// Never logs addresses or emails.
//
// Sends log (review): every day-plan email has an
// automation_sends row (kind 'day_plan', key day:person:content hash), so
//   - a crew member whose email would be exactly the same as the one
//     they already got is not emailed again ("unchanged"),
//   - at most DAY_PLAN_PER_HOUR day-plan emails an hour per company,
//   - they count toward the company's 400-in-24-hours total that the
//     estimate, invoice and automatic emails check.
// Only the sends log is written with the service role
// (claim_day_plan_sends / finish_day_plan_send); everything the email
// shows is still read as the caller.
//
// Business rule: more than 3 emails at once need the app's
// two "are you sure" steps. The app sends { confirmed: N } after both;
// a call that would email more than 3 people and more than it says were
// confirmed sends nothing: { sent: 0, reason: "needs-confirm", count }.
//
// Secret (set by the deploy workflow, never in src/):
//   GMAIL_APP_PASSWORD  the business Gmail's app password. Until it is
//                       set, nothing is sent: { sent: 0, reason: "gmail-not-set-up" }.
//   ALLOWED_ORIGIN      optional: the site's exact origin (default: any)
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { GMAIL_ADDRESS, gmailPassword, openMailer } from "../_shared/mail.ts";
import { recipientAllowed } from "../_shared/testMode.ts";
import { MASS_EMAIL_LIMIT } from "../_shared/massEmail.ts";
import {
  composeDayPlanEmails,
  dayPlanDedupeKey,
  dayPlanHashInput,
  planDayPlanSends,
  type AddressRow,
  type CrewRow,
  type CustomerRow,
  type EquipmentRow,
  type JobRow,
} from "./compose.ts";

const DAY_PLAN_PER_HOUR = 60;
const PER_DAY_ALL = 400;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
  const confirmed =
    typeof body.confirmed === "number" && Number.isFinite(body.confirmed) ? Math.max(0, Math.floor(body.confirmed)) : 0;
  if (!DATE_RE.test(date) || !UUID_RE.test(companyId)) {
    return reply(400, { error: "Invalid request." });
  }

  // The caller's own client: every query below runs under their
  // row-level security, exactly like the app.
  const apiKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await db.auth.getUser(authHeader.slice(7));
  if (userError || !userData?.user) return reply(401, { error: "Please sign in." });

  const { data: isStaff, error: staffError } = await db.rpc("is_company_staff", {
    p_company_id: companyId,
  });
  if (staffError) return reply(500, { error: "Could not check your access." });
  if (isStaff !== true) return reply(403, { error: "Only the office can email the day plan." });

  const password = gmailPassword();
  if (password === "") return reply(200, { sent: 0, skipped: 0, reason: "gmail-not-set-up" });

  const jobsRes = await db
    .from("jobs")
    .select(
      "id,title,date,end_date,start_time,status,customer_id,address_id,crew_ids,equipment_ids,equipment_drivers,crew_arrivals,team_notes,lat,lng",
    )
    .eq("company_id", companyId)
    .or(`date.eq.${date},and(date.lte.${date},end_date.gte.${date})`);
  if (jobsRes.error) return reply(500, { error: "Could not load the day's jobs." });
  // Finished jobs are not part of the day's plan (the board skips them too).
  const jobs = ((jobsRes.data ?? []) as JobRow[]).filter((j) => j.status !== "done");
  if (jobs.length === 0) return reply(200, { sent: 0, skipped: 0 });

  const customerIds = [...new Set(jobs.map((j) => j.customer_id).filter((x): x is string => !!x))];
  const [crewRes, equipRes, custRes, addrRes] = await Promise.all([
    db.from("crew").select("id,name,email").eq("company_id", companyId).eq("status", "active"),
    db.from("equipment").select("id,name").eq("company_id", companyId),
    customerIds.length
      ? db.from("customers").select("id,first_name,last_name,company_name,address,city,zip").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    customerIds.length
      ? db.from("customer_addresses").select("id,customer_id,street,city,state,zip,is_primary").in("customer_id", customerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (crewRes.error) return reply(500, { error: "Could not load the crew." });

  const { emails, skippedNoEmail } = composeDayPlanEmails({
    date,
    jobs,
    crew: (crewRes.data ?? []) as CrewRow[],
    // Equipment and addresses only make the email nicer; send without them on an error.
    equipment: (equipRes.error ? [] : equipRes.data ?? []) as EquipmentRow[],
    customers: (custRes.error ? [] : custRes.data ?? []) as CustomerRow[],
    addresses: (addrRes.error ? [] : addrRes.data ?? []) as AddressRow[],
  });

  if (emails.length === 0) return reply(200, { sent: 0, skipped: skippedNoEmail });

  // The sends log (service role, this company only).
  const log = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const keyed = await Promise.all(
    emails.map(async (m) => ({ m, key: dayPlanDedupeKey(date, m.crewId, await sha256Hex(dayPlanHashInput(m))) })),
  );
  // What the sends log knows about these exact emails.
  const { data: known, error: knownError } = await log
    .from("automation_sends")
    .select("dedupe_key,status,attempts")
    .eq("company_id", companyId)
    .eq("rule_kind", "day_plan")
    .in("dedupe_key", keyed.map((k) => k.key));
  if (knownError) return reply(500, { error: "Could not check earlier emails." });
  // Test mode is checked BEFORE claiming, so a held-back email uses no try
  // and does not count toward the hourly limit.
  const mode = Deno.env.get("EMAIL_TEST_MODE");
  const extra = Deno.env.get("EMAIL_TEST_RECIPIENTS");
  const plan = planDayPlanSends(
    keyed.map((k) => ({ ...k, to: k.m.to })),
    ((known ?? []) as { dedupe_key: string; status: string; attempts: number }[]).map((r) => ({
      dedupe_key: String(r.dedupe_key),
      status: String(r.status),
      attempts: Number(r.attempts) || 0,
    })),
    (to) => recipientAllowed(to, mode, GMAIL_ADDRESS, extra),
  );
  const { toSend, unchanged, blocked } = plan;
  if (toSend.length === 0) {
    return reply(200, { sent: 0, skipped: skippedNoEmail, unchanged, blocked, failed: plan.failed });
  }

  if (toSend.length > MASS_EMAIL_LIMIT && toSend.length > confirmed) {
    return reply(200, { sent: 0, skipped: 0, reason: "needs-confirm", count: toSend.length });
  }

  // Claim all of them in one call (limits counted with these included).
  const { data: claimData, error: claimError } = await log.rpc("claim_day_plan_sends", {
    p_company_id: companyId,
    p_items: toSend.map((k) => ({ key: k.key, crew_id: k.m.crewId })),
    p_per_hour: DAY_PLAN_PER_HOUR,
    p_per_day: PER_DAY_ALL,
  });
  if (claimError || !claimData || typeof claimData !== "object") {
    return reply(500, { error: "Could not record the emails." });
  }
  const claimReply = claimData as { refused?: string; claims?: Record<string, string | null> };
  if (claimReply.refused === "too-many" || claimReply.refused === "daily-limit") {
    return reply(200, { sent: 0, skipped: 0, reason: claimReply.refused });
  }
  const claims = claimReply.claims ?? {};

  const mailer = openMailer(password);
  let sent = 0;
  let failed = plan.failed;
  let taken = 0;
  try {
    for (const { m, key } of toSend) {
      const sendId = claims[key] ?? null;
      if (!sendId) {
        // Another press claimed it a moment ago (failed-3-times rows were
        // set aside above and never reach the claim).
        taken++;
        continue;
      }
      const ok = await mailer.send(m);
      if (ok) sent++;
      else failed++;
      await log.rpc("finish_day_plan_send", { p_send_id: sendId, p_ok: ok });
    }
  } finally {
    mailer.close();
  }
  // Counts only: no addresses, names or error text that could hold them.
  if (failed > 0) console.warn(`send-day-plan: ${failed} emails failed`);

  return reply(200, { sent, skipped: skippedNoEmail, unchanged: unchanged + taken, blocked, failed });
});
