// splitShares.ts — the split-invoice math, shared by the app
// (src/splits.ts) and the send-invoice edge function, so the share a
// payer is emailed is exactly the share the office sees on the invoice.
//
// An invoice with no splits is billed to the customer in full. With
// splits, each payer's share comes from the invoice total: a
// "percentage" split takes that percent of the total (rounded to the
// cent), a "fixed" split takes its dollar amount.
//
// Pure code with no Deno or browser globals.

export interface SplitLike {
  kind: string;
  value: number | string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The invoice total with the app's math (src/email.ts estimateTotals:
 * discount first, then tax), NOT rounded, because the app works out
 * percentage shares from the unrounded total.
 */
export function exactInvoiceTotal(
  lines: Array<{ quantity?: unknown; unitPrice?: unknown }> | null | undefined,
  taxRate: unknown,
  discountType: unknown,
  discountValue: unknown,
): number {
  const subtotal = (lines ?? []).reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0);
  let discount = 0;
  const dv = num(discountValue);
  if (discountType === "percent") discount = subtotal * (Math.min(100, Math.max(0, dv)) / 100);
  else if (discountType === "fixed") discount = Math.min(subtotal, Math.max(0, dv));
  const discounted = subtotal - discount;
  const tax = discounted * (num(taxRate) / 100);
  return discounted + tax;
}

/**
 * One split's share on its own, before the rounding fix-up: a percentage
 * of `total` rounded to the cent, or the fixed amount. Use sharesOf for
 * what a payer really owes.
 */
export function shareOf(split: SplitLike, total: number): number {
  if (split.kind === "percentage") {
    return Math.round(((total * num(split.value)) / 100) * 100) / 100;
  }
  return num(split.value);
}

/**
 * What each payer owes, in the splits' order, so that the shares add up
 * to the invoice total to the cent. Percentage shares are rounded one by
 * one, which can leave a cent over or short ($10.01 at 50/50 is $5.01 +
 * $5.01); that rounding remainder goes to the LAST percentage payer
 * ($5.01 + $5.00). The fix-up is only made when the rest is rounding,
 * at most one cent per percentage payer; a real gap (percentages not
 * adding to 100, fixed amounts not covering the total) is left alone so
 * the coverage check reports it. Fixed shares are never changed.
 */
export function sharesOf(splits: SplitLike[], total: number): number[] {
  const cents = splits.map((s) => Math.round(shareOf(s, total) * 100));
  const lastPct = splits.map((s) => s.kind === "percentage").lastIndexOf(true);
  if (lastPct >= 0) {
    const pctCount = splits.filter((s) => s.kind === "percentage").length;
    const diff = Math.round(total * 100) - cents.reduce((a, b) => a + b, 0);
    if (diff !== 0 && Math.abs(diff) <= pctCount && cents[lastPct] + diff >= 0) cents[lastPct] += diff;
  }
  return cents.map((c) => c / 100);
}

/** Sum of all shares (after the rounding fix-up), to the cent. */
export function sharesTotal(splits: SplitLike[], total: number): number {
  return Math.round(sharesOf(splits, total).reduce((sum, x) => sum + x * 100, 0)) / 100;
}

const money2 = (n: number) => `$${n.toFixed(2)}`;

/**
 * The coverage check: percentages should add to 100, fixed amounts to
 * the invoice total (mixed: the shares to the total, within a cent).
 * A warning in plain words, or null when the shares add up.
 */
export function splitsCoverageWarning(splits: SplitLike[], total: number): string | null {
  if (splits.length === 0) return null;
  const hasPercentage = splits.some((s) => s.kind === "percentage");
  const hasFixed = splits.some((s) => s.kind === "fixed");
  if (hasPercentage && !hasFixed) {
    const pct = splits.reduce((sum, s) => sum + num(s.value), 0);
    if (Math.abs(pct - 100) > 0.01) {
      return `Percentages add to ${pct}%, not 100% — ${100 - pct > 0 ? "part of the invoice is unbilled" : "the split is over 100%"}.`;
    }
    // Close to 100% is not enough on a big invoice (33.333% × 3 of
    // $10,000 bills $9,999.90): the shares must add to the total to the cent.
    const pctCovered = sharesTotal(splits, total);
    if (Math.round(pctCovered * 100) !== Math.round(total * 100)) {
      return `Percentages bill ${money2(pctCovered)} but the invoice total is ${money2(total)}.`;
    }
    return null;
  }
  const covered = sharesTotal(splits, total);
  if (Math.abs(covered - total) > 0.01) {
    return hasFixed && !hasPercentage
      ? `Fixed amounts add to ${money2(covered)} but the invoice total is ${money2(total)}.`
      : `Splits cover ${money2(covered)} but the invoice total is ${money2(total)}.`;
  }
  return null;
}

/**
 * Why a split invoice may NOT be emailed to its payers (nothing is sent
 * then), or null when it may: the total is above $0, every split is a
 * percentage or a fixed amount that is not negative, and the shares add
 * up to the total.
 */
export function splitsSendProblem(splits: SplitLike[], total: number): string | null {
  if (splits.length === 0) return null;
  if (!(Math.round(total * 100) > 0)) return "The invoice total is $0, so there is nothing to bill.";
  for (const s of splits) {
    if (s.kind !== "percentage" && s.kind !== "fixed") return "A payer's share is neither a percent nor a dollar amount.";
    const v = typeof s.value === "number" ? s.value : parseFloat(String(s.value ?? ""));
    if (!Number.isFinite(v) || v < 0) return "A payer's share is below zero or not a number.";
  }
  const warning = splitsCoverageWarning(splits, total);
  return warning ? `The payers' shares don't add up to the total. ${warning}` : null;
}
