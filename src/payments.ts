import type { Customer, Invoice, PaymentMethod } from "./types";
import type { CompanyProfile } from "./types";

/**
 * Invoice payment instructions + who-pays-by-what reporting.
 *
 * How customers pay comes from the company profile (set in the
 * setup wizard, editable in Schedule → Calendar settings →
 * Company): a Zelle number, who checks are made out to, and where
 * checks are mailed. Only the ways the business actually offers are
 * ever shown — no third-party payment app is mentioned anywhere in
 * the invoice UI.
 *
 * A paid invoice records HOW it was paid (Zelle / check / cash). An
 * invoice paid before this existed has no method recorded and shows
 * "Not recorded" — the method is never guessed.
 */

/** The payment details from the company profile (all optional). */
export function paymentDetails(company: CompanyProfile | null | undefined): {
  zelleNumber: string;
  checkPayee: string;
  checkMailingAddress: string;
} {
  return {
    zelleNumber: company?.zelleNumber?.trim() ?? "",
    checkPayee: company?.checkPayee?.trim() ?? "",
    checkMailingAddress: company?.checkMailingAddress?.trim() ?? "",
  };
}

export const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "zelle", label: "Zelle" },
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
];

/** "Zelle" / "Check" / "Cash", or "Not recorded" when none was recorded. */
export function paymentMethodLabel(
  method: PaymentMethod | null | undefined,
): string {
  if (!method) return "Not recorded";
  return (
    PAYMENT_METHODS.find((m) => m.value === method)?.label ?? "Not recorded"
  );
}

/**
 * Plain-text "How to pay" block for the invoice email body. Short:
 * the ways to pay the business offers, plus the memo instruction.
 * Returns "" when the company profile has no payment details yet —
 * the caller leaves the block out instead of showing blanks.
 */
export function howToPayText(
  invoiceNumber: string,
  company: CompanyProfile | null | undefined,
): string {
  const { zelleNumber, checkPayee, checkMailingAddress } =
    paymentDetails(company);
  const lines: string[] = [];
  if (zelleNumber) lines.push(`Zelle — send to ${zelleNumber}.`);
  if (checkPayee) {
    lines.push(
      `Check — payable to ${checkPayee}` +
        (checkMailingAddress ? `, mail to ${checkMailingAddress}.` : "."),
    );
  }
  if (lines.length === 0) return "";
  return (
    `How to pay:\n` +
    lines.join("\n") +
    `\nPlease note the payment method and put invoice ${invoiceNumber} in the memo.`
  );
}

/** Per-method count + total across paid invoices. "unknown" = paid, no method recorded. */
export type PaymentMethodTotals = Record<
  PaymentMethod | "unknown",
  { count: number; total: number }
>;

export function emptyPaymentMethodTotals(): PaymentMethodTotals {
  return {
    zelle: { count: 0, total: 0 },
    check: { count: 0, total: 0 },
    cash: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
  };
}

/**
 * Totals by payment method over PAID invoices only — unpaid, overdue
 * and partial invoices never count. totalOf is the invoice-total
 * function (invoiceTotal from splits), passed in so this module stays
 * free of the email/splits import cycle.
 */
export function paymentMethodTotals(
  invoices: Invoice[],
  totalOf: (invoice: Invoice) => number,
): PaymentMethodTotals {
  const out = emptyPaymentMethodTotals();
  for (const inv of invoices) {
    if (inv.status !== "paid") continue;
    const key = inv.paymentMethod ?? "unknown";
    out[key].count += 1;
    out[key].total += totalOf(inv);
  }
  return out;
}

export interface CustomerPaymentHistory {
  customerId: string;
  customerName: string;
  paidCount: number;
  paidTotal: number;
  byMethod: PaymentMethodTotals;
}

/**
 * Per-customer payment history over PAID invoices only: which
 * customers pay by what, and how much. Only customers with at least
 * one paid invoice appear, richest first.
 */
export function paymentMethodByCustomer(
  invoices: Invoice[],
  customers: Customer[],
  totalOf: (invoice: Invoice) => number,
): CustomerPaymentHistory[] {
  const byId = new Map<string, CustomerPaymentHistory>();
  for (const inv of invoices) {
    if (inv.status !== "paid") continue;
    let row = byId.get(inv.customerId);
    if (!row) {
      const c = customers.find((x) => x.id === inv.customerId);
      row = {
        customerId: inv.customerId,
        customerName: c
          ? `${c.firstName} ${c.lastName}`.trim() || "Unknown customer"
          : "Unknown customer",
        paidCount: 0,
        paidTotal: 0,
        byMethod: emptyPaymentMethodTotals(),
      };
      byId.set(inv.customerId, row);
    }
    const key = inv.paymentMethod ?? "unknown";
    row.paidCount += 1;
    row.paidTotal += totalOf(inv);
    row.byMethod[key].count += 1;
    row.byMethod[key].total += totalOf(inv);
  }
  return [...byId.values()].sort((a, b) => b.paidTotal - a.paidTotal);
}
