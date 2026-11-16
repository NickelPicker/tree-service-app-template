// invoiceEmail.ts — the invoice email a person sends from the app
// ("Email invoice" on an invoice, send-invoice edge function).
//
// Business rule: the customer gets ONE email: a thank-you, the
// invoice, and — only when the sender ticks "Ask for a review in this
// email" — a "Review us" button. Nobody is asked for a review
// automatically, so a review link never reaches someone who may leave
// a bad one.
//
// Pure code with no Deno or browser globals: send-invoice imports it,
// and so does the app (the preview in src/invoicePreview.ts and the
// vitest tests), so the preview is exactly what goes out.

import { dueText, escapeHtml, money, niceDate } from "../run-automations/plan.ts";

export interface InvoiceEmailLine {
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
}

/** Only the invoice fields the email uses (nothing internal). */
export interface InvoiceForEmail {
  number?: string | null;
  status?: string | null;
  issued_date?: string | null;
  due_date?: string | null;
  lines?: InvoiceEmailLine[] | null;
  tax_rate?: number | string | null;
  discount_type?: string | null;
  discount_value?: number | string | null;
}

/** The company profile fields the email uses (settings.company_profile). */
export interface InvoiceCompany {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  zelleNumber?: string | null;
  checkPayee?: string | null;
  checkMailingAddress?: string | null;
  /** "Review link (Google)" from Invoice settings. */
  reviewUrl?: string | null;
}

export interface InvoiceEmail {
  subject: string;
  text: string;
  html: string;
  /** For the customer's message thread: no money, no links. */
  recordText: string;
  /** True when the "Review us" section is in this email. */
  hasReview: boolean;
}

/** The text version writes the button as this label, a colon and the link. */
export const REVIEW_BUTTON_LABEL = "Review us";

const MAX_REVIEW_URL = 500;

/**
 * The review link when it is a plain https web address (no spaces, no
 * user name or password, at most 500 characters), else "". Anything
 * else (javascript:, http:, typos) is never put in an email.
 */
export function reviewLink(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  if (v === "" || v.length > MAX_REVIEW_URL || /\s/.test(v)) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || !u.hostname.includes(".")) return "";
  return u.href;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
function dayOf(v: string | null | undefined): string {
  return v && DAY_RE.test(v) ? v.slice(0, 10) : "";
}

/** Subtotal, discount, tax and total, same math as the app (discount, then tax). */
export function invoiceAmounts(i: InvoiceForEmail): { subtotal: number; discount: number; tax: number; total: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const subtotal = (i.lines ?? []).reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0);
  let discount = 0;
  const dv = num(i.discount_value);
  if (i.discount_type === "percent") discount = subtotal * (Math.min(100, Math.max(0, dv)) / 100);
  else if (i.discount_type === "fixed") discount = Math.min(subtotal, Math.max(0, dv));
  const discounted = subtotal - discount;
  const tax = discounted * (num(i.tax_rate) / 100);
  return { subtotal: r2(subtotal), discount: r2(discount), tax: r2(tax), total: r2(discounted + tax) };
}

function companyName(c: InvoiceCompany | null): string {
  return (c?.name ?? "").trim() || "Your Tree Company";
}

/** Same lines as the app's "How to pay" box (src/components/HowToPay.tsx). */
export function howToPayLines(number: string, c: InvoiceCompany | null): string[] {
  const zelle = (c?.zelleNumber ?? "").trim();
  const payee = (c?.checkPayee ?? "").trim();
  const mail = (c?.checkMailingAddress ?? "").trim();
  const ways: string[] = [];
  if (zelle) ways.push(`Zelle — send to ${zelle}.`);
  if (payee) ways.push(`Check — payable to ${payee}${mail ? `, mail to ${mail}.` : "."}`);
  if (ways.length === 0) return [];
  return [...ways, `Please note the payment method and put invoice ${number} in the memo.`];
}

function lineText(l: InvoiceEmailLine): string {
  const q = num(l.quantity);
  const p = num(l.unitPrice);
  const what = (l.description ?? "").trim() || "Work";
  return `${what}${q !== 1 ? ` (${q} x ${money(p)})` : ""}: ${money(q * p)}`;
}

function discountText(i: InvoiceForEmail): string {
  if (i.discount_type === "percent") return `${num(i.discount_value)}%`;
  return "";
}

const P = (s: string, style = "") =>
  `<p${style ? ` style="${style}"` : ""}>${escapeHtml(s).replace(/\n/g, "<br>")}</p>`;

/**
 * One payer's part of a split invoice (business rule: "Each payer
 * should get an invoice for the amount they are going to pay"). Only
 * this payer's own name and share: never another payer's name, email
 * or share.
 */
export interface PayerShare {
  /** The payer's name as typed on the invoice (the greeting). */
  name: string;
  /** Their share in dollars (_shared/splitShares.ts sharesOf). */
  amount: number;
  kind: "percentage" | "fixed";
  /** The percent, for a percentage split. */
  percent?: number;
}

/**
 * The invoice email. `askReview` adds the "Review us" section only when
 * the company has a valid review link; without one the email has none.
 * With `share` it is one payer's email of a split invoice: the full
 * invoice, then "Your share: $X", and How to pay for that amount.
 */
export function composeInvoiceEmailByHand(input: {
  invoice: InvoiceForEmail;
  /** First name, else the business name. */
  greeting: string;
  company: InvoiceCompany | null;
  askReview: boolean;
  share?: PayerShare | null;
}): InvoiceEmail {
  const { invoice: i, company } = input;
  const share = input.share ?? null;
  const number = (i.number ?? "").trim() || "invoice";
  const name = companyName(company);
  const a = invoiceAmounts(i);
  const issued = dayOf(i.issued_date);
  const due = dayOf(i.due_date);
  const paid = i.status === "paid";
  const link = input.askReview ? reviewLink(company?.reviewUrl) : "";
  const hasReview = link !== "";

  const hi = `Hi ${(share ? share.name : input.greeting ?? "").trim() || "there"},`;
  const thanks = share
    ? `Thank you for choosing ${name}! Here is invoice ${number}. It is shared between payers; this email shows the part that is yours to pay.`
    : `Thank you for choosing ${name}! Here is your invoice ${number}.`;
  const head = [`Invoice ${number}`, issued ? `Issued: ${niceDate(issued)}` : ""].filter(Boolean);
  const lines = (i.lines ?? []).map(lineText);
  const sums: string[] = [`Subtotal: ${money(a.subtotal)}`];
  if (a.discount > 0) {
    const d = discountText(i);
    sums.push(`Discount${d ? ` (${d})` : ""}: -${money(a.discount)}`);
  }
  if (a.tax > 0) sums.push(`Tax (${num(i.tax_rate)}%): ${money(a.tax)}`);
  const shareText = share
    ? `Your share: ${money(share.amount)}${
        share.kind === "percentage" && Number.isFinite(share.percent) ? ` (${share.percent}% of the total)` : ""
      }`
    : "";
  if (share) sums.push(`Invoice total: ${money(a.total)}`, shareText);
  else sums.push(`Total${paid ? "" : " due"}: ${money(a.total)}`);
  const dueLine = paid
    ? "Paid in full — thank you!"
    : share
      ? `Your share is due ${dueText(issued, due)}.`
      : `Due ${dueText(issued, due)}.`;
  const pay = paid ? [] : howToPayLines(number, company);
  const reviewAsk =
    "One more thing: if you were happy with our work, would you leave us a quick review? It helps a small local business more than you know.";
  const questions = "Questions? Just reply to this email or give us a call.";
  const phone = (company?.phone ?? "").trim();
  const signature = phone ? `${name}\n${phone}` : name;

  const text = [
    hi,
    thanks,
    [...head, ...lines.map((l) => `  - ${l}`), ...sums, dueLine].join("\n"),
    pay.length ? `How to pay:\n${pay.join("\n")}` : "",
    hasReview ? `${reviewAsk}\n${REVIEW_BUTTON_LABEL}: ${link}` : "",
    questions,
    signature,
  ]
    .filter(Boolean)
    .join("\n\n");

  const box = "border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:12px 0";
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.4;color:#222;max-width:600px">` +
    P(hi) +
    P(thanks) +
    `<div style="${box}">` +
    `<p style="margin:0 0 4px"><b>${escapeHtml(`Invoice ${number}`)}</b>${issued ? ` · Issued ${escapeHtml(niceDate(issued))}` : ""}</p>` +
    (lines.length ? `<ul style="margin:4px 0 6px;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : "") +
    sums
      .map((s, n) => (n === sums.length - 1 ? `<p style="margin:2px 0"><b>${escapeHtml(s)}</b></p>` : `<p style="margin:2px 0">${escapeHtml(s)}</p>`))
      .join("") +
    `<p style="margin:6px 0 0">${escapeHtml(dueLine)}</p></div>` +
    (pay.length
      ? `<div style="border:1px solid #a7f3d0;background:#ecfdf5;border-radius:8px;padding:10px 12px;margin:12px 0;color:#064e3b">` +
        `<p style="margin:0 0 4px"><b>How to pay</b></p>` +
        `<ul style="margin:0;padding-left:20px">${pay.slice(0, -1).map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` +
        `<p style="margin:4px 0 0">${escapeHtml(pay[pay.length - 1])}</p></div>`
      : "") +
    (hasReview
      ? P(reviewAsk) +
        `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#b45309;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${REVIEW_BUTTON_LABEL}</a></p>`
      : "") +
    P(questions) +
    P(signature) +
    `</div>`;

  const subject = share
    ? `Invoice ${number} from ${name} — your share ${money(share.amount)}`
    : `Invoice ${number} from ${name} — ${money(a.total)}`;
  // The thread copy: crew without "see money" can read the thread, so
  // no amounts; and no link (nor a payer's email address).
  const who = share ? `${share.name.trim() || "a payer"} (their share)` : "the customer";
  const recordText = `Invoice ${number} emailed to ${who}${hasReview ? ", with a request for a review" : ""}.`;
  return { subject, text, html, recordText, hasReview };
}

/**
 * The sends-log key for one "Email invoice": the invoice and the time
 * it was last REALLY emailed (invoices.emailed_at, set only by the
 * database), so a double press is one email and "Email again" after a
 * real send is a new one. Never based on email_queued_at, which older
 * app builds still write without sending.
 */
export function invoiceDedupeKey(invoiceId: string, emailedAt: string | null | undefined): string {
  const at = String(emailedAt ?? "").trim();
  return `invoice_emailed:${invoiceId}:${at || "first"}`;
}

/** A hand send left in 'sending' this long may have died (before OR after Gmail took it). */
export const STUCK_SEND_MINUTES = 30;

/**
 * What to do when the send could not be claimed, from its sends-log row:
 *   'sent'    -> "already-sent"
 *   'failed'  -> "failed-3-times" (Gmail refused it 3 times)
 *   'sending' -> "in-progress" while younger than 30 minutes; after that
 *                the email MAY have gone (the function died before
 *                recording it), so an ordinary press gets
 *                "may-have-sent" and never sends; only "Email again"
 *                (again = true, after the on-page confirm) takes it
 *                over: "reclaim".
 */
export function claimRefused(
  status: string | null,
  createdAt: string | null,
  again: boolean,
  now: Date = new Date(),
): string {
  switch (status) {
    case "sent":
      return "already-sent";
    case "failed":
      return "failed-3-times";
    case "sending": {
      const t = new Date(String(createdAt ?? "")).getTime();
      const stuck = Number.isFinite(t) && now.getTime() - t > STUCK_SEND_MINUTES * 60_000;
      if (!stuck) return "in-progress";
      return again ? "reclaim" : "may-have-sent";
    }
    default:
      return "error";
  }
}
