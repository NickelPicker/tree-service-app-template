import type { Customer } from "./types";

/**
 * Can this estimate or invoice be emailed? A customer with no email
 * address (or an obviously broken one) cannot get it, so the Send
 * button is greyed out with a plain reason instead of "Queued".
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(s: string | null | undefined): boolean {
  return EMAIL_RE.test((s ?? "").trim());
}

/** The name used in "Add Dana's email to send this". */
export function customerFirstName(c: Customer | null | undefined): string {
  if (!c) return "the customer";
  return (
    c.firstName?.trim() ||
    c.companyName?.trim() ||
    c.company?.trim() ||
    c.lastName?.trim() ||
    "the customer"
  );
}

/** Possessive: "Dana's", "James'", "the customer's". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** Null when it can be sent; otherwise the plain reason to show. */
export function sendBlockedReason(c: Customer | null | undefined): string | null {
  if (!c) return "Choose a customer first.";
  if (!isEmailAddress(c.email)) {
    return `Add ${possessive(customerFirstName(c))} email to send this.`;
  }
  return null;
}
