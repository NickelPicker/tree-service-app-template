/**
 * "Email invoice": the send-invoice edge function emails the customer
 * a thank-you, the full invoice and "How to pay" — and, only when the
 * sender ticked "Ask for a review in this email", a "Review us" button.
 * Office staff only (checked by the function). One email per press. It
 * replies with counts and a reason, never customer data. In demo mode
 * (no Supabase project) nothing is sent.
 *
 * The preview is built by the same code as the email
 * (src/invoicePreview.ts → supabase/functions/_shared/invoiceEmail.ts).
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";
import { reviewLink } from "../supabase/functions/_shared/invoiceEmail.ts";
import { lastSentByPayer } from "../supabase/functions/_shared/splitInvoiceSend.ts";
import type { CompanyProfile } from "./types";

/** One payer's outcome on a split invoice (by split id; no addresses). */
export interface PayerSendResult {
  id: string;
  sent: number;
  /** paid | no-email | no-share | already-sent | blocked-test-mode | in-progress | may-have-sent | failed-3-times | error */
  reason?: string;
  /** False when Gmail took it but the database could not record it. */
  marked?: boolean;
}

export interface InvoiceSendResult {
  sent: number;
  /**
   * demo | gmail-not-set-up | no-email | no-review-link | already-sent |
   * auto-sending | in-progress | may-have-sent | failed-3-times | split | blocked-test-mode |
   * not-saved | too-many | daily-limit | not-allowed | error;
   * split invoices: split-shares | bad-split | unknown-payer | needs-confirm | no-payers
   */
  reason?: string;
  /** split-shares: why the shares don't add up. */
  detail?: string;
  /** needs-confirm: how many emails the press would send. */
  count?: number;
  /** A split invoice: one result per payer. */
  split?: boolean;
  payers?: PayerSendResult[];
  /** When it was emailed (ISO), on success. */
  emailedAt?: string;
  /** The email had the "Review us" button. */
  review?: boolean;
  /** False when Gmail took it but the database could not record it. */
  marked?: boolean;
}

export function parseInvoiceSendReply(data: unknown): InvoiceSendResult {
  if (!data || typeof data !== "object") return { sent: 0, reason: "error" };
  const d = data as Record<string, unknown>;
  const split = d.split === true;
  // One invoice email: exactly 1. A split invoice: one per payer emailed.
  const sent = split
    ? typeof d.sent === "number" && Number.isInteger(d.sent) && d.sent > 0
      ? d.sent
      : 0
    : d.sent === 1
      ? 1
      : 0;
  const r: InvoiceSendResult = { sent };
  if (typeof d.reason === "string" && d.reason) r.reason = d.reason;
  if (typeof d.emailedAt === "string") r.emailedAt = d.emailedAt;
  if (typeof d.detail === "string" && d.detail) r.detail = d.detail.slice(0, 300);
  if (typeof d.count === "number" && Number.isFinite(d.count)) r.count = d.count;
  if (split) {
    r.split = true;
    r.payers = (Array.isArray(d.payers) ? d.payers : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string")
      .map((x) => {
        const p: PayerSendResult = { id: String(x.id), sent: x.sent === 1 ? 1 : 0 };
        if (typeof x.reason === "string" && x.reason) p.reason = x.reason;
        if (p.sent === 1 && x.marked === false) p.marked = false;
        if (p.sent === 0 && !p.reason) p.reason = "error";
        return p;
      });
  }
  if (r.sent > 0) {
    r.review = d.review === true;
    if (d.marked === false) r.marked = false;
  }
  if (r.sent === 0 && !r.reason) r.reason = "error";
  return r;
}

/** Plain-English line for the invoice panel. */
export function invoiceSendText(r: InvoiceSendResult): string {
  if (r.split && r.sent > 0) {
    const all = r.payers?.length ?? r.sent;
    const who = all === r.sent ? `all ${r.sent} payer${r.sent === 1 ? "" : "s"}` : `${r.sent} of ${all} payers`;
    if (r.marked === false) {
      return `Emailed ${who}, but the app could not mark every email as sent. Do not send again; reload the page.`;
    }
    return `Emailed ${who} their share${r.review ? ", with the “Review us” button" : ""}. See each payer below.`;
  }
  if (r.sent > 0) {
    if (r.marked === false) {
      return "Emailed to the customer, but the app could not mark it as emailed. Do not send it again; reload the page.";
    }
    return r.review
      ? "Emailed to the customer, with the “Review us” button."
      : "Emailed to the customer.";
  }
  switch (r.reason) {
    case "demo":
      return "Demo mode: no email sent.";
    case "gmail-not-set-up":
      return "Not sent: the business Gmail is not set up yet (Gmail sending is off or the app password is missing).";
    case "no-email":
      return "Not sent: this customer has no email address. Add one on the customer, then try again.";
    case "no-review-link":
      return "Not sent: there is no review link. Add your review link in Invoice settings, or untick “Ask for a review”.";
    case "already-sent":
      return "Already emailed. Use “Email again” to send it once more.";
    case "auto-sending":
      return "Not sent: this invoice is being emailed automatically right now.";
    case "may-have-sent":
      return "This invoice may already have been emailed (the send didn't finish recording). Check with the customer, or use Email again.";
    case "in-progress":
      return "Not sent: this invoice is being emailed right now. Wait a few minutes, then check before trying again.";
    case "failed-3-times":
      return "Not sent: Gmail turned this email down 3 times. Check the customer's email address; if it looks right, tell the owner.";
    case "split":
      return "Not sent: this invoice is split between payers; email each payer by hand for now.";
    case "split-shares":
      return `Not sent to anyone: the payers' shares must add up to the invoice total.${r.detail ? ` ${r.detail}` : ""}`;
    case "bad-split":
      return "Not sent to anyone: a payer on this invoice has no share set. Remove and add them again.";
    case "unknown-payer":
      return "Not sent: that payer is no longer on this invoice. Reload the page.";
    case "needs-confirm":
      return `Not sent: ${r.count ?? "more than 3"} emails at once need the two “are you sure” steps. Press Email again to confirm.`;
    case "no-payers":
      return "No payer was emailed. See each payer below.";
    case "blocked-test-mode":
      return "Test mode: only test addresses get emails right now.";
    case "not-saved":
      return "Not sent: the invoice has not finished saving. Try again in a moment.";
    case "too-many":
      return "Not sent: that's a lot of invoice emails this hour. Try again later.";
    case "daily-limit":
      return "Not sent: today's email limit is reached (Gmail allows about 500 a day). Try again tomorrow.";
    case "not-allowed":
      return "Only the office can email invoices.";
    default:
      return "Could not send the email. Try again in a few minutes.";
  }
}

/**
 * True when an email may have reached the customer without the app
 * knowing for sure: from then on the panel offers only "Email again"
 * (with its confirm), never a plain send.
 */
export function sendMayHaveGone(r: InvoiceSendResult): boolean {
  if (r.split) return false; // per payer: payerMayHaveGone
  return r.reason === "may-have-sent" || (r.sent > 0 && r.marked === false);
}

/** The review link from Invoice settings when it is usable, else "". */
export function companyReviewLink(company: CompanyProfile | null | undefined): string {
  return reviewLink(company?.reviewUrl);
}

/** One payer's line on the invoice panel. */
export function payerSendText(p: PayerSendResult): string {
  if (p.sent > 0) {
    return p.marked === false ? "Emailed, but not recorded. Do not send again; reload the page." : "Emailed just now.";
  }
  switch (p.reason) {
    case "paid":
      return "Not sent: their share is marked paid.";
    case "no-email":
      return "Not sent: no email address for this payer. Remove them and add them again with an email.";
    case "no-share":
      return "Not sent: their share is $0.";
    case "already-sent":
      return "Not sent: already emailed. Use “Email again”.";
    case "blocked-test-mode":
      return "Not sent: test mode (only test addresses get emails right now).";
    case "in-progress":
      return "Not sent: being emailed right now. Wait a few minutes, then check.";
    case "may-have-sent":
      return "May already have been emailed (the send didn't finish recording). Check with them, or use Email again.";
    case "failed-3-times":
      return "Not sent: Gmail turned this email down 3 times. Check the address.";
    default:
      return "Not sent: something went wrong. Try again in a few minutes.";
  }
}

/** True when this payer may have been emailed without the app knowing for sure. */
export function payerMayHaveGone(p: PayerSendResult): boolean {
  return p.reason === "may-have-sent" || (p.sent > 0 && p.marked === false);
}

/**
 * When each payer of a split invoice was last really emailed (split id
 * → ISO time), from the sends log (office staff may read it), or null
 * when it could not be read (demo mode, offline).
 */
export async function loadPayerSends(invoiceId: string): Promise<Map<string, string> | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("automation_sends")
      .select("dedupe_key,status,sent_at")
      .eq("company_id", supabaseConfig.companyId)
      .eq("rule_kind", "invoice_emailed")
      .eq("target_id", invoiceId)
      .eq("status", "sent")
      .limit(1000);
    if (error) return null;
    return lastSentByPayer(invoiceId, (data ?? []) as Array<{ dedupe_key: string; status: string; sent_at: string | null }>);
  } catch {
    return null;
  }
}

/** Ask the server to email the invoice (after it has been saved). */
export async function sendInvoiceEmail(
  invoiceId: string,
  opts: { askReview: boolean; again: boolean; splitIds?: string[]; confirmed?: number },
): Promise<InvoiceSendResult> {
  if (!supabase) return { sent: 0, reason: "demo" };
  try {
    const { data, error } = await supabase.functions.invoke("send-invoice", {
      body: {
        companyId: supabaseConfig.companyId,
        invoiceId,
        askReview: opts.askReview,
        again: opts.again,
        ...(opts.splitIds && opts.splitIds.length > 0 ? { splitIds: opts.splitIds } : {}),
        ...(opts.confirmed ? { confirmed: opts.confirmed } : {}),
      },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        try {
          return parseInvoiceSendReply(await ctx.json());
        } catch {
          /* fall through */
        }
      }
      return { sent: 0, reason: "error" };
    }
    return parseInvoiceSendReply(data);
  } catch {
    return { sent: 0, reason: "error" };
  }
}
