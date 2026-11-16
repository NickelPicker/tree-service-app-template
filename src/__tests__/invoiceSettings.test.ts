import { describe, expect, it } from "vitest";
import { INVOICE_EMAIL_KINDS, invoiceEmailTiming } from "../components/InvoiceSettingsPanel";

describe("invoice settings panel", () => {
  it("lists the four invoice emails in the order they happen", () => {
    expect(INVOICE_EMAIL_KINDS).toEqual(["invoice_send", "invoice_reminder", "overdue_escalation", "thank_you"]);
  });
  it("says when each one goes", () => {
    expect(invoiceEmailTiming("invoice_send", 0)).toBe("2 hours after a job is marked Done");
    expect(invoiceEmailTiming("invoice_reminder", 7)).toBe("7 days after the invoice is issued, while unpaid");
    expect(invoiceEmailTiming("overdue_escalation", 14)).toBe(
      "once overdue (10 business days past the due date), and at least 14 days past it",
    );
    expect(invoiceEmailTiming("thank_you", 1)).toBe("1 day after it is paid");
  });
});
