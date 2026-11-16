/**
 * "Email estimate": the send-estimate edge function emails the customer
 * the estimate with a private "Review and accept" link
 * (https://<site>/accept/<token>, 60 days, ends when the estimate
 * changes). Office staff only (checked by the function). It replies
 * with counts and a reason, never customer data. In demo mode (no
 * Supabase project) nothing is sent.
 *
 * The public accept page talks to the estimate-accept edge function;
 * see AcceptEstimate.tsx.
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";

export interface EstimateSendResult {
  sent: number;
  /**
   * demo | gmail-not-set-up | no-email | already-sent | accepted |
   * closed | not-saved | too-many | daily-limit | not-allowed | error
   */
  reason?: string;
  /** When it was emailed (ISO), on success. */
  emailedAt?: string;
  /** When an earlier link was sent, for "already-sent". */
  sentAt?: string;
}

export function parseEstimateSendReply(data: unknown): EstimateSendResult {
  if (!data || typeof data !== "object") return { sent: 0, reason: "error" };
  const d = data as Record<string, unknown>;
  const r: EstimateSendResult = { sent: d.sent === 1 ? 1 : 0 };
  if (typeof d.reason === "string" && d.reason) r.reason = d.reason;
  if (typeof d.emailedAt === "string") r.emailedAt = d.emailedAt;
  if (typeof d.sentAt === "string") r.sentAt = d.sentAt;
  if (r.sent === 0 && !r.reason) r.reason = "error";
  return r;
}

/** Plain-English line for the estimate screen. */
export function estimateSendText(r: EstimateSendResult): string {
  if (r.sent > 0) return "Emailed to the customer with a private link to accept online.";
  switch (r.reason) {
    case "demo":
      return "Demo mode: no email sent.";
    case "gmail-not-set-up":
      return "Not sent: the business Gmail is not set up yet (Gmail app password missing).";
    case "no-email":
      return "Not sent: this customer has no email address. Add one on the customer, then try again.";
    case "already-sent":
      return "Already emailed — the customer's link still works. Use \"Email again\" if they lost it.";
    case "accepted":
      return "Not sent: this estimate is already accepted.";
    case "closed":
      return "Not sent: this estimate was declined.";
    case "not-saved":
      return "Not sent: the estimate has not finished saving. Try again in a moment.";
    case "too-many":
      return "Not sent: that's a lot of estimate emails this hour. Try again later.";
    case "daily-limit":
      return "Not sent: today's email limit is reached (Gmail allows about 500 a day). Try again tomorrow.";
    case "not-allowed":
      return "Only the office can email estimates.";
    case "blocked-test-mode":
      return "Not sent: test mode is on, so only test addresses get emails. Any link they already have still works.";
    default:
      return "Could not send the email. Try again in a few minutes.";
  }
}

/** Ask the server to email the estimate (after it has been saved). */
export async function sendEstimateEmail(estimateId: string, again: boolean): Promise<EstimateSendResult> {
  if (!supabase) return { sent: 0, reason: "demo" };
  try {
    const { data, error } = await supabase.functions.invoke("send-estimate", {
      body: { companyId: supabaseConfig.companyId, estimateId, again },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        try {
          return parseEstimateSendReply(await ctx.json());
        } catch {
          /* fall through */
        }
      }
      return { sent: 0, reason: "error" };
    }
    return parseEstimateSendReply(data);
  } catch {
    return { sent: 0, reason: "error" };
  }
}

/** The /accept/<token> path, or null. */
export function acceptTokenFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/accept\/([A-Za-z0-9_-]{43})\/?$/);
  return m ? m[1] : null;
}
