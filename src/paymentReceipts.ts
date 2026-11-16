/**
 * Payment receipts for split invoices (owner: "I want the person who has
 * paid to get a receipt of payment and no further information if the
 * other portions have been paid or not").
 *
 * When the office marks a payer's share paid, that payer is emailed a
 * receipt for their own payment only (send-invoice with receipt: true;
 * the email is built by supabase/functions/_shared/paymentReceipt.ts).
 * One receipt per payer per payment; "Resend receipt" sends another
 * after an on-page confirm. More than 3 receipts at once need the two
 * "are you sure" steps. In demo mode nothing is sent.
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";
import { invoiceTotal } from "./splits";
import type { Invoice, InvoiceSplit } from "./types";
import { EMAIL_RE } from "../supabase/functions/_shared/splitInvoiceSend.ts";
import { sharesOf } from "../supabase/functions/_shared/splitShares.ts";
import { receiptStates, type ReceiptRow, type ReceiptState } from "../supabase/functions/_shared/paymentReceipt.ts";

export type { ReceiptState };

/** One payer's receipt outcome (by split id; no addresses). */
export interface ReceiptPayerResult {
  id: string;
  sent: number;
  /** not-paid | no-email | no-share | already-sent | blocked-test-mode | error */
  reason?: string;
  marked?: boolean;
}

export interface ReceiptSendResult {
  sent: number;
  /** demo | gmail-not-set-up | not-saved | needs-confirm | too-many | daily-limit | no-payers | not-split | bad-split | unknown-payer | not-allowed | error */
  reason?: string;
  count?: number;
  payers: ReceiptPayerResult[];
}

export function parseReceiptReply(data: unknown): ReceiptSendResult {
  if (!data || typeof data !== "object") return { sent: 0, reason: "error", payers: [] };
  const d = data as Record<string, unknown>;
  const payers = (Array.isArray(d.payers) ? d.payers : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string")
    .map((x) => {
      const p: ReceiptPayerResult = { id: String(x.id), sent: x.sent === 1 ? 1 : 0 };
      if (typeof x.reason === "string" && x.reason) p.reason = x.reason;
      if (p.sent === 1 && x.marked === false) p.marked = false;
      if (p.sent === 0 && !p.reason) p.reason = "error";
      return p;
    });
  const sent = payers.filter((p) => p.sent === 1).length;
  const r: ReceiptSendResult = { sent, payers };
  if (typeof d.reason === "string" && d.reason) r.reason = d.reason;
  if (typeof d.count === "number" && Number.isFinite(d.count)) r.count = d.count;
  if (sent === 0 && !r.reason) r.reason = "error";
  return r;
}

/** Plain words for one payer's receipt result. */
export function receiptPayerText(p: ReceiptPayerResult): string {
  if (p.sent > 0) return p.marked === false ? "Receipt emailed, but not recorded. Reload the page." : "Receipt emailed just now.";
  switch (p.reason) {
    case "not-paid":
      return "No receipt: their share is not marked paid.";
    case "no-email":
      return "No receipt: no email address for this payer.";
    case "no-share":
      return "No receipt: their share is $0.";
    case "already-sent":
      return "Receipt already sent. Use Resend receipt to send it again.";
    case "blocked-test-mode":
      return "No receipt: test mode (only test addresses get emails right now).";
    default:
      return "Receipt not sent: something went wrong. Try Resend receipt in a few minutes.";
  }
}

/** Plain words for the whole press (a toast). */
export function receiptSendText(r: ReceiptSendResult): string {
  if (r.sent > 0) return `Receipt emailed to ${r.sent} payer${r.sent === 1 ? "" : "s"}.`;
  switch (r.reason) {
    case "demo":
      return "Demo mode: no receipt sent.";
    case "gmail-not-set-up":
      return "No receipt sent: the business Gmail is not set up yet.";
    case "not-saved":
      return "No receipt sent: the invoice has not finished saving. Use Resend receipt in a moment.";
    case "needs-confirm":
      return `No receipts sent: ${r.count ?? "more than 3"} at once need the two “are you sure” steps.`;
    case "too-many":
      return "No receipt sent: that's a lot of receipts this hour. Try again later.";
    case "daily-limit":
      return "No receipt sent: today's email limit is reached. Try again tomorrow.";
    case "not-allowed":
      return "Only the office can send receipts.";
    case "no-payers":
      return r.payers.length === 1 ? receiptPayerText(r.payers[0]) : "No receipt sent. See each payer below.";
    default:
      return "Could not send the receipt. Try Resend receipt in a few minutes.";
  }
}

/**
 * How many receipts marking these payers paid would send: payers among
 * `ids` not paid yet, with an email address and a share above $0. The
 * server's count is never higher (it also drops test-mode addresses and
 * receipts already sent), so the confirmed number always covers it.
 */
export function receiptsToConfirm(invoice: Invoice, ids: string[]): number {
  const splits = invoice.splits ?? [];
  const shares = sharesOf(splits, invoiceTotal(invoice));
  const wanted = new Set(ids);
  return splits.filter((s, n) => wanted.has(s.id) && !s.paid && EMAIL_RE.test(s.recipientEmail.trim()) && Math.round(shares[n] * 100) > 0)
    .length;
}

/** The payers "Mark as paid" on the whole invoice newly marks paid. */
export function unpaidPayerIds(invoice: Invoice): string[] {
  return (invoice.splits ?? []).filter((s) => !s.paid).map((s) => s.id);
}

/** This payer's receipt for their current payment, if one went. */
export function receiptSentAt(states: Map<string, ReceiptState> | null, split: InvoiceSplit): string | null {
  if (!states || !split.paid || !split.paidDate) return null;
  return states.get(`${split.id}|${split.paidDate.slice(0, 10)}`)?.sentAt ?? null;
}

/**
 * Does the receipt button send a second receipt? Only when a receipt is
 * known to have gone ("Resend receipt"). "Send receipt", also shown while
 * the states are unknown, asks the server for a first receipt, so a payer
 * who already got one is answered "already sent", never emailed twice.
 */
export function receiptIsResend(receiptAt: string | null): boolean {
  return receiptAt !== null;
}

/** Each payment's receipt state from the sends log (office staff may read it), or null. */
export async function loadReceiptStates(invoiceId: string): Promise<Map<string, ReceiptState> | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("automation_sends")
      .select("dedupe_key,status,sent_at,created_at,attempts")
      .eq("company_id", supabaseConfig.companyId)
      .eq("rule_kind", "payment_receipt")
      .eq("target_id", invoiceId)
      .limit(1000);
    if (error) return null;
    return receiptStates(invoiceId, (data ?? []) as ReceiptRow[]);
  } catch {
    return null;
  }
}

/** Ask the server to email receipts (after the invoice has been saved). */
export async function sendReceipts(
  invoiceId: string,
  opts: { splitIds: string[]; again: boolean; confirmed: number },
): Promise<ReceiptSendResult> {
  if (!supabase) return { sent: 0, reason: "demo", payers: [] };
  try {
    const { data, error } = await supabase.functions.invoke("send-invoice", {
      body: {
        companyId: supabaseConfig.companyId,
        invoiceId,
        receipt: true,
        again: opts.again,
        splitIds: opts.splitIds,
        ...(opts.confirmed ? { confirmed: opts.confirmed } : {}),
      },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        try {
          return parseReceiptReply(await ctx.json());
        } catch {
          /* fall through */
        }
      }
      return { sent: 0, reason: "error", payers: [] };
    }
    return parseReceiptReply(data);
  } catch {
    return { sent: 0, reason: "error", payers: [] };
  }
}
