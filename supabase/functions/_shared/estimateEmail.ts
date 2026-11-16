// estimateEmail.ts — the estimate email with its private "Review and
// accept" link and the office heads-up after a customer accepts online
// (the customer gets no email then). Also the small checks both estimate functions
// share (token format, the site address, the typed name).
//
// Pure code with no Deno or browser globals: send-estimate and
// estimate-accept import it, and so do the app's vitest tests.
// Rows use the shape the database functions return (see migration
// the "customers accept estimates online" rules: estimate_for_customer, company_for_customer).

import { documentTotal, escapeHtml, money, niceDate } from "../run-automations/plan.ts";

export interface CustomerLine {
  description: string;
  quantity: number | string;
  unitPrice: number | string;
}

export interface CustomerOption {
  id: string;
  label: string;
  description: string;
  lines: CustomerLine[];
}

/** estimate_for_customer(): only what the customer may see. */
export interface CustomerEstimate {
  title: string;
  created_date?: string | null;
  notes?: string | null;
  tax_rate: number | string;
  discount_type: string;
  discount_value: number | string;
  lines: CustomerLine[];
  options: CustomerOption[];
  accepted_option_id?: string | null;
}

/** company_for_customer(): name, phone, email only. */
export interface PublicCompany {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface Composed {
  subject: string;
  text: string;
  html: string;
}

/** A link works for this many days. */
export const LINK_DAYS = 60;

/** 32 random bytes, base64url without padding = 43 characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

/** base64url (no padding) of the given bytes. */
export function tokenFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const HTTPS_ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * The website address for links: the deploy's ALLOWED_ORIGIN (the live
 * site) when set, else the address the office is using right now.
 * "" when neither looks like a website address.
 */
export function siteOrigin(allowedOrigin: string, requestOrigin: string | null): string {
  const ok = (o: string) => HTTPS_ORIGIN.test(o) || LOCAL_ORIGIN.test(o);
  const a = (allowedOrigin ?? "").trim().replace(/\/+$/, "");
  if (a && a !== "*" && ok(a)) return a;
  const r = (requestOrigin ?? "").trim().replace(/\/+$/, "");
  return ok(r) ? r : "";
}

export function acceptUrl(origin: string, token: string): string {
  return `${origin}/accept/${token}`;
}

/** The typed name, tidied the same way as the database (2-100 characters). */
export function cleanName(v: unknown): string {
  if (typeof v !== "string") return "";
  // deno-lint-ignore no-control-regex
  // oxlint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function nameOk(name: string): boolean {
  return name.length >= 2 && name.length <= 100;
}

export interface AcceptRequest {
  token: string;
  optionId: string;
  name: string;
  turnstileToken: string;
}

/** Checks the page's accept request; a plain-English problem or the request. */
export function parseAcceptRequest(body: Record<string, unknown>): AcceptRequest | string {
  if (!isToken(body.token)) return "This link is not valid.";
  const optionId = typeof body.optionId === "string" ? body.optionId.trim() : "";
  if (optionId.length > 100) return "Please pick one of the options.";
  const name = cleanName(body.name);
  if (!nameOk(name)) return "Please type your full name (2 to 100 characters).";
  if (body.agree !== true) return "Please tick the box to agree to the estimate and its terms.";
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken.slice(0, 4096) : "";
  return { token: body.token, optionId, name, turnstileToken };
}

export interface Choice {
  /** "" for a single-option estimate. */
  id: string;
  label: string;
  description: string;
  lines: CustomerLine[];
  total: number;
}

/** What the customer can pick: each option, or the estimate itself. */
export function estimateChoices(e: CustomerEstimate): Choice[] {
  const total = (lines: CustomerLine[]) => documentTotal(lines, e.tax_rate, e.discount_type, e.discount_value);
  const options = Array.isArray(e.options) ? e.options : [];
  if (options.length > 0) {
    return options.map((o) => ({
      id: o.id,
      label: o.label || "Option",
      description: o.description ?? "",
      lines: o.lines ?? [],
      total: total(o.lines ?? []),
    }));
  }
  const lines = Array.isArray(e.lines) ? e.lines : [];
  return [{ id: "", label: "", description: "", lines, total: total(lines) }];
}

function companyName(c: PublicCompany | null): string {
  return (c?.name ?? "").trim() || "Your Tree Company";
}

function signature(c: PublicCompany | null): string {
  const phone = (c?.phone ?? "").trim();
  return phone ? `${companyName(c)}\n${phone}` : companyName(c);
}

function lineText(l: CustomerLine): string {
  const q = Number(l.quantity) || 0;
  const p = Number(l.unitPrice) || 0;
  return `  - ${l.description || "Item"}${q !== 1 ? ` (${q} x ${money(p)})` : ""}: ${money(q * p)}`;
}

function choicesText(choices: Choice[]): string {
  return choices
    .map((c) =>
      [
        c.label ? `${c.label}${c.description ? ` — ${c.description}` : ""}: ${money(c.total)}` : `Total: ${money(c.total)}`,
        ...c.lines.map(lineText),
      ].join("\n"),
    )
    .join("\n\n");
}

const P = (s: string) => `<p>${escapeHtml(s).replace(/\n/g, "<br>")}</p>`;
const WRAP = (inner: string) =>
  `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.4;color:#222;max-width:600px">${inner}</div>`;

function choicesHtml(choices: Choice[]): string {
  return choices
    .map(
      (c) =>
        `<div style="border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:8px 0">` +
        (c.label
          ? `<p style="margin:0 0 4px"><b>${escapeHtml(c.label)}</b>${c.description ? ` — ${escapeHtml(c.description)}` : ""}</p>`
          : "") +
        `<ul style="margin:4px 0 6px;padding-left:20px">${c.lines.map((l) => `<li>${escapeHtml(lineText(l).replace(/^ {2}- /, ""))}</li>`).join("")}</ul>` +
        `<p style="margin:0"><b>${c.label ? "Option total" : "Total"}: ${escapeHtml(money(c.total))}</b></p></div>`,
    )
    .join("");
}

/** The email with the estimate and its private accept link. */
export function composeEstimateEmail(input: {
  estimate: CustomerEstimate;
  greeting: string;
  company: PublicCompany | null;
  link: string;
  /** ISO time the link stops working. */
  expiresAt: string;
}): Composed & { recordText: string } {
  const { estimate: e, company, link } = input;
  const title = (e.title ?? "").trim() || "your estimate";
  const choices = estimateChoices(e);
  const hi = `Hi ${(input.greeting ?? "").trim() || "there"},`;
  const intro = `Here is your estimate from ${companyName(company)}: ${title}.`;
  const pick =
    choices.length > 1
      ? "There are a few options — pick the one that works for you."
      : "";
  const until = niceDate((input.expiresAt ?? "").slice(0, 10));
  const how = `To accept, open your private link below, ${choices.length > 1 ? "pick an option, " : ""}type your name and press Accept. The link works until ${until}.`;
  const notes = (e.notes ?? "").trim() ? `Notes: ${(e.notes ?? "").trim()}` : "";
  const questions = "Questions? Just reply to this email or give us a call.";
  const lowest = Math.min(...choices.map((c) => c.total));
  const subject =
    choices.length > 1 ? `Your estimate: ${title} — from ${money(lowest)}` : `Your estimate: ${title} — ${money(choices[0].total)}`;

  const textWith = (l: string) =>
    [hi, [intro, pick].filter(Boolean).join(" "), choicesText(choices), notes, how, `Review and accept: ${l}`, questions, signature(company)]
      .filter(Boolean)
      .join("\n\n");
  const text = textWith(link);
  const html = WRAP(
    [P(hi), P([intro, pick].filter(Boolean).join(" ")), choicesHtml(choices), notes ? P(notes) : "", P(how)].join("") +
      `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#2f6b40;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">Review and accept</a></p>` +
      `<p style="font-size:13px;color:#555">Or copy this address into your browser: ${escapeHtml(link)}</p>` +
      P(questions) +
      P(signature(company)),
  );
  // What goes in the customer's message thread: never the working link
  // (crew who can read the thread must not be able to accept), and no
  // prices (crew without "see money" can read the thread).
  const optionsNote = choices.length > 1 ? ` (${choices.length} options)` : "";
  return { subject, text, html, recordText: `Estimate emailed: ${title}${optionsNote}. The customer got a private link to accept it.` };
}

/**
 * Heads-up to the business Gmail. Only goes to the office: the customer
 * gets no email when they accept (business rule); the office calls
 * them to schedule.
 */
export function composeOfficeHeadsUp(input: {
  estimate: CustomerEstimate;
  customerName: string;
  optionLabel: string;
  signedBy: string;
}): Composed {
  const { estimate: e } = input;
  const title = (e.title ?? "").trim() || "Estimate";
  const choices = estimateChoices(e);
  const chosen =
    choices.find((c) => c.id !== "" && c.id === (e.accepted_option_id ?? "")) ?? (choices.length === 1 ? choices[0] : null);
  const what = input.optionLabel ? `${title} — ${input.optionLabel}` : title;
  const subject = `${input.customerName} accepted ${what} — call to schedule`;
  const parts = [
    `${input.customerName} accepted "${title}"${input.optionLabel ? `, option "${input.optionLabel}"` : ""}${chosen ? ` (${money(chosen.total)})` : ""} on the online link, signed "${input.signedBy}".`,
    `Please call them to schedule. It is waiting in Schedule → "To schedule" and on the Dashboard under "Accepted online — call to schedule"; drag it onto a day to book the job.`,
    "The customer was not emailed.",
  ];
  return { subject, text: parts.join("\n\n"), html: WRAP(parts.map(P).join("")) };
}

/**
 * Who gets the "accepted online" heads-up: the business Gmail first,
 * then each manager login from the database (estimate_heads_up_recipients),
 * each address once, case-insensitive; anything that is not an email
 * address is dropped. Never taken from the request.
 */
export function headsUpRecipients(businessGmail: string, managers: unknown): string[] {
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const e = v.trim();
    if (!ok.test(e) || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase());
    out.push(e);
  };
  add(businessGmail);
  if (Array.isArray(managers)) managers.forEach(add);
  return out;
}
