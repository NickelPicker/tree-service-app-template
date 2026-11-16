/**
 * The Automations page lists its rules in one fixed order that follows
 * a job from estimate to review, so a rule never moves after an edit
 * (rules used to reshuffle when saved, and a timing was once typed into
 * the wrong rule). Each rule's preview uses a sample that fits it: an
 * estimate title for estimates, an invoice number only for invoices.
 * No React here, so it is unit tested on its own.
 */
import type { AutomationKind, AutomationRule } from "./types";
import { OVERDUE_BUSINESS_DAYS } from "./overdueInvoice";

export const RULE_ORDER: readonly AutomationKind[] = [
  "estimate_reminder",
  "job_reminder",
  "invoice_send",
  "invoice_reminder",
  "overdue_escalation",
  "thank_you",
  "review_request",
  "phc_renewal",
];

/** The rules in the fixed order; unknown kinds go last, by name. */
export function orderedRules(rules: readonly AutomationRule[]): AutomationRule[] {
  const rank = (k: string) => {
    const i = RULE_ORDER.indexOf(k as AutomationKind);
    return i === -1 ? RULE_ORDER.length : i;
  };
  return [...rules].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

export interface RuleSample {
  customer: string;
  amount: string;
  title: string;
  date: string;
}

/** Sample values for one rule's preview. `date` is the sample date text. */
export function sampleFor(kind: AutomationKind, date: string): RuleSample {
  const base = { customer: "Sample Customer", date };
  switch (kind) {
    case "invoice_send":
    case "invoice_reminder":
    case "overdue_escalation":
    case "thank_you":
      return { ...base, amount: "$1,250", title: "INV-1040" };
    case "phc_renewal":
      return { ...base, amount: "$480", title: "EAB program 2027" };
    case "estimate_reminder":
      return { ...base, amount: "$2,400", title: "Silver maple removal" };
    case "job_reminder":
    case "review_request":
      return { ...base, amount: "$2,400", title: "Backyard cottonwood removal" };
  }
}

/**
 * What the "Timing (days)" box means for the past-due email (business rule): never before the invoice is overdue (10 business days,
 * Mon–Fri, past its due date), and at least this many calendar days
 * past the due date. The days can only make it later.
 */
export function pastDueTimingNote(days: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(days) ? days : 0));
  const d = `${n} day${n === 1 ? "" : "s"}`;
  return (
    `Goes once the invoice is overdue: at least ${OVERDUE_BUSINESS_DAYS} business days ` +
    `(Mon–Fri) past its due date, and at least ${d} past it, whichever is later. ` +
    `Fewer days never makes it go sooner.`
  );
}
