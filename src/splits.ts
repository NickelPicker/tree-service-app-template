import type { Invoice, InvoiceSplit } from "./types";
import { estimateTotals } from "./email";
import {
  shareOf,
  sharesOf,
  sharesTotal,
  splitsCoverageWarning as sharedCoverageWarning,
  splitsSendProblem,
} from "../supabase/functions/_shared/splitShares.ts";

/** Discount-aware total for an invoice (same math as estimates). */
export function invoiceTotal(invoice: Invoice): number {
  return estimateTotals(
    invoice.lines,
    invoice.taxRate,
    invoice.discountType ?? "none",
    invoice.discountValue ?? 0,
  ).total;
}

/**
 * Split invoicing helpers. An invoice with an empty splits array is a
 * plain single-recipient invoice (billed to the customer in full).
 * With splits, each recipient's share is computed from the invoice
 * total: a percentage split takes that percent of the total; a fixed
 * split takes the fixed dollar amount. Payment is tracked per split.
 */

/** The dollar share one split owes on this invoice (shared math, see _shared/splitShares.ts). */
export function splitAmount(split: InvoiceSplit, invoice: Invoice): number {
  const splits = invoice.splits ?? [];
  const n = splits.findIndex((s) => s.id === split.id);
  const total = invoiceTotal(invoice);
  // The payer's share among all payers (rounding remainder to the last percentage payer).
  return n >= 0 ? sharesOf(splits, total)[n] : shareOf(split, total);
}

/** Total of all split shares (for the coverage check). */
export function splitsTotal(splits: InvoiceSplit[], invoice: Invoice): number {
  return sharesTotal(splits, invoiceTotal(invoice));
}

/** Amount already paid across splits. */
export function splitsPaidTotal(
  splits: InvoiceSplit[],
  invoice: Invoice,
): number {
  return splits
    .filter((s) => s.paid)
    .reduce((sum, s) => sum + splitAmount(s, invoice), 0);
}

/** Overall status implied by the splits: paid / partial / unpaid. */
export function splitsStatus(
  splits: InvoiceSplit[],
): "paid" | "partial" | "unpaid" {
  if (splits.length === 0) return "unpaid";
  if (splits.every((s) => s.paid)) return "paid";
  if (splits.some((s) => s.paid)) return "partial";
  return "unpaid";
}

/**
 * Coverage check for the editor: percentages should add to 100, or
 * fixed amounts should add to the invoice total. Returns a warning
 * string, or null when the splits cover the total. The server refuses
 * to email payers while this (or splitsSendProblem) says no.
 */
export function splitsCoverageWarning(
  splits: InvoiceSplit[],
  invoice: Invoice,
): string | null {
  return sharedCoverageWarning(splits, invoiceTotal(invoice));
}

/** Why the payers may not be emailed their shares, or null (same check as send-invoice). */
export function splitsSendBlocked(invoice: Invoice): string | null {
  return splitsSendProblem(invoice.splits ?? [], invoiceTotal(invoice));
}

/** Google Maps link for a dropped pin — what "Send to crew" shares. */
export function googleMapsPinLink(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat},${lng}`;
}
