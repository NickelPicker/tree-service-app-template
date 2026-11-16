/**
 * The invoices the automatic past-due email treats as due today, for the
 * Automations page's "Right now" count and list. Same rule as the email
 * (run-automations plan.ts): unpaid / overdue / partial, received by the
 * customer, not split, not $0 (invoiceMayBeChased), and today on or after
 * pastDueEmailDay (10 business days past the due date, Denver, and at
 * least the rule's Timing days). Invoices already emailed (sends log) are
 * not known here, so they still count.
 */
import type { Invoice } from "./types";
import {
  invoiceMayBeChased,
  pastDueEmailDay,
  type InvoiceRow,
} from "../supabase/functions/run-automations/plan.ts";

const UNPAID = new Set(["unpaid", "overdue", "partial"]);

/** The app's invoice in the database's shape, as the email rule reads it. */
export function invoiceRowOf(i: Invoice): InvoiceRow {
  return {
    id: i.id,
    number: i.number,
    customer_id: i.customerId,
    job_id: i.jobId,
    status: i.status,
    issued_date: i.issuedDate,
    due_date: i.dueDate,
    paid_date: i.paidDate,
    lines: i.lines,
    tax_rate: i.taxRate,
    discount_type: i.discountType,
    discount_value: i.discountValue,
    auto_send_status: i.autoSendStatus ?? null,
    auto_created: i.autoCreated ?? null,
    email_queued_at: i.emailQueuedAt,
    emailed_at: i.emailedAt ?? null,
    splits: i.splits,
  };
}

/** Same clamp as the server's rule timing (whole days, 0 to 365). */
function timing(days: number): number {
  const n = Math.floor(Number.isFinite(days) ? days : 0);
  return n < 0 ? 0 : Math.min(n, 365);
}

export function pastDueEmailInvoices(invoices: Invoice[], timingDays: number, today: string): Invoice[] {
  const days = timing(timingDays);
  return invoices.filter((i) => {
    if (!UNPAID.has(i.status)) return false;
    const due = /^\d{4}-\d{2}-\d{2}/.test(i.dueDate ?? "") ? i.dueDate.slice(0, 10) : "";
    if (!due) return false;
    if (!invoiceMayBeChased(invoiceRowOf(i))) return false;
    return pastDueEmailDay(due, days) <= today;
  });
}
