/**
 * Split invoices on the invoice panel (business rule: "Each payer
 * should get an invoice for the amount they are going to pay. Make sure
 * that is an option on the invoices for us so we can send an invoice to
 * multiple people and split it up how we need to on our end.").
 *
 * The office adds payers (name, email, a percent of the total or a
 * dollar amount); the panel shows each payer's share and whether the
 * shares add up. "Email invoice" then emails each payer their own share
 * (send-invoice). Pure code; the math is the server's
 * (supabase/functions/_shared/splitShares.ts).
 */
import { EMAIL_RE, payersToConfirm } from "../supabase/functions/_shared/splitInvoiceSend.ts";
import { invoiceTotal, splitAmount, splitsCoverageWarning, splitsSendBlocked, splitsTotal } from "./splits";
import type { Invoice, InvoiceSplit } from "./types";

export interface SplitCheck {
  total: number;
  /** Sum of the payers' shares. */
  covered: number;
  /** total - covered, to the cent (negative = over). */
  left: number;
  /** 100 - the percents, when every split is a percentage. */
  leftPercent: number | null;
  /** True when the shares add up (the server would email them). */
  ok: boolean;
  /** Why the payers can't be emailed yet, or null. */
  problem: string | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The "do the shares add up" line under the payers. */
export function splitCheck(invoice: Invoice): SplitCheck {
  const splits = invoice.splits ?? [];
  const total = invoiceTotal(invoice);
  const covered = splitsTotal(splits, invoice);
  const allPercent = splits.length > 0 && splits.every((s) => s.kind === "percentage");
  const problem = splits.length === 0 ? null : (splitsSendBlocked(invoice) ?? splitsCoverageWarning(splits, invoice));
  return {
    total,
    covered,
    left: cents(total - covered),
    leftPercent: allPercent ? cents(100 - splits.reduce((s, x) => s + x.value, 0)) : null,
    ok: splits.length > 0 && problem === null,
    problem,
  };
}

/** A payer's email is one plain address (the server's rule). */
export function payerEmailOk(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Payers who can be emailed their share at all: unpaid, an email, a share above $0. */
export function emailablePayers(invoice: Invoice): InvoiceSplit[] {
  if (invoice.status === "paid") return [];
  return (invoice.splits ?? []).filter(
    (s) => !s.paid && payerEmailOk(s.recipientEmail) && Math.round(splitAmount(s, invoice) * 100) > 0,
  );
}

/**
 * How many emails one press sends at most, for the owner's two-step
 * confirm (more than 3 at once). `knownSent` = payers the sends log says
 * were emailed (an ordinary press skips them; "Email again" does not).
 */
export function payerEmailCount(
  invoice: Invoice,
  opts: { again: boolean; only?: string[]; knownSent: Set<string> },
): number {
  return payersToConfirm({
    splits: invoice.splits ?? [],
    total: invoiceTotal(invoice),
    again: opts.again,
    only: opts.only,
    knownSent: opts.knownSent,
    invoicePaid: invoice.status === "paid",
  });
}

/** A new payer: a percent or a dollar amount, whatever is left by default. */
export function newPayerDefault(invoice: Invoice, kind: "percentage" | "fixed"): number {
  const c = splitCheck(invoice);
  if (kind === "percentage") {
    if ((invoice.splits ?? []).length === 0) return 50;
    return c.leftPercent !== null ? Math.max(0, c.leftPercent) : 0;
  }
  return Math.max(0, c.left);
}
