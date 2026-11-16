// batch.ts — the owner's "more than 3 emails at once" rule for the
// automatic customer emails (the "mass emails wait for approval" rules).
//
// Pure code with no Deno or npm imports (the app's tests load it).
//
//   * An hourly run that would send MORE THAN 3 customer emails ("Done"
//     invoices and reminders together) sends none of them: they are held
//     in the company's open batch for the office to approve.
//   * 1 to 3 emails go as before.
//   * Emails already held (waiting) or turned down ("Don't send") are
//     never sent by a later automatic run.
//   * "Send them" sends exactly the approved items that are still due,
//     after every rule is checked again; the rest wait or are skipped.

import { isMassEmail } from "../_shared/massEmail.ts";
import { EMAIL_RE, type CustomerRow, type Plan, type RuleKind } from "./plan.ts";

/** One email put in a batch (hold_automation_emails). */
export interface HeldItem {
  kind: RuleKind;
  dedupe_key: string;
  target_id: string;
  customer_id: string;
  customer_name: string;
  due_day: string;
}

/** A batch item as the database returns it. */
export interface BatchItemRow {
  id: string;
  rule_kind: string;
  dedupe_key: string;
  target_id: string;
  customer_id: string;
  status: string;
}

export function invoiceKey(invoiceId: string): string {
  return `invoice_send:${invoiceId}`;
}

/** True when a "Done" invoice for this customer would really be emailed. */
export function customerTakesEmail(c: CustomerRow | undefined): boolean {
  return !!c && c.no_auto_emails !== true && EMAIL_RE.test((c.email ?? "").trim());
}

export type RunDecision =
  /** nothing due */
  | "none"
  /** 1 to 3: send as before */
  | "send"
  /** more than 3: hold them all for the office */
  | "hold"
  /** 1 to 3 due, but the daily limit is used up */
  | "daily-limit";

/**
 * What an hourly run does with `count` due emails. The count is every
 * email that is due, not only what this run's limit would let out, so
 * a big backlog is never trickled out 3 at a time.
 */
export function decideRun(count: number, budget: number): RunDecision {
  if (count <= 0) return "none";
  if (isMassEmail(count)) return "hold";
  return budget > 0 ? "send" : "daily-limit";
}

/** The batch rows for the emails a run holds back. */
export function heldItems(
  invoices: Array<{ id: string; customer_id: string }>,
  customers: Map<string, CustomerRow>,
  plan: Plan,
  today: string,
  nameOf: (c: CustomerRow) => string,
): HeldItem[] {
  const out: HeldItem[] = [];
  for (const inv of invoices) {
    const c = customers.get(inv.customer_id);
    if (!customerTakesEmail(c)) continue;
    out.push({
      kind: "invoice_send",
      dedupe_key: invoiceKey(inv.id),
      target_id: inv.id,
      customer_id: inv.customer_id,
      customer_name: nameOf(c!),
      due_day: today,
    });
  }
  for (const m of plan.emails) {
    out.push({
      kind: m.kind,
      dedupe_key: m.dedupeKey,
      target_id: m.targetId,
      customer_id: m.customerId,
      customer_name: m.customerName,
      due_day: m.dueDay,
    });
  }
  return out;
}

export type ApprovalAction =
  /** still due: send it (if the daily limit allows) */
  | "send"
  /** still due, but its customer already gets one today: stays in the batch */
  | "wait"
  /** not due any more (rule off, opted out, sent, invoice stopped...): skipped */
  | "skip";

/**
 * For "Send them": what happens to each approved item, given the fresh
 * re-check. `dueInvoiceIds` are the "Done" invoices that may go now
 * (still waiting, grace period over, rule on); `plan` was made with
 * `onlyKeys` = the approved reminder keys.
 */
export function approvalActions(
  items: BatchItemRow[],
  dueInvoiceIds: Set<string>,
  plan: Plan,
): Map<string, ApprovalAction> {
  const planned = new Set(plan.emails.map((m) => m.dedupeKey));
  const held = new Set(plan.heldKeys);
  const out = new Map<string, ApprovalAction>();
  for (const it of items) {
    if (it.status !== "waiting") continue;
    if (it.rule_kind === "invoice_send") {
      out.set(it.id, dueInvoiceIds.has(it.target_id) ? "send" : "skip");
    } else if (planned.has(it.dedupe_key)) out.set(it.id, "send");
    else if (held.has(it.dedupe_key)) out.set(it.id, "wait");
    else out.set(it.id, "skip");
  }
  return out;
}
