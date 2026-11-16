// steps.ts — one automatic email at a time, with the database bookkeeping
// around it. No Deno or npm imports (the app's tests load this file);
// run-automations/index.ts passes in the database calls and the mailer.
//
// The rules:
//   * Gmail refusing the whole account ("account": wrong app password, no
//     connection, daily limit) gives the claim back without counting a
//     try (release_automation_send), and the run stops.
//   * Any error after an invoice was claimed puts it back to 'waiting'
//     (and marks its send failed if the email was not tried yet), so it
//     is never stuck in 'sending'. Except once Gmail took the email: then
//     it is never put back to 'waiting' (that would let "Email invoice"
//     send it a second time); it is marked sent, or left 'sending' for
//     the next hourly check to tidy up.
//   * Test mode: an address test mode refuses is not claimed at all
//     ("blocked-test-mode"), so it uses none of its 3 tries and the
//     invoice is not touched; it goes once test mode is off.

import type { SendResult } from "../_shared/mailErrors.ts";
import { EMAIL_RE, recordLine, type CustomerRow, type PlannedEmail } from "./plan.ts";

/** A Supabase rpc call: `(fn, args) => { data, error }`. */
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export interface Outgoing {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * The customer's message-thread copy. Never the email itself: crew who
   * may not see prices can read the thread, so it holds no money.
   */
  record?: string;
}

export type Send = (m: Outgoing) => Promise<SendResult>;

/** Test mode's check (_shared/testMode.ts): may this address get email now? */
export type Allowed = (to: string) => boolean;

async function call(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn} failed`);
  return data;
}

/**
 * Emails a send that this run has claimed and records the result:
 * finish_automation_send for "sent" and "failed", release_automation_send
 * for "account". Never throws: once Gmail was asked, a bookkeeping error
 * only leaves the send row 'sending', which never sends it again.
 */
export async function sendAndRecord(
  rpc: Rpc,
  sendId: string,
  mail: Outgoing,
  send: Send,
  links: { jobId: string | null; estimateId: string | null },
): Promise<SendResult> {
  let result: SendResult;
  try {
    result = await send(mail);
  } catch {
    result = "failed";
  }
  try {
    if (result === "account") {
      await rpc("release_automation_send", { p_send_id: sendId });
    } else {
      await rpc("finish_automation_send", {
        p_send_id: sendId,
        p_ok: result === "sent",
        p_body: mail.record ?? "Automatic email sent",
        p_job_id: links.jobId,
        p_estimate_id: links.estimateId,
      });
    }
  } catch {
    // see above
  }
  return result;
}

/** A reminder from the plan: "taken" when it was sent or is being sent elsewhere. */
export async function emailPlanned(
  rpc: Rpc,
  companyId: string,
  m: PlannedEmail,
  send: Send,
  allowed: Allowed = () => true,
): Promise<SendResult | "taken" | "blocked-test-mode"> {
  if (!allowed(m.to)) return "blocked-test-mode";
  const sendId = await call(rpc, "claim_automation_send", {
    p_company_id: companyId,
    p_rule_kind: m.kind,
    p_dedupe_key: m.dedupeKey,
    p_target_id: m.targetId,
    p_customer_id: m.customerId,
    p_customer_name: m.customerName,
  });
  if (!sendId) return "taken";
  return await sendAndRecord(rpc, String(sendId), m, send, { jobId: m.jobId, estimateId: m.estimateId });
}

export type InvoiceStep =
  | SendResult
  /** stopped or taken by another check meanwhile */
  | "taken"
  /** no email address or "No automatic emails": stopped */
  | "skipped"
  /** the sends log already has it (sent before, or failed 3 times) */
  | "settled"
  /** test mode refuses the address: nothing claimed, the invoice still waits */
  | "blocked-test-mode";

export interface DoneInvoice {
  id: string;
  /** INV-1051, for the message-thread line. */
  number?: string | null;
  jobId: string | null;
  customer: CustomerRow | undefined;
  customerName: string;
}

/**
 * Emails one "Done" invoice whose grace period is over. `compose` makes
 * the email; `priorStatus` reads the sends log row for `invoice_send:<id>`.
 */
export async function emailDoneInvoice(
  rpc: Rpc,
  companyId: string,
  inv: DoneInvoice,
  compose: () => { subject: string; text: string; html: string },
  send: Send,
  priorStatus: (dedupeKey: string) => Promise<string | null>,
  allowed: Allowed = () => true,
): Promise<InvoiceStep> {
  // Test mode: checked before the invoice is claimed, so it stays
  // 'waiting' and no try is used.
  const to0 = (inv.customer?.email ?? "").trim();
  if (inv.customer && inv.customer.no_auto_emails !== true && EMAIL_RE.test(to0) && !allowed(to0)) {
    return "blocked-test-mode";
  }
  const mine = await call(rpc, "auto_invoice_send_claim", { p_invoice_id: inv.id });
  if (mine !== true) return "taken";

  const finish = (status: "sent" | "waiting" | "stopped", note?: string) =>
    call(rpc, "auto_invoice_send_finish", {
      p_invoice_id: inv.id,
      p_status: status,
      ...(note ? { p_note: note } : {}),
    });
  let sendId: string | null = null;
  let mailed = false;
  let result: SendResult | null = null;
  try {
    const cust = inv.customer;
    if (!cust || cust.no_auto_emails === true) {
      await finish("stopped", "opted-out");
      return "skipped";
    }
    const to = (cust.email ?? "").trim();
    if (!EMAIL_RE.test(to)) {
      await finish("stopped", "no-email");
      return "skipped";
    }
    const dedupeKey = `invoice_send:${inv.id}`;
    const claimed = await call(rpc, "claim_automation_send", {
      p_company_id: companyId,
      p_rule_kind: "invoice_send",
      p_dedupe_key: dedupeKey,
      p_target_id: inv.id,
      p_customer_id: cust.id,
      p_customer_name: inv.customerName,
    });
    if (!claimed) {
      // Emailed already (a check stopped half way), being emailed, or failed 3 times.
      const prior = await priorStatus(dedupeKey);
      await finish(prior === "sent" ? "sent" : "stopped", prior === "sent" ? undefined : "failed");
      return "settled";
    }
    sendId = String(claimed);
    const email = compose();
    mailed = true;
    const record = recordLine("invoice_send", (inv.number ?? "").trim());
    result = await sendAndRecord(rpc, sendId, { to, ...email, record }, send, { jobId: inv.jobId, estimateId: null });
    // A failed email waits for the next hourly check (3 tries in all);
    // an account problem does not count as a try.
    await finish(result === "sent" ? "sent" : "waiting");
    return result;
  } catch (err) {
    if (result === "sent") {
      // Gmail took it: never back to 'waiting'. One more try to mark it
      // sent; otherwise it stays 'sending' and the next hourly check
      // finds the sends log row 'sent' and marks it sent.
      try {
        await rpc("auto_invoice_send_finish", { p_invoice_id: inv.id, p_status: "sent" });
      } catch {
        // left 'sending'
      }
      throw err;
    }
    if (sendId && !mailed) {
      try {
        await rpc("finish_automation_send", { p_send_id: sendId, p_ok: false, p_body: "" });
      } catch {
        // the send row stays 'sending': never sent twice
      }
    }
    try {
      await rpc("auto_invoice_send_finish", { p_invoice_id: inv.id, p_status: "waiting" });
    } catch {
      // the 30-minute re-claim picks it up
    }
    throw err;
  }
}
