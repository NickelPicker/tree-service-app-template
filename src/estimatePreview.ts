/**
 * The "Preview email" for an estimate, built by the very same code the
 * server uses to send it (supabase/functions/_shared/estimateEmail.ts),
 * so the preview always matches the real email: the "Review and
 * accept" button, the closing line, and no internal codes.
 */
import {
  composeEstimateEmail,
  LINK_DAYS,
  type CustomerEstimate,
} from "../supabase/functions/_shared/estimateEmail.ts";
import type { ComposedEmail } from "./email";
import type { Customer, Estimate } from "./types";

/** Stands in for the private link, which is made when the email is sent. */
export const PREVIEW_LINK = "(your private link)";

export function estimateForCustomer(e: Estimate): CustomerEstimate {
  return {
    title: e.title,
    created_date: e.createdDate,
    notes: e.notes,
    tax_rate: e.taxRate,
    discount_type: e.discountType,
    discount_value: e.discountValue,
    lines: e.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    })),
    options: (e.options ?? []).map((o) => ({
      id: o.id,
      label: o.label,
      description: o.description,
      lines: o.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
    })),
    accepted_option_id: e.acceptedOptionId ?? null,
  };
}

/** The estimate email as the customer will get it. */
export function estimateEmailPreview(
  estimate: Estimate,
  customer: Customer,
  company: { name: string; phone: string; email: string },
  now: Date = new Date(),
): ComposedEmail {
  const greeting =
    customer.firstName?.trim() ||
    customer.companyName?.trim() ||
    customer.company?.trim() ||
    "";
  const expiresAt = new Date(now.getTime() + LINK_DAYS * 86400000).toISOString();
  const email = composeEstimateEmail({
    estimate: estimateForCustomer(estimate),
    greeting,
    company,
    link: PREVIEW_LINK,
    expiresAt,
  });
  return {
    to: customer.email,
    subject: email.subject,
    threadId: "",
    body: email.text,
    acceptButton: true,
  };
}
