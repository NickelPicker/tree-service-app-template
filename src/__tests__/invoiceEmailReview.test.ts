// Business rule: accepting an estimate emails only the office; the
// customer's one email is the invoice (thank-you + invoice + How to
// pay), and "Review us" is in it only when the sender asks for it.
import { describe, expect, it, vi } from "vitest";
import {
  claimRefused,
  composeInvoiceEmailByHand,
  invoiceAmounts,
  invoiceDedupeKey,
  reviewLink,
  type InvoiceCompany,
  type InvoiceForEmail,
} from "../../supabase/functions/_shared/invoiceEmail.ts";
import {
  composeInvoiceEmail,
  composeTestEmail,
  NEVER_AUTOMATIC,
  planAutomaticEmails,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import { invoiceEmailPreview } from "../invoicePreview";
import { invoiceSendText, parseInvoiceSendReply, sendMayHaveGone } from "../invoiceSend";
import { acceptedOnline } from "../acceptedOnline";
import { invoiceWasEmailed } from "../invoiceMaking";
import { defaultAutomations, seedState } from "../data/seed";
import type { Customer, Estimate, Invoice } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const REVIEW = "https://g.page/r/example-test/review";
const company: InvoiceCompany = {
  name: "Your Tree Company",
  phone: "555-0100",
  email: "office@example.com",
  zelleNumber: "555-0199",
  checkPayee: "Your Tree Company",
  checkMailingAddress: "1 Shop Rd, Anytown CO",
  reviewUrl: REVIEW,
};
const invoice: InvoiceForEmail = {
  number: "INV-1040",
  status: "unpaid",
  issued_date: "2026-11-16",
  due_date: "2026-12-16",
  lines: [
    { description: "Oak removal", quantity: 1, unitPrice: 1200 },
    { description: "Stump grinding", quantity: 2, unitPrice: 150 },
  ],
  tax_rate: 2,
  discount_type: "percent",
  discount_value: 10,
};

describe("the invoice email a person sends", () => {
  it("has the thank-you, the full invoice, due date and How to pay", () => {
    const m = composeInvoiceEmailByHand({ invoice, greeting: "Ann", company, askReview: false });
    expect(m.text).toContain("Hi Ann,");
    expect(m.text).toContain("Thank you for choosing Your Tree Company! Here is your invoice INV-1040.");
    expect(m.text).toContain("Oak removal: $1,200");
    expect(m.text).toContain("Stump grinding (2 x $150): $300");
    expect(m.text).toContain("Subtotal: $1,500");
    expect(m.text).toContain("Discount (10%): -$150");
    expect(m.text).toContain("Tax (2%): $27");
    expect(m.text).toContain("Total due: $1,377");
    expect(m.text).toContain("Due by Wednesday, December 16.");
    expect(m.text).toContain("Zelle — send to 555-0199.");
    expect(m.text).toContain("Check — payable to Your Tree Company, mail to 1 Shop Rd, Anytown CO.");
    expect(m.text).toContain("put invoice INV-1040 in the memo");
    expect(m.subject).toBe("Invoice INV-1040 from Your Tree Company — $1,377");
    expect(m.html).toContain("How to pay");
    expect(invoiceAmounts(invoice).total).toBe(1377);
  });

  it("has no review section unless the sender asks for one", () => {
    const m = composeInvoiceEmailByHand({ invoice, greeting: "Ann", company, askReview: false });
    expect(m.hasReview).toBe(false);
    expect(m.text).not.toContain(REVIEW);
    expect(m.html).not.toContain(REVIEW);
    expect(m.text).not.toMatch(/review/i);
    expect(m.html).not.toMatch(/review/i);
  });

  it("adds the Review us button when asked and the link is set", () => {
    const m = composeInvoiceEmailByHand({ invoice, greeting: "Ann", company, askReview: true });
    expect(m.hasReview).toBe(true);
    expect(m.text).toContain(`Review us: ${REVIEW}`);
    expect(m.html).toContain(`href="${REVIEW}"`);
    expect(m.html).toContain(">Review us</a>");
    expect(m.recordText).toBe("Invoice INV-1040 emailed to the customer, with a request for a review.");
  });

  it("asked, but no usable link: no review section", () => {
    for (const reviewUrl of ["", "   ", "javascript:alert(1)", "http://g.page/r/x", "https://user:pw@g.page/x", "not a link", "https://x y.com"]) {
      const m = composeInvoiceEmailByHand({ invoice, greeting: "Ann", company: { ...company, reviewUrl }, askReview: true });
      expect(m.hasReview).toBe(false);
      expect(m.text).not.toMatch(/review us/i);
      expect(m.html).not.toContain("javascript:");
    }
    expect(composeInvoiceEmailByHand({ invoice, greeting: "Ann", company: null, askReview: true }).hasReview).toBe(false);
  });

  it("reviewLink accepts only plain https links", () => {
    expect(reviewLink(` ${REVIEW} `)).toBe(REVIEW);
    expect(reviewLink("https://search.google.com/local/writereview?placeid=abc")).toBe(
      "https://search.google.com/local/writereview?placeid=abc",
    );
    expect(reviewLink("javascript:alert(1)")).toBe("");
    expect(reviewLink("ftp://x.com")).toBe("");
    expect(reviewLink(`https://x.com/${"a".repeat(600)}`)).toBe("");
    expect(reviewLink(42)).toBe("");
  });

  it("nothing private leaks: no money or link in the thread copy, no internal fields, HTML escaped", () => {
    const withExtras = {
      ...invoice,
      lines: [{ description: "<b>Oak</b> & co", quantity: 1, unitPrice: 100 }],
      // Fields the server never passes, but if it did they must not show.
      office_notes: "SECRET office note",
      auto_send_note: "edited",
      splits: [{ recipientEmail: "other-payer@example.com" }],
      customer_email: "ann@example.com",
    } as InvoiceForEmail;
    const m = composeInvoiceEmailByHand({ invoice: withExtras, greeting: "Ann", company, askReview: true });
    for (const out of [m.text, m.html, m.subject, m.recordText]) {
      expect(out).not.toContain("SECRET");
      expect(out).not.toContain("other-payer@example.com");
      expect(out).not.toContain("ann@example.com");
      expect(out).not.toContain("edited");
    }
    expect(m.html).not.toContain("<b>Oak</b>");
    expect(m.html).toContain("&lt;b&gt;Oak&lt;/b&gt; &amp; co");
    expect(m.recordText).not.toMatch(/\$\d/);
    expect(m.recordText).not.toContain(REVIEW);
  });

  it("a paid invoice says paid and has no How to pay", () => {
    const m = composeInvoiceEmailByHand({ invoice: { ...invoice, status: "paid" }, greeting: "", company, askReview: false });
    expect(m.text).toContain("Hi there,");
    expect(m.text).toContain("Paid in full — thank you!");
    expect(m.text).not.toContain("How to pay");
  });
});

describe("the app's preview is the same email", () => {
  const base = seedState();
  const customer: Customer = { ...base.customers[0], firstName: "Ann", email: "ann@example.com" };
  const inv: Invoice = {
    id: "i1",
    number: "INV-1040",
    customerId: customer.id,
    jobId: null,
    estimateId: null,
    lines: [{ id: "l1", description: "Oak removal", quantity: 1, unitPrice: 1200 }],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "unpaid",
    issuedDate: "2026-11-16",
    dueDate: "2026-11-16",
    paidDate: null,
    paymentMethod: null,
    emailQueuedAt: null,
    splits: [],
  };
  const profile = {
    name: "Your Tree Company",
    phone: "555-0100",
    email: "office@example.com",
    smsNumber: "",
    logoDataUrl: null,
    ownerEmail: "owner@example.com",
    sites: [],
    zelleNumber: "555-0199",
    checkPayee: "",
    checkMailingAddress: "",
    reviewUrl: REVIEW,
  };
  it("shows the Review us button only when ticked", () => {
    const off = invoiceEmailPreview(inv, customer, profile, false);
    expect(off.reviewButton).toBeUndefined();
    expect(off.body).not.toContain(REVIEW);
    expect(off.body).toContain("Due on receipt.");
    const on = invoiceEmailPreview(inv, customer, profile, true);
    expect(on.reviewButton).toBe(REVIEW);
    expect(on.body).toContain(`Review us: ${REVIEW}`);
    const server = composeInvoiceEmailByHand({
      invoice: {
        number: "INV-1040",
        status: "unpaid",
        issued_date: "2026-11-16",
        due_date: "2026-11-16",
        lines: [{ description: "Oak removal", quantity: 1, unitPrice: 1200 }],
        tax_rate: 0,
        discount_type: "none",
        discount_value: 0,
      },
      greeting: "Ann",
      company: profile,
      askReview: true,
    });
    expect(on.body).toBe(server.text);
    expect(on.subject).toBe(server.subject);
    expect(invoiceEmailPreview(inv, customer, { ...profile, reviewUrl: "" }, true).reviewButton).toBeUndefined();
  });
});

describe("no automatic review asks", () => {
  const allOn: RuleRow[] = defaultAutomations().map((r) => ({
    kind: r.kind,
    enabled: true,
    timing_days: r.timingDays,
    template: r.template,
    label: r.label,
  }));
  it("the review rule never sends, and is off by default", () => {
    expect(NEVER_AUTOMATIC.has("review_request")).toBe(true);
    expect(defaultAutomations().find((r) => r.kind === "review_request")?.enabled).toBe(false);
    const p = planAutomaticEmails({
      today: "2026-11-20",
      since: "2026-11-01",
      rules: allOn,
      customers: [{ id: "c1", first_name: "Ann", email: "ann@example.com" }],
      invoices: [
        { id: "i1", customer_id: "c1", status: "paid", issued_date: "2026-11-01", paid_date: "2026-11-16", lines: [{ quantity: 1, unitPrice: 100 }] },
      ],
      estimates: [],
      jobs: [],
      phc: [],
      company,
    });
    expect(p.emails.some((e) => e.kind === "review_request")).toBe(false);
    expect(composeTestEmail(allOn, company, true, "2026-11-20").text).not.toContain("Please review us");
  });
  it('the automatic "Done" invoice email never has a review section', () => {
    const m = composeInvoiceEmail(
      { id: "i1", number: "INV-1", customer_id: "c1", status: "unpaid", issued_date: "2026-11-16", due_date: "2026-11-16", lines: [{ quantity: 1, unitPrice: 100 }] },
      { id: "c1", first_name: "Ann" },
      null,
      company,
    );
    expect(m.text).not.toContain(REVIEW);
    expect(m.html).not.toContain(REVIEW);
    expect(m.text).not.toMatch(/review/i);
  });
});

describe("sent marker and the result line", () => {
  it("only the database's emailed_at (or the automatic email) counts as emailed", () => {
    expect(invoiceWasEmailed({ emailedAt: null, autoSendStatus: null })).toBe(false);
    expect(invoiceWasEmailed({ emailedAt: "2026-11-15T10:00:00Z", autoSendStatus: null })).toBe(true);
    expect(invoiceWasEmailed({ emailedAt: null, autoSendStatus: "sent" })).toBe(true);
    // Any date works: no cutoff day.
    expect(invoiceWasEmailed({ emailedAt: "2026-11-15T00:00:01Z", autoSendStatus: null })).toBe(true);
  });
  it("one key per real send: a double press is one email, Email again after a send is new", () => {
    expect(invoiceDedupeKey("i1", null)).toBe("invoice_emailed:i1:first");
    expect(invoiceDedupeKey("i1", "")).toBe("invoice_emailed:i1:first");
    expect(invoiceDedupeKey("i1", "2026-11-15T10:00:00Z")).toBe("invoice_emailed:i1:2026-11-15T10:00:00Z");
  });
  it("a refused claim says why", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(claimRefused("sent", "2026-11-17T11:59:00Z", false, now)).toBe("already-sent");
    expect(claimRefused("sent", "2026-11-17T11:59:00Z", true, now)).toBe("already-sent");
    expect(claimRefused("failed", null, true, now)).toBe("failed-3-times");
    expect(claimRefused(null, null, false, now)).toBe("error");
    // being sent right now: never a second one, Email again or not
    expect(claimRefused("sending", "2026-11-17T11:45:00Z", false, now)).toBe("in-progress");
    expect(claimRefused("sending", "2026-11-17T11:45:00Z", true, now)).toBe("in-progress");
    // stuck over 30 minutes: it may have gone. An ordinary press never
    // sends; only Email again (after the on-page confirm) takes it over.
    expect(claimRefused("sending", "2026-11-17T11:00:00Z", false, now)).toBe("may-have-sent");
    expect(claimRefused("sending", "2026-11-17T11:00:00Z", true, now)).toBe("reclaim");
    expect(claimRefused("sending", "not a time", true, now)).toBe("in-progress");
    for (const r of ["in-progress", "may-have-sent", "failed-3-times", "split", "blocked-test-mode"]) {
      expect(invoiceSendText({ sent: 0, reason: r })).not.toBe(invoiceSendText({ sent: 0, reason: "error" }));
    }
    expect(invoiceSendText({ sent: 0, reason: "split" })).toBe(
      "Not sent: this invoice is split between payers; email each payer by hand for now.",
    );
    expect(invoiceSendText({ sent: 0, reason: "blocked-test-mode" })).toBe("Test mode: only test addresses get emails right now.");
    expect(invoiceSendText({ sent: 1, marked: false })).toMatch(/could not mark/);
    expect(parseInvoiceSendReply({ sent: 1, marked: false })).toEqual({ sent: 1, review: false, marked: false });
    expect(invoiceSendText({ sent: 0, reason: "may-have-sent" })).toBe(
      "This invoice may already have been emailed (the send didn't finish recording). Check with the customer, or use Email again.",
    );
    // after either of these the panel only offers Email again, with its confirm
    expect(sendMayHaveGone({ sent: 0, reason: "may-have-sent" })).toBe(true);
    expect(sendMayHaveGone({ sent: 1, marked: false })).toBe(true);
    expect(sendMayHaveGone({ sent: 1 })).toBe(false);
    expect(sendMayHaveGone({ sent: 0, reason: "error" })).toBe(false);
  });
  it("reads the reply and says what happened in plain English", () => {
    expect(parseInvoiceSendReply({ sent: 1, emailedAt: "2026-11-18T15:00:00Z", review: true })).toEqual({
      sent: 1,
      emailedAt: "2026-11-18T15:00:00Z",
      review: true,
    });
    expect(parseInvoiceSendReply(null)).toEqual({ sent: 0, reason: "error" });
    expect(parseInvoiceSendReply({ sent: 2 })).toEqual({ sent: 0, reason: "error" });
    expect(invoiceSendText({ sent: 1, review: true })).toMatch(/Review us/);
    expect(invoiceSendText({ sent: 1, review: false })).toBe("Emailed to the customer.");
    expect(invoiceSendText({ sent: 0, reason: "gmail-not-set-up" })).toMatch(/^Not sent: the business Gmail/);
    expect(invoiceSendText({ sent: 0, reason: "no-review-link" })).toMatch(/Invoice settings/);
    expect(invoiceSendText({ sent: 0, reason: "auto-sending" })).toMatch(/automatically/);
  });
});

describe("Dashboard: accepted online — call to schedule", () => {
  const base = seedState();
  const est = (id: string, over: Partial<Estimate> = {}): Estimate => ({
    ...base.estimates[0],
    id,
    jobId: null,
    status: "accepted",
    title: `Estimate ${id}`,
    acceptedBy: "Ann Lee",
    acceptedAt: "2026-11-15T18:00:00Z",
    options: [],
    acceptedOptionId: null,
    ...over,
  });
  const now = new Date("2026-11-16T12:00:00Z");
  it("lists accepted-on-the-link estimates with no job, newest first", () => {
    const items = acceptedOnline(
      [
        est("a"),
        est("b", { acceptedAt: "2026-11-16T09:00:00Z" }),
        est("by-hand", { acceptedBy: null, acceptedAt: null }),
        est("has-job"),
        est("old", { acceptedAt: "2026-09-01T00:00:00Z" }),
        est("sent", { status: "sent" }),
      ],
      [{ ...base.jobs[0], id: "j1", estimateId: "has-job" }],
      base.customers,
      now,
    );
    expect(items.map((i) => i.estimateId)).toEqual(["b", "a"]);
  });
});

describe("test mode (the owner's lock)", () => {
  it("send-invoice's pre-check: only the business Gmail and test addresses while it is on", async () => {
    const { recipientAllowed } = await import("../../supabase/functions/_shared/testMode.ts");
    const biz = "business@example.com";
    expect(recipientAllowed("ann@example.com", undefined, biz, "")).toBe(false);
    expect(recipientAllowed("ann@example.com", "on", biz, "me@example.com")).toBe(false);
    expect(recipientAllowed("me@example.com", "on", biz, "me@example.com")).toBe(true);
    expect(recipientAllowed("ann@example.com", "off", biz, "")).toBe(true);
  });
});
