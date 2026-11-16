// estimate-accept — the public page /accept/<token> (no login).
//
// POST { action: "view", token }
//   -> { status, company, estimate?, greeting?, termsDays?, ... } for
//      THAT estimate only (estimate_accept_view: no phone, email,
//      address, internal notes or anything about other customers).
// POST { action: "accept", token, optionId, name, agree: true, turnstileToken }
//   -> { status: "accepted", optionLabel } or a plain-English error.
//
// Accepting: checks Turnstile (like book-estimate), validates every
// field, rate-limits by a hash of the connection (30 looks and 10
// accept tries an hour; 20 accept tries a day per link), then
// accept_estimate_by_link marks the estimate accepted (option, typed
// name, time; no IP address is stored), writes the history and a
// message in the customer's thread. Then, when Gmail is set up, the
// business Gmail and each manager login (Sam;
// estimate_heads_up_recipients) get a heads-up ("<customer> accepted
// ... — call to schedule"). The customer is NOT emailed (business rule). The estimate waits in Schedule → "To schedule" and on the Dashboard
// ("Accepted online — call to schedule").
//
// The token is never stored or logged; only its SHA-256 is looked up.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase;
// TURNSTILE_SECRET_KEY, GMAIL_APP_PASSWORD and ALLOWED_ORIGIN are set by
// the deploy.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { GMAIL_ADDRESS, gmailPassword, openMailer } from "../_shared/mail.ts";
import { sha256Hex, turnstileOk } from "../_shared/turnstile.ts";
import { clientIp, visitorBucket } from "../_shared/visitorKey.ts";
import {
  composeOfficeHeadsUp,
  headsUpRecipients,
  isToken,
  parseAcceptRequest,
  type CustomerEstimate,
} from "../_shared/estimateEmail.ts";

const VIEWS_PER_HOUR = 30;
const ACCEPTS_PER_HOUR = 10;
const ACCEPTS_PER_LINK_PER_DAY = 20;

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
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const TRY_LATER = "Something went wrong. Please try again in a few minutes, or call us.";

const MESSAGES: Record<string, string> = {
  "not-found": "This link is not valid. Please check the link in your email, or call us.",
  changed: "This estimate was updated, so this link no longer works. Please use the newest email from us, or call us.",
  closed: "This estimate is no longer open. Please call us if you would still like the work done.",
  expired: "This link has expired. Please call or email us and we will send a fresh one.",
  "already-accepted": "This estimate was already accepted. Thank you!",
  "bad-name": "Please type your full name (2 to 100 characters).",
  "bad-option": "Please pick one of the options.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });
  if (allowedOrigin !== "*" && req.headers.get("origin") !== allowedOrigin) {
    return reply(403, { error: "Not allowed from this site." });
  }
  const raw = await req.text();
  if (raw.length > 10_000) return reply(413, { error: "Invalid request." });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad");
  } catch {
    return reply(400, { error: "Invalid request." });
  }
  const action = body.action;
  if (action !== "view" && action !== "accept") return reply(400, { error: "Invalid request." });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ip = clientIp(req.headers);
  const salt = Deno.env.get("RATE_LIMIT_SALT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ipHash = await sha256Hex(`${salt}:accept-page:${visitorBucket(ip)}`);
  const take = async (bucket: string, key: string, max: number, seconds = 3600) => {
    const { data, error } = await db.rpc("public_rate_limit_take", {
      p_bucket: bucket,
      p_key_hash: key,
      p_max: max,
      p_window_seconds: seconds,
    });
    return !error && data === true;
  };

  if (action === "view") {
    // A bad link still shows how to reach the business (name, phone and
    // email only; the company id comes from app_config, never the request).
    const businessContact = async (): Promise<unknown> => {
      const { data: cfg } = await db.from("app_config").select("company_id").maybeSingle();
      if (!cfg?.company_id) return null;
      const { data: c } = await db.rpc("company_for_customer", { p_company_id: cfg.company_id });
      return c ?? null;
    };
    // A malformed link is answered before the rate limit, so junk
    // requests add no rate-limit rows (reading the contact adds none).
    if (!isToken(body.token)) return reply(200, { status: "not-found", company: await businessContact() });
    if (!(await take("accept-view", ipHash, VIEWS_PER_HOUR))) {
      return reply(429, { error: "Too many tries from this connection. Please wait an hour, or call us." });
    }
    const { data, error } = await db.rpc("estimate_accept_view", { p_token_hash: await sha256Hex(body.token) });
    if (error || !data) return reply(500, { error: TRY_LATER });
    const v = data as Record<string, unknown>;
    return reply(200, {
      status: v.status,
      company: v.company ?? (v.status === "not-found" ? await businessContact() : null),
      estimate: v.estimate ?? null,
      greeting: v.greeting ?? "",
      termsDays: v.terms_days ?? null,
      billingTerms: v.billing_terms ?? "",
      expiresAt: v.expires_at ?? null,
      acceptedOptionId: v.accepted_option_id ?? null,
      acceptedAt: v.accepted_at ?? null,
    });
  }

  // ---- accept ----
  if (!(await take("accept-try", ipHash, ACCEPTS_PER_HOUR))) {
    return reply(429, { error: "Too many tries from this connection. Please wait an hour, or call us." });
  }
  const parsed = parseAcceptRequest(body);
  if (typeof parsed === "string") return reply(400, { error: parsed });
  const tokenHash = await sha256Hex(parsed.token);
  if (!(await take("accept-link", tokenHash, ACCEPTS_PER_LINK_PER_DAY, 86_400))) {
    return reply(429, { error: "Too many tries for this estimate today. Please call us." });
  }
  if (!(await turnstileOk(parsed.turnstileToken, ip))) {
    return reply(403, { error: "The spam check didn't pass. Please try again." });
  }

  const { data, error } = await db.rpc("accept_estimate_by_link", {
    p_token_hash: tokenHash,
    p_option_id: parsed.optionId,
    p_name: parsed.name,
  });
  if (error || !data) return reply(500, { error: TRY_LATER });
  const r = data as Record<string, unknown>;
  const status = String(r.status ?? "");
  if (status !== "accepted") {
    return reply(status === "already-accepted" ? 200 : 400, {
      status,
      error: MESSAGES[status] ?? TRY_LATER,
    });
  }

  // Only the office hears about it (business rule: "I don't want to
  // spam them, I just want to get something on our end saying they
  // accepted and we will reach out manually to schedule them"). The
  // customer gets no email here: the page itself thanks them, and their
  // one email is the invoice. Best effort; the acceptance already stands.
  const password = gmailPassword();
  if (password !== "") {
    const office = composeOfficeHeadsUp({
      estimate: r.estimate as CustomerEstimate,
      customerName: String(r.customer_name ?? "Customer"),
      optionLabel: String(r.option_label ?? ""),
      signedBy: String(r.signed_by ?? parsed.name),
    });
    // The business Gmail and the manager logins (Sam): one email each.
    // accept_estimate_by_link says "accepted" only once per estimate, so
    // this runs once per estimate.
    const { data: managers } = await db.rpc("estimate_heads_up_recipients", { p_company_id: r.company_id });
    const mailer = openMailer(password);
    try {
      for (const to of headsUpRecipients(GMAIL_ADDRESS, managers)) {
        await mailer.send({ to, ...office });
      }
    } finally {
      mailer.close();
    }
  }
  return reply(200, { status: "accepted", optionLabel: String(r.option_label ?? "") });
});
