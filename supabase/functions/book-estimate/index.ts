// book-estimate — the only way a booking request gets into the database.
//
// Called by the public booking page (#/book). It:
//   1. checks the Cloudflare Turnstile token with Siteverify,
//   2. validates every field (required fields, lengths, the date),
//   3. checks the limits in booking_limits_take (migration
//      the "booking daily cap" rules): 5 per visitor per hour, 3 per phone number per
//      day, 40 for everyone together per day, 300 waiting at most,
//   4. inserts the request with status 'pending' and no estimate.
// The company id comes from app_config, never from the request.
//
// Secrets (Supabase → Edge Functions → Secrets, never in src/):
//   TURNSTILE_SECRET_KEY  the Turnstile widget's secret key (until it is
//                         set, the spam check is skipped; limits still apply)
//   ALLOWED_ORIGIN        optional: the site's exact origin, e.g.
//                         https://your-site.netlify.app (default: any)
//   RATE_LIMIT_SALT       optional: salt for the stored visitor hashes
//                         (default: the service role key, also secret)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { turnstileOk } from "../_shared/turnstile.ts";
import {
  BOOKING_LIMITS,
  BOOKING_LIMIT_MESSAGES,
  clientIp,
  phoneKey,
  visitorBucket,
} from "../_shared/visitorKey.ts";

const LIMITS = { name: 100, phone: 30, email: 254, address: 300, details: 2000 } as const;
const DAYS_AHEAD = 30;

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

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });
  if (allowedOrigin !== "*" && req.headers.get("origin") !== allowedOrigin) {
    return reply(403, { error: "Not allowed from this site." });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Invalid request." });
  }

  // Only these fields are read. status, estimate_id, company_id, id
  // and requested_at from the client are ignored.
  const fields = {
    name: text(body.name),
    phone: text(body.phone),
    email: text(body.email),
    address: text(body.address),
    details: text(body.details),
  };
  const date = text(body.date);
  const token = text(body.turnstileToken);

  for (const key of ["name", "phone", "address", "details"] as const) {
    if (!fields[key]) return reply(400, { error: `Please fill in your ${key}.` });
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (fields[key as keyof typeof fields].length > max) {
      return reply(400, { error: `The ${key} is too long (at most ${max} characters).` });
    }
  }
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return reply(400, { error: "Please check the email address." });
  }
  const today = todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < addDays(today, -1) || date > addDays(today, DAYS_AHEAD)) {
    return reply(400, { error: "Please pick a day from the list." });
  }

  const ip = clientIp(req.headers);
  if (!Deno.env.get("TURNSTILE_SECRET_KEY")) {
    console.warn("TURNSTILE_SECRET_KEY is not set: spam check skipped");
  }
  if (!(await turnstileOk(token, ip))) {
    return reply(403, { error: "The spam check didn't pass. Please try again." });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const salt = Deno.env.get("RATE_LIMIT_SALT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ipHash = await sha256(`${salt}:booking:${visitorBucket(ip)}`);
  const phone = phoneKey(fields.phone);
  const contactHash = phone ? await sha256(`${salt}:booking-phone:${phone}`) : null;
  let verdict: string;
  const { data: took, error: limitError } = await admin.rpc("booking_limits_take", {
    p_ip_hash: ipHash,
    p_contact_hash: contactHash,
    p_max_visitor_hour: BOOKING_LIMITS.perVisitorPerHour,
    p_max_contact_day: BOOKING_LIMITS.perPhonePerDay,
    p_max_day: BOOKING_LIMITS.perDay,
    p_max_pending: BOOKING_LIMITS.maxPending,
  });
  if (limitError && (limitError.code === "PGRST202" || limitError.code === "42883")) {
    // The function was deployed a moment before its migration: use the
    // old per-visitor limit until it lands.
    const { data: allowed, error: oldError } = await admin.rpc("booking_rate_limit_take", {
      p_ip_hash: ipHash,
      p_max: BOOKING_LIMITS.perVisitorPerHour,
    });
    if (oldError) return reply(500, { error: "Something went wrong. Please call us instead." });
    verdict = allowed === true ? "ok" : "visitor";
  } else if (limitError) {
    return reply(500, { error: "Something went wrong. Please call us instead." });
  } else {
    verdict = String(took);
  }
  if (verdict !== "ok") {
    return reply(429, { error: BOOKING_LIMIT_MESSAGES[verdict] ?? BOOKING_LIMIT_MESSAGES.visitor });
  }

  const { data: cfg, error: cfgError } = await admin
    .from("app_config")
    .select("company_id")
    .maybeSingle();
  if (cfgError || !cfg) return reply(500, { error: "Something went wrong. Please call us instead." });

  const { error: insertError } = await admin.from("booking_requests").insert({
    id: crypto.randomUUID(),
    company_id: cfg.company_id,
    date,
    name: fields.name,
    phone: fields.phone,
    email: fields.email || null,
    address: fields.address,
    details: fields.details,
    status: "pending",
    requested_at: today,
    estimate_id: null,
  });
  if (insertError) return reply(500, { error: "Something went wrong. Please call us instead." });

  return reply(200, { ok: true });
});
