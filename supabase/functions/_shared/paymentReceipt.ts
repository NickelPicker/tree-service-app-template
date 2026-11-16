// paymentReceipt.ts — the receipt a payer of a split invoice gets when
// the office marks their share paid (owner: "I want the person who has
// paid to get a receipt of payment and no further information if the
// other portions have been paid or not").
//
// The receipt holds only that payer's own payment: the amount they paid
// (their share), the date, the invoice number and the company's details.
// Never the invoice total, the lines, another payer's name, share or
// status, or what is still owed.
//
// One receipt per payer per payment: the sends-log key is the invoice,
// the payer (split id) and the day their share was marked paid. A second
// receipt for the same payment goes only through "Resend receipt".
//
// Pure code with no Deno or browser globals: send-invoice uses it, and so
// do the app's tests and the app's receipt status.

import { escapeHtml, money, niceDate } from "../run-automations/plan.ts";
import type { InvoiceCompany } from "./invoiceEmail.ts";
import { EMAIL_RE, payersOf, type Payer } from "./splitInvoiceSend.ts";
import { sharesOf } from "./splitShares.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A stuck send (the function died) may have gone after this long. */
const STUCK_MINUTES = 30;
/** claim_automation_send stops retrying a failed row after this many tries. */
const MAX_TRIES = 3;

/** Whose payment a stored split records, or "" when it is not marked paid with a date. */
export function paidDayOf(split: unknown): string {
  if (!split || typeof split !== "object") return "";
  const s = split as { paid?: unknown; paidDate?: unknown };
  const day = typeof s.paidDate === "string" ? s.paidDate.slice(0, 10) : "";
  return s.paid === true && DAY_RE.test(day) ? day : "";
}

/**
 * The sends-log key of one receipt: invoice, payer, the day their share
 * was marked paid, and `after` ("first", or for "Resend receipt" the time
 * of the receipt it follows).
 */
export function receiptDedupeKey(invoiceId: string, splitId: string, paidDay: string, after: string | null | undefined): string {
  const at = String(after ?? "").trim();
  return `payment_receipt:${invoiceId}:payer-${splitId}:${paidDay}:${at || "first"}`;
}

export interface ReceiptRow {
  dedupe_key?: string | null;
  status?: string | null;
  sent_at?: string | null;
  created_at?: string | null;
  attempts?: number | null;
}

export interface ReceiptState {
  /** Last receipt Gmail took for this payment (ISO), if any. */
  sentAt: string | null;
  /**
   * What a "Resend receipt" follows: the newest receipt that went, or one
   * stuck in 'sending' for over 30 minutes (it may have gone). Its time.
   */
  resendAfter: string | null;
  /**
   * What the next first-time "Send receipt" follows when no receipt went
   * yet: the newest try that failed 3 times (its key can never be
   * claimed again), so the payer can still get one. Null = "first".
   */
  retryAfter?: string | null;
}

/** "<split id>|<paid day>" → that payment's receipt state, from this invoice's 'payment_receipt' rows. */
export function receiptStates(invoiceId: string, rows: ReceiptRow[], now: Date = new Date()): Map<string, ReceiptState> {
  const prefix = `payment_receipt:${invoiceId}:payer-`;
  const out = new Map<string, ReceiptState>();
  const later = (a: string | null, b: string) => (!a || new Date(b).getTime() > new Date(a).getTime() ? b : a);
  for (const r of rows) {
    const key = String(r.dedupe_key ?? "");
    if (!key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split(":");
    if (parts.length < 3 || !parts[0] || !DAY_RE.test(parts[1])) continue;
    const id = `${parts[0]}|${parts[1]}`;
    const st: ReceiptState = out.get(id) ?? { sentAt: null, resendAfter: null, retryAfter: null };
    if (r.status === "sent" && r.sent_at) {
      st.sentAt = later(st.sentAt, String(r.sent_at));
      st.resendAfter = later(st.resendAfter, String(r.sent_at));
    } else if (r.status === "sending" && r.created_at) {
      const t = new Date(String(r.created_at)).getTime();
      if (Number.isFinite(t) && now.getTime() - t > STUCK_MINUTES * 60_000) {
        st.resendAfter = later(st.resendAfter, String(r.created_at));
      }
    } else if (r.status === "failed" && r.created_at && Number(r.attempts ?? 0) >= MAX_TRIES) {
      // Given up: that key is dead, so the next send follows it.
      st.resendAfter = later(st.resendAfter, String(r.created_at));
      st.retryAfter = later(st.retryAfter ?? null, String(r.created_at));
    }
    out.set(id, st);
  }
  return out;
}

/**
 * Why one payer gets no receipt on this press:
 *   not-paid          their share is not marked paid (with a date)
 *   no-email          no (valid) email address
 *   no-share          their share is $0
 *   already-sent      a receipt for this payment went already (use Resend)
 *   blocked-test-mode test mode refuses the address
 */
export type ReceiptSkip = "not-paid" | "no-email" | "no-share" | "already-sent" | "blocked-test-mode";

export interface ReceiptPlan {
  payer: Payer;
  /** Their share: what they paid. */
  amount: number;
  paidDay: string;
  /** The sends-log key for this press. */
  key: string;
  skip: ReceiptSkip | null;
}

export type ReceiptPlanResult =
  | { ok: false; reason: "bad-split" | "unknown-payer" | "no-payers" }
  | { ok: true; payers: ReceiptPlan[]; toSend: ReceiptPlan[] };

/**
 * Who gets a receipt on this press: the payers in `only` (the ones just
 * marked paid, or the one "Resend receipt" was pressed for). `again` is
 * "Resend receipt".
 */
export function planReceipts(input: {
  invoiceId: string;
  splits: unknown;
  total: number;
  only: string[];
  again: boolean;
  states: Map<string, ReceiptState>;
  allowed: (email: string) => boolean;
}): ReceiptPlanResult {
  const payers = payersOf(input.splits);
  if (!payers || payers.length === 0) return { ok: false, reason: "bad-split" };
  if (input.only.length === 0) return { ok: false, reason: "no-payers" };
  const only = new Set(input.only);
  if ([...only].some((id) => !payers.some((p) => p.id === id))) return { ok: false, reason: "unknown-payer" };
  const raw = Array.isArray(input.splits) ? (input.splits as unknown[]) : [];
  const shares = sharesOf(payers, input.total);
  const plans: ReceiptPlan[] = [];
  payers.forEach((payer, n) => {
    if (!only.has(payer.id)) return;
    const paidDay = paidDayOf(raw[n]);
    const amount = shares[n];
    const st = input.states.get(`${payer.id}|${paidDay}`) ?? { sentAt: null, resendAfter: null };
    let skip: ReceiptSkip | null = null;
    if (!payer.paid || paidDay === "") skip = "not-paid";
    else if (!EMAIL_RE.test(payer.email)) skip = "no-email";
    else if (!(Math.round(amount * 100) > 0)) skip = "no-share";
    else if (st.sentAt && !input.again) skip = "already-sent";
    else if (!input.allowed(payer.email)) skip = "blocked-test-mode";
    const after = input.again ? st.resendAfter : (st.retryAfter ?? null);
    const key = receiptDedupeKey(input.invoiceId, payer.id, paidDay || "none", after);
    plans.push({ payer, amount, paidDay, key, skip });
  });
  return { ok: true, payers: plans, toSend: plans.filter((p) => p.skip === null) };
}

export interface ReceiptEmail {
  subject: string;
  text: string;
  html: string;
  /** For the customer's message thread: no amount, no address. */
  recordText: string;
}

function companyName(c: InvoiceCompany | null): string {
  return (c?.name ?? "").trim() || "Your Tree Company";
}

const P = (s: string, style = "") =>
  `<p${style ? ` style="${style}"` : ""}>${escapeHtml(s).replace(/\n/g, "<br>")}</p>`;

/** The receipt: this payer's own payment only. */
export function composeReceiptEmail(input: {
  payerName: string;
  amount: number;
  paidDay: string;
  invoiceNumber: string;
  company: InvoiceCompany | null;
}): ReceiptEmail {
  const name = companyName(input.company);
  const number = input.invoiceNumber.trim() || "invoice";
  const hi = `Hi ${input.payerName.trim() || "there"},`;
  const thanks = `Thank you for your payment. This is your receipt.`;
  const facts = [
    `Receipt for invoice ${number}`,
    `Amount paid: ${money(input.amount)}`,
    `Date paid: ${niceDate(input.paidDay)}`,
  ];
  const phone = (input.company?.phone ?? "").trim();
  const email = (input.company?.email ?? "").trim();
  const signature = [name, phone, email].filter(Boolean).join("\n");
  const questions = "Questions? Just reply to this email or give us a call.";
  const text = [hi, thanks, facts.join("\n"), questions, signature].join("\n\n");
  const box = "border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin:12px 0";
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.4;color:#222;max-width:600px">` +
    P(hi) +
    P(thanks) +
    `<div style="${box}">` +
    `<p style="margin:0 0 4px"><b>${escapeHtml(facts[0])}</b></p>` +
    `<p style="margin:2px 0"><b>${escapeHtml(facts[1])}</b></p>` +
    `<p style="margin:2px 0">${escapeHtml(facts[2])}</p></div>` +
    P(questions) +
    P(signature) +
    `</div>`;
  return {
    subject: `Receipt for your payment — invoice ${number} from ${name}`,
    text,
    html,
    recordText: `Receipt for invoice ${number} emailed to ${input.payerName.trim() || "a payer"}.`,
  };
}
