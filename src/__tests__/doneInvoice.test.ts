import { describe, expect, it, vi } from "vitest";
import {
  composeInvoiceEmail,
  dueText,
  planAutomaticEmails,
  type AutoInvoiceRow,
} from "../../supabase/functions/run-automations/plan.ts";
import { applyAutoSendRules, autoSendText, markedAJobDone } from "../autoInvoice";
import { defaultAutomations, seedState } from "../data/seed";
import { withNewRules } from "../data/supabaseAdapter";
import type { AppState, Invoice, Job } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const company = {
  name: "Your Tree Company",
  phone: "555-0100",
  zelleNumber: "555-0100",
  checkPayee: "Your Tree Company",
  checkMailingAddress: "1 Main St",
};

const inv: AutoInvoiceRow = {
  id: "i1",
  number: "INV-1041",
  customer_id: "c1",
  job_id: "j1",
  status: "unpaid",
  issued_date: "2026-11-16",
  due_date: "2026-11-16",
  lines: [
    { description: "Prune maple", quantity: 1, unitPrice: 800 },
    { description: "Haul away", quantity: 2, unitPrice: 50 },
  ],
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
};

describe("the Done invoice email", () => {
  it("has the lines, total, due wording, how to pay and the opt-out line", () => {
    const e = composeInvoiceEmail(inv, { id: "c1", first_name: "Rae", email: "rae@example.com" }, "", company);
    expect(e.subject).toBe("Invoice INV-1041: $900");
    expect(e.text).toContain("Hi Rae, thank you for choosing us! Your invoice INV-1041 for $900 is below. It is due on receipt.");
    expect(e.text).toContain("- Prune maple: $800");
    expect(e.text).toContain("- Haul away: 2 x $50 = $100");
    expect(e.text).toContain("Total: $900");
    expect(e.text).toContain("Zelle — send to 555-0100.");
    expect(e.text).toContain("Check — payable to Your Tree Company, mail to 1 Main St.");
    expect(e.text).toContain("Please put invoice INV-1041 in the memo.");
    expect(e.text).toContain('Reply "stop"');
    expect(e.text).not.toContain("View it online");
    expect(e.html).toContain("Prune maple");
  });

  it("adds a link only when one is given, and escapes HTML", () => {
    const e = composeInvoiceEmail(
      { ...inv, lines: [{ description: "<b>x</b>", quantity: 1, unitPrice: 10 }] },
      { id: "c1", first_name: "Rae" },
      "Hi {customer}, {title} is {amount}, due {date}.",
      company,
      "https://example.com/i/abc",
    );
    expect(e.text).toContain("View it online: https://example.com/i/abc");
    expect(e.html).not.toContain("<b>x</b>");
  });

  it("says when it is due", () => {
    expect(dueText("2026-11-16", "2026-11-16")).toBe("on receipt");
    expect(dueText("2026-11-16", "2026-12-16")).toBe("by Wednesday, December 16");
  });

  it("is never planned by the reminder rules", () => {
    const plan = planAutomaticEmails({
      today: "2026-11-16",
      since: "2026-11-01",
      rules: [{ kind: "invoice_send", enabled: true, timing_days: 0, template: "Hi" }],
      customers: [{ id: "c1", first_name: "Rae", email: "rae@example.com" }],
      invoices: [inv],
      estimates: [],
      jobs: [],
      phc: [],
      company,
    });
    expect(plan.emails).toHaveLength(0);
  });
});

function job(id: string, status: Job["status"]): Job {
  return { id, status, customerId: "c1", title: id } as unknown as Job;
}
function invoice(over: Partial<Invoice>): Invoice {
  return {
    id: "i1",
    number: "INV-1",
    customerId: "c1",
    jobId: "j1",
    estimateId: null,
    lines: [],
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
    autoSendStatus: "waiting",
    autoSendAt: "2026-11-16T22:40:00Z",
    ...over,
  };
}
function state(jobs: Job[], invoices: Invoice[]): AppState {
  return { ...seedState(), jobs, invoices };
}

describe("what cancels the automatic email on the screen", () => {
  it("an edit stops it; an unchanged copy does not", () => {
    const prev = state([job("j1", "done")], [invoice({})]);
    const same = applyAutoSendRules(prev, { ...prev, invoices: [invoice({})] });
    expect(same.invoices[0].autoSendStatus).toBe("waiting");
    const edited = applyAutoSendRules(prev, { ...prev, invoices: [invoice({ dueDate: "2026-12-01" })] });
    expect(edited.invoices[0]).toMatchObject({ autoSendStatus: "stopped", autoSendNote: "edited" });
  });

  it("reopening or deleting the job stops it", () => {
    const prev = state([job("j1", "done")], [invoice({})]);
    const reopened = applyAutoSendRules(prev, { ...prev, jobs: [job("j1", "in_progress")] });
    expect(reopened.invoices[0]).toMatchObject({ autoSendStatus: "stopped", autoSendNote: "reopened" });
    const deleted = applyAutoSendRules(prev, { ...prev, jobs: [] });
    expect(deleted.invoices[0]).toMatchObject({ autoSendStatus: "stopped", autoSendNote: "job-deleted" });
  });

  it("knows when a job was just marked done", () => {
    const prev = state([job("j1", "in_progress")], []);
    expect(markedAJobDone(prev, { ...prev, jobs: [job("j1", "done")] })).toBe(true);
    expect(markedAJobDone(prev, { ...prev, jobs: [job("j1", "scheduled")] })).toBe(false);
  });
});

describe("the line on the invoice", () => {
  const now = new Date("2026-11-16T20:00:00Z"); // 1 PM in Denver
  it("shows the send time", () => {
    expect(autoSendText(invoice({}), true, now)).toBe("Sends at 3:40 PM");
  });
  it("after 6 PM it waits for the morning", () => {
    expect(autoSendText(invoice({ autoSendAt: "2026-11-17T02:30:00Z" }), true, now)).toBe(
      "Sends tomorrow morning (after 8 AM)",
    );
  });
  it("says it will not go while the switches are off", () => {
    expect(autoSendText(invoice({}), false, now)).toContain("will not be sent");
  });
  it("explains a stop", () => {
    expect(autoSendText(invoice({ autoSendStatus: "stopped", autoSendNote: "reopened" }), true, now)).toContain(
      "the job was reopened",
    );
    expect(autoSendText(invoice({ autoSendStatus: null }), true, now)).toBeNull();
  });
});

describe("the Auto-send invoices rule", () => {
  it("is off by default", () => {
    const r = defaultAutomations().find((x) => x.kind === "invoice_send");
    expect(r?.enabled).toBe(false);
  });
  it("is added (off) to companies that saved their rules before it existed", () => {
    const saved = defaultAutomations().filter((x) => x.kind !== "invoice_send");
    const merged = withNewRules(saved);
    expect(merged.find((x) => x.kind === "invoice_send")?.enabled).toBe(false);
    expect(merged).toHaveLength(saved.length + 1);
    expect(withNewRules(merged)).toHaveLength(merged.length);
  });
});
