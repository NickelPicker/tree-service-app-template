/**
 * The "Preview email" for an invoice, built by the very same code the
 * server uses to send it (supabase/functions/_shared/invoiceEmail.ts),
 * so the preview always matches the real email: the thank-you, the full
 * invoice, "How to pay", and the "Review us" button only when asked.
 */
import {
  composeInvoiceEmailByHand,
  reviewLink,
  type InvoiceCompany,
  type InvoiceForEmail,
} from "../supabase/functions/_shared/invoiceEmail.ts";
import type { ComposedEmail } from "./email";
import { splitAmount } from "./splits";
import type { CompanyProfile, Customer, Invoice, InvoiceSplit } from "./types";

/** Only what the email shows (the same columns send-invoice reads). */
export function invoiceForEmail(i: Invoice): InvoiceForEmail {
  return {
    number: i.number,
    status: i.status,
    issued_date: i.issuedDate,
    due_date: i.dueDate,
    lines: i.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
    tax_rate: i.taxRate,
    discount_type: i.discountType ?? "none",
    discount_value: i.discountValue ?? 0,
  };
}

function companyForEmail(c: CompanyProfile | null | undefined): InvoiceCompany | null {
  if (!c) return null;
  return {
    name: c.name,
    phone: c.phone,
    email: c.email,
    zelleNumber: c.zelleNumber,
    checkPayee: c.checkPayee,
    checkMailingAddress: c.checkMailingAddress,
    reviewUrl: c.reviewUrl ?? "",
  };
}

/** The invoice email as the customer will get it. */
export function invoiceEmailPreview(
  invoice: Invoice,
  customer: Customer,
  company: CompanyProfile | null | undefined,
  askReview: boolean,
): ComposedEmail {
  const greeting =
    customer.firstName?.trim() || customer.companyName?.trim() || customer.company?.trim() || "";
  const c = companyForEmail(company);
  const email = composeInvoiceEmailByHand({ invoice: invoiceForEmail(invoice), greeting, company: c, askReview });
  return {
    to: customer.email,
    subject: email.subject,
    threadId: "",
    body: email.text,
    ...(email.hasReview ? { reviewButton: reviewLink(c?.reviewUrl) } : {}),
  };
}

/**
 * One payer's email of a split invoice, as they will get it: the
 * invoice, "Your share: $X" (the app's share math) and How to pay. Built
 * by the same code send-invoice uses, with only this payer's details.
 */
export function invoicePayerEmailPreview(
  invoice: Invoice,
  split: InvoiceSplit,
  company: CompanyProfile | null | undefined,
  askReview: boolean,
): ComposedEmail {
  const c = companyForEmail(company);
  const email = composeInvoiceEmailByHand({
    invoice: invoiceForEmail(invoice),
    greeting: split.recipientName,
    company: c,
    askReview,
    share: {
      name: split.recipientName,
      amount: splitAmount(split, invoice),
      kind: split.kind,
      ...(split.kind === "percentage" ? { percent: split.value } : {}),
    },
  });
  return {
    to: split.recipientEmail,
    subject: email.subject,
    threadId: "",
    body: email.text,
    ...(email.hasReview ? { reviewButton: reviewLink(c?.reviewUrl) } : {}),
  };
}
