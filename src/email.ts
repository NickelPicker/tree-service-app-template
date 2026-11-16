import type {
  CompanyProfile,
  Customer,
  DiscountType,
  EmailThread,
  Estimate,
  Invoice,
} from "./types";
import { daysBetweenISO, money, termsLabel, todayStr, uid } from "./utils";
import { howToPayText } from "./payments";

/**
 * Email threading model.
 *
 * One conversation thread per customer for ALL estimates, invoices, and
 * reminders. Follow-ups reuse the customer's current thread id, so a
 * customer's inbox holds one conversation instead of a new thread per
 * document. A thread expires after one year: the next send after that
 * starts a fresh thread.
 *
 * This preview only composes and queues these emails. Nothing is
 * actually delivered — real sending via a connected Gmail account is
 * Phase 2 (see README). The thread id shown in every preview is the
 * thread the message WILL use once sending is connected.
 */

export const THREAD_TTL_DAYS = 365;

function threadAgeDays(thread: EmailThread, todayIso: string): number {
  const start = new Date(thread.createdAt + "T12:00:00").getTime();
  const today = new Date(todayIso + "T12:00:00").getTime();
  return Math.floor((today - start) / 86_400_000);
}

/** The customer's current thread, or null when none exists or it expired. */
export function currentThread(
  threads: EmailThread[],
  customerId: string,
  todayIso: string = todayStr(),
): EmailThread | null {
  const t = threads.find((x) => x.customerId === customerId);
  if (!t) return null;
  if (threadAgeDays(t, todayIso) >= THREAD_TTL_DAYS) return null;
  return t;
}

/**
 * The thread id a message for this customer would use: the current
 * thread, or a note that a new thread will start (nothing is created
 * by previewing).
 */
export function threadIdForPreview(
  threads: EmailThread[],
  customerId: string,
): string {
  const t = currentThread(threads, customerId);
  return t ? t.id : "(new thread will start when this is sent)";
}

/**
 * Return the thread list with the customer's thread ensured (created or
 * rotated when expired) plus the thread id to use. Call this only when
 * actually queueing a send, not when previewing.
 */
export function ensureThread(
  threads: EmailThread[],
  customerId: string,
): { threads: EmailThread[]; threadId: string } {
  const today = todayStr();
  const existing = currentThread(threads, customerId, today);
  if (existing) return { threads, threadId: existing.id };
  const fresh: EmailThread = {
    id: `thread-${uid().slice(0, 8)}`,
    customerId,
    createdAt: today,
  };
  return {
    threads: [
      ...threads.filter((x) => x.customerId !== customerId),
      fresh,
    ],
    threadId: fresh.id,
  };
}

/** Discount-aware totals for estimates. Tax applies after the discount. */
export function estimateTotals(
  lines: Array<{ quantity: number; unitPrice: number }>,
  taxRate: number,
  discountType: DiscountType,
  discountValue: number,
): { subtotal: number; discount: number; tax: number; total: number } {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  let discount = 0;
  if (discountType === "percent") {
    discount = subtotal * (Math.min(100, Math.max(0, discountValue)) / 100);
  } else if (discountType === "fixed") {
    discount = Math.min(subtotal, Math.max(0, discountValue));
  }
  const discounted = subtotal - discount;
  const tax = discounted * (taxRate / 100);
  return { subtotal, discount, tax, total: discounted + tax };
}

/**
 * The line items that count for an estimate's value: the accepted
 * proposal option's lines when the customer accepted one, otherwise
 * the estimate's own lines. Single-option estimates always use
 * their own lines.
 */
export function estimateActiveLines(
  estimate: Estimate,
): Estimate["lines"] {
  if (estimate.acceptedOptionId && estimate.options) {
    const accepted = estimate.options.find(
      (o) => o.id === estimate.acceptedOptionId,
    );
    if (accepted) return accepted.lines;
  }
  return estimate.lines;
}

/** Totals for the accepted option (or the estimate's own lines). */
export function estimateActiveTotals(estimate: Estimate) {
  return estimateTotals(
    estimateActiveLines(estimate),
    estimate.taxRate,
    estimate.discountType,
    estimate.discountValue,
  );
}

export function discountLabel(
  discountType: DiscountType,
  discountValue: number,
): string {
  if (discountType === "percent") return `${discountValue}%`;
  if (discountType === "fixed") return money(discountValue);
  return "None";
}

export interface ComposedEmail {
  to: string;
  subject: string;
  threadId: string;
  body: string;
  /** The email has a "Review and accept" button (estimates sent with a private link). */
  acceptButton?: boolean;
  /** The email has a "Review us" button to this link (invoice email, when asked). */
  reviewButton?: string;
}

function linesBlock(
  lines: Array<{ description: string; quantity: number; unitPrice: number }>,
): string {
  if (lines.length === 0) return "  (no line items)\n";
  return lines
    .map(
      (l) =>
        `  - ${l.description || "(no description)"} — ${l.quantity} × ${money(l.unitPrice)} = ${money(l.quantity * l.unitPrice)}`,
    )
    .join("\n") + "\n";
}

/** Full estimate as searchable email body text — never a PDF. */
export function estimateEmail(
  estimate: Estimate,
  customer: Customer,
  threadId: string,
  companyName = "Your Tree Service",
): ComposedEmail {
  const t = estimateTotals(
    estimate.lines,
    estimate.taxRate,
    estimate.discountType,
    estimate.discountValue,
  );
  const options = estimate.options ?? [];
  const optionsBlock =
    options.length > 0
      ? `Options — pick the one that works for you:\n${options
          .map((o) => {
            const ot = estimateTotals(
              o.lines,
              estimate.taxRate,
              estimate.discountType,
              estimate.discountValue,
            );
            return `  ${o.label}: ${o.description}\n${linesBlock(o.lines)}    Option total: ${money(ot.total)}\n`;
          })
          .join("\n")}\n`
      : "";
  const body =
    `Hi ${customer.firstName},\n\n` +
    `Here is your estimate from ${companyName}: ${estimate.title}\n\n` +
    (optionsBlock ||
      `Line items:\n${linesBlock(estimate.lines)}\n` +
        `Subtotal: ${money(t.subtotal)}\n` +
        (estimate.discountType !== "none"
          ? `Discount (${discountLabel(estimate.discountType, estimate.discountValue)}): -${money(t.discount)}\n`
          : "") +
        `Tax (${estimate.taxRate}%): ${money(t.tax)}\n` +
        `Total: ${money(t.total)}\n\n`) +
    (estimate.notes ? `Notes: ${estimate.notes}\n\n` : "") +
    `Questions? Just reply to this email or give us a call.\n\n` +
    `${companyName}\n`;
  return {
    to: customer.email,
    subject: `Estimate: ${estimate.title} — ${money(t.total)}`,
    threadId,
    body,
  };
}

/** Full invoice as searchable email body text — never a PDF. */
export function invoiceEmail(
  invoice: Invoice,
  customer: Customer,
  threadId: string,
  companyName = "Your Tree Service",
  company: CompanyProfile | null = null,
): ComposedEmail {
  const t = estimateTotals(
    invoice.lines,
    invoice.taxRate,
    invoice.discountType ?? "none",
    invoice.discountValue ?? 0,
  );
  const payBlock = howToPayText(invoice.number, company);
  const body =
    `Hi ${customer.firstName},\n\n` +
    `Here is your invoice ${invoice.number} from ${companyName}.\n\n` +
    `Line items:\n${linesBlock(invoice.lines)}\n` +
    `Subtotal: ${money(t.subtotal)}\n` +
    ((invoice.discountType ?? "none") !== "none"
      ? `Discount (${discountLabel(invoice.discountType ?? "none", invoice.discountValue ?? 0)}): -${money(t.discount)}\n`
      : "") +
    `Tax (${invoice.taxRate}%): ${money(t.tax)}\n` +
    `Total: ${money(t.total)}\n` +
    `Due: ${invoice.dueDate} (${termsLabel(
      daysBetweenISO(invoice.issuedDate, invoice.dueDate),
    )})\n\n` +
    (payBlock ? `${payBlock}\n\n` : "") +
    `Reply to this email with any questions — your reply stays in this same conversation.\n\n` +
    `${companyName}\n`;
  return {
    to: customer.email,
    subject: `Invoice ${invoice.number} — ${money(t.total)} due ${invoice.dueDate}`,
    threadId,
    body,
  };
}

/** Render an automation template with sample values for its preview. */
export function renderTemplate(
  template: string,
  sample: { customer: string; amount: string; title: string; date: string },
): string {
  return template
    .replaceAll("{customer}", sample.customer)
    .replaceAll("{amount}", sample.amount)
    .replaceAll("{title}", sample.title)
    .replaceAll("{date}", sample.date);
}
