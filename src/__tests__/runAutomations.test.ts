import { describe, expect, it, vi } from "vitest";
import {
  CATCH_UP_DAYS,
  MAX_PER_DAY,
  MAX_PER_RUN,
  addDays,
  allowedNow,
  composeTestEmail,
  documentTotal,
  inSendingHours,
  localNow,
  planAutomaticEmails,
  type PlanInput,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import { parseTestReply, runOutcomeText, testResultText } from "../automationStatus";
import { defaultAutomations } from "../data/seed";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const TODAY = "2026-11-16";

function rules(on: string[], timing: Record<string, number> = {}): RuleRow[] {
  return defaultAutomations().map((r) => ({
    kind: r.kind,
    enabled: on.includes(r.kind),
    timing_days: timing[r.kind] ?? r.timingDays,
    template: r.template,
    label: r.label,
  }));
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    today: TODAY,
    since: "2026-11-01",
    rules: rules(["invoice_reminder"]),
    customers: [
      { id: "c1", first_name: "Ann", last_name: "Lee", email: "ann@example.com" },
      { id: "c2", first_name: "Bob", email: "bob@example.com" },
      { id: "c3", first_name: "Cy", email: "", no_auto_emails: false },
      { id: "c4", first_name: "Di", email: "di@example.com", no_auto_emails: true },
    ],
    invoices: [],
    estimates: [],
    jobs: [],
    phc: [],
    company: { name: "Your Tree Company", phone: "555-0100", zelleNumber: "555-0199", checkPayee: "Your Tree Company" },
    ...over,
  };
}

const inv = (id: string, customer: string, issued: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: `INV-${id}`,
  customer_id: customer,
  status: "unpaid",
  issued_date: issued,
  due_date: addDays(issued, 30),
  paid_date: null,
  lines: [{ quantity: 2, unitPrice: 500 }],
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
  ...extra,
});

describe("planAutomaticEmails", () => {
  it("sends nothing when the switch was never turned on", () => {
    const p = planAutomaticEmails(input({ since: null, invoices: [inv("1", "c1", "2026-11-09")] }));
    expect(p.emails).toHaveLength(0);
  });

  it("sends nothing when every rule is off", () => {
    const p = planAutomaticEmails(input({ rules: rules([]), invoices: [inv("1", "c1", "2026-11-09")] }));
    expect(p.emails).toHaveLength(0);
  });

  it("an invoice reminder goes out once the timing has passed, with the template filled in", () => {
    const p = planAutomaticEmails(input({ invoices: [inv("1", "c1", "2026-11-09"), inv("2", "c2", "2026-11-12")] }));
    expect(p.emails.map((e) => e.dedupeKey)).toEqual(["invoice_reminder:1"]);
    const e = p.emails[0];
    expect(e.to).toBe("ann@example.com");
    expect(e.subject).toBe("Reminder: invoice INV-1");
    expect(e.text).toContain("Hi Ann, a friendly reminder that invoice INV-1 for $1,000 is still open.");
    expect(e.text).toContain("Zelle — send to 555-0199.");
    expect(e.text).toContain('Reply "stop"');
    expect(e.html).toContain("Reply &quot;stop&quot;");
    expect(e.customerName).toBe("Ann Lee");
  });

  it("never mails the backlog from before the switch was turned on", () => {
    const p = planAutomaticEmails(
      input({ since: TODAY, invoices: [inv("old", "c1", "2026-01-01"), inv("1", "c2", "2026-11-08")] }),
    );
    expect(p.emails).toHaveLength(0);
  });

  it("leaves alone things that came due more than the catch-up window ago", () => {
    const issued = addDays(TODAY, -(7 + CATCH_UP_DAYS + 1));
    const p = planAutomaticEmails(input({ since: "2026-01-01", invoices: [inv("1", "c1", issued)] }));
    expect(p.emails).toHaveLength(0);
  });

  it("skips already-sent emails, opted-out customers and missing addresses", () => {
    const p = planAutomaticEmails(
      input({
        invoices: [inv("1", "c1", "2026-11-09"), inv("3", "c3", "2026-11-09"), inv("4", "c4", "2026-11-09")],
        done: new Set(["invoice_reminder:1"]),
      }),
    );
    expect(p.emails).toHaveLength(0);
    expect(p.skippedNoEmail).toBe(1);
    expect(p.skippedOptedOut).toBe(1);
  });

  it("at most one email per customer per run; the most urgent first", () => {
    const p = planAutomaticEmails(
      input({
        rules: rules(["invoice_reminder", "job_reminder"]),
        invoices: [inv("1", "c1", "2026-11-09")],
        jobs: [{ id: "j1", title: "Oak removal", customer_id: "c1", date: "2026-11-17", status: "scheduled" }],
      }),
    );
    expect(p.emails.map((e) => e.kind)).toEqual(["job_reminder"]);
    expect(p.heldForCustomer).toBe(1);
    expect(p.emails[0].text).toContain("Oak removal on Tuesday, November 17");
    expect(p.emails[0].jobId).toBe("j1");
  });

  it("does not email a customer who already got one today", () => {
    const p = planAutomaticEmails(
      input({ invoices: [inv("1", "c1", "2026-11-09")], emailedRecently: new Set(["c1"]) }),
    );
    expect(p.emails).toHaveLength(0);
  });

  it("job reminders only before the job, done or moved jobs are skipped", () => {
    const p = planAutomaticEmails(
      input({
        rules: rules(["job_reminder"]),
        jobs: [
          { id: "today", customer_id: "c1", date: TODAY, status: "scheduled" },
          { id: "done", customer_id: "c2", date: "2026-11-17", status: "done" },
          { id: "far", customer_id: "c2", date: "2026-11-20", status: "scheduled" },
        ],
      }),
    );
    expect(p.emails).toHaveLength(0);
  });

  it("overdue escalation, estimate follow-up, thank-you, review and PHC renewal", () => {
    const p = planAutomaticEmails(
      input({
        rules: rules(
          ["overdue_escalation", "estimate_reminder", "thank_you", "review_request", "phc_renewal"],
          { overdue_escalation: 14, estimate_reminder: 5, thank_you: 1, review_request: 3, phc_renewal: 30 },
        ),
        customers: [
          { id: "a", first_name: "A", email: "a@example.com" },
          { id: "b", first_name: "B", email: "b@example.com" },
          { id: "c", first_name: "C", email: "c@example.com" },
          { id: "d", first_name: "D", email: "d@example.com" },
          { id: "e", first_name: "E", email: "e@example.com" },
        ],
        invoices: [
          inv("o", "a", "2026-09-01", { due_date: "2026-11-02", status: "overdue" }),
          inv("t", "c", "2026-10-01", { status: "paid", paid_date: "2026-11-15" }),
          inv("r", "d", "2026-10-01", { status: "paid", paid_date: "2026-11-13" }),
        ],
        estimates: [{ id: "e1", title: "Prune maples", customer_id: "b", status: "sent", created_date: "2026-11-11", lines: [{ quantity: 1, unitPrice: 800 }] }],
        phc: [{ id: "p1", name: "EAB", customer_id: "e", status: "active", renewal_date: "2026-12-10" }],
      }),
    );
    expect(p.emails.map((e) => e.dedupeKey).sort()).toEqual([
      "estimate_reminder:e1",
      "overdue_escalation:o",
      "phc_renewal:p1:2026-12-10",
      "thank_you:r",
      "thank_you:t",
    ]);
    expect(p.emails.find((e) => e.kind === "estimate_reminder")?.text).toContain("Prune maples ($800)");
    expect(p.emails.find((e) => e.kind === "estimate_reminder")?.estimateId).toBe("e1");
  });

  it("never asks for a review by itself, even with the rule switched on", () => {
    const p = planAutomaticEmails(
      input({
        rules: rules(["review_request"]),
        invoices: [inv("r", "c1", "2026-10-01", { status: "paid", paid_date: "2026-11-13" })],
      }),
    );
    expect(p.emails).toHaveLength(0);
  });
});

describe("limits and clock", () => {
  it("throttles per run and per day", () => {
    expect(allowedNow(0)).toBe(MAX_PER_RUN);
    expect(allowedNow(MAX_PER_DAY - 3)).toBe(3);
    expect(allowedNow(MAX_PER_DAY + 10)).toBe(0);
    expect(MAX_PER_DAY).toBeLessThan(500);
  });

  it("uses Denver time and only sends in the daytime", () => {
    // 2026-11-16 15:30 UTC is 8:30 AM in Denver (MST, UTC-7).
    expect(localNow(new Date("2026-11-16T15:30:00Z"))).toEqual({ day: "2026-11-16", hour: 8 });
    expect(localNow(new Date("2026-11-17T03:00:00Z")).day).toBe("2026-11-16");
    expect(inSendingHours(7)).toBe(false);
    expect(inSendingHours(8)).toBe(true);
    expect(inSendingHours(18)).toBe(false);
  });

  it("totals match the app (discount, then tax)", () => {
    expect(documentTotal([{ quantity: 1, unitPrice: 1000 }], 10, "percent", 10)).toBe(990);
  });
});

describe("test email and page text", () => {
  it("the test email lists every rule with sample values and names no customer", () => {
    const t = composeTestEmail(rules(["invoice_reminder"]), { name: "Your Tree Company" }, false, TODAY);
    expect(t.subject).toContain("Test");
    expect(t.text).toContain("no customer was emailed");
    expect(t.text).toContain("Automatic customer emails are OFF");
    expect(t.text).toContain("Invoice reminders (On)");
    expect(t.text).toContain("Sample Customer");
  });

  it("plain-English status", () => {
    expect(runOutcomeText(null)).toContain("Not checked yet");
    const base = { startedAt: "", gmailReady: false, switchedOn: false, sent: 0, failed: 0, skipped: 0, waiting: 0 };
    expect(runOutcomeText({ ...base, outcome: "waiting-for-gmail" })).toContain("Waiting for Gmail");
    expect(runOutcomeText({ ...base, outcome: "done", sent: 3, waiting: 2 })).toBe("Sent 3, 2 waiting for the next hour.");
    expect(testResultText(parseTestReply({ sent: 0, reason: "gmail-not-set-up" }))).toContain("Waiting for Gmail");
    expect(testResultText(parseTestReply({ sent: 1 }))).toContain("No customer was emailed");
    expect(parseTestReply(null).reason).toBe("error");
  });
});
