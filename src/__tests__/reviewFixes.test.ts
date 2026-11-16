import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  invoiceMayBeChased,
  planAutomaticEmails,
  recordLine,
  RULE_KINDS,
  type PlanInput,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import { emailDoneInvoice, emailPlanned, type Rpc } from "../../supabase/functions/run-automations/steps.ts";
import {
  acceptUrl,
  composeEstimateEmail,
  tokenFromBytes,
  type CustomerEstimate,
} from "../../supabase/functions/_shared/estimateEmail.ts";
import { jobsMarkedDone, markedAJobDone, reopenedJobWithAutoInvoice } from "../autoInvoice";
import { nextStopFor } from "../crewDay";
import { applyFieldOps, staleFieldOpIds, unsentTapsWarning, type FieldOp } from "../fieldQueue";
import { friendlyAuthError } from "../passwordReset";
import { fixedHoursFor, weeklyPayRows } from "../weeklyPay";
import { defaultAutomations, seedState } from "../data/seed";
import type { AppState, CrewMember, Invoice, Job, TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const MONEY = /\$\s?\d/;

// ---------- #1 / #2: reminders only for invoices the customer has ----------
const inv = (extra: Record<string, unknown> = {}) => ({
  id: "1",
  number: "INV-1",
  customer_id: "c1",
  status: "unpaid",
  issued_date: "2026-11-05",
  due_date: "2026-11-05",
  paid_date: null,
  lines: [{ quantity: 1, unitPrice: 500 }],
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
  ...extra,
});

describe("invoiceMayBeChased", () => {
  it("an office invoice, or an invoice emailed automatically, is chased", () => {
    expect(invoiceMayBeChased(inv())).toBe(true);
    expect(invoiceMayBeChased(inv({ auto_created: false, auto_send_status: null }))).toBe(true);
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: "sent" }))).toBe(true);
  });
  it('a "Done" invoice nobody sent is never chased (auto-send off)', () => {
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: null, email_queued_at: null }))).toBe(false);
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: "waiting" }))).toBe(false);
  });
  it("stopped and then emailed by the office: chased; stopped and never sent: not", () => {
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: "stopped", emailed_at: "2026-11-15T17:00:00Z" }))).toBe(true);
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: "stopped", emailed_at: null }))).toBe(false);
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: null, emailed_at: "2026-11-15T17:00:00Z" }))).toBe(true);
  });
  it("email_queued_at alone (older app builds write it without sending) is never proof of a send", () => {
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: "stopped", email_queued_at: "2026-11-15T17:00:00Z" }))).toBe(false);
    expect(invoiceMayBeChased(inv({ auto_created: true, auto_send_status: null, email_queued_at: "2026-11-20T23:59:00Z" }))).toBe(false);
  });
  it("the plan follows it", () => {
    const rules: RuleRow[] = defaultAutomations().map((r) => ({
      kind: r.kind,
      enabled: r.kind === "invoice_reminder",
      timing_days: r.timingDays,
      template: r.template,
      label: r.label,
    }));
    const input = (invoice: ReturnType<typeof inv>): PlanInput => ({
      today: addDays("2026-11-05", Number(rules.find((r) => r.kind === "invoice_reminder")?.timing_days ?? 0)),
      since: "2026-09-01",
      rules,
      customers: [{ id: "c1", first_name: "Ann", email: "ann@example.com" }],
      invoices: [invoice],
      estimates: [],
      jobs: [],
      phc: [],
      company: { name: "Your Tree Company" },
    });
    const unsent = planAutomaticEmails(input(inv({ auto_created: true, auto_send_status: null })));
    expect(unsent.emails).toHaveLength(0);
    const sent = planAutomaticEmails(input(inv({ auto_created: true, auto_send_status: "stopped", emailed_at: "2026-11-15T10:00:00Z" })));
    expect(sent.emails.map((e) => e.kind)).toEqual(["invoice_reminder"]);
  });
});

// ---------- #0: no money in the message thread ----------
describe("message-thread copies of automatic emails have no money", () => {
  it("every rule's line names what was sent, never an amount", () => {
    for (const k of RULE_KINDS) {
      const line = recordLine(k, "INV-1051", "Monday, November 16");
      expect(line).not.toMatch(MONEY);
      expect(line.length).toBeGreaterThan(0);
    }
    expect(recordLine("invoice_reminder", "INV-1051")).toContain("INV-1051");
  });

  it("the plan's record holds no money even when the template has {amount}", () => {
    const rules: RuleRow[] = [{ kind: "invoice_reminder", enabled: true, timing_days: 0, template: "You owe {amount}", label: "R" }];
    const plan = planAutomaticEmails({
      today: "2026-11-05",
      since: "2026-09-01",
      rules,
      customers: [{ id: "c1", first_name: "Ann", email: "ann@example.com" }],
      invoices: [inv()],
      estimates: [],
      jobs: [],
      phc: [],
      company: { name: "Your Tree Company" },
    });
    expect(plan.emails[0].text).toContain("$500");
    expect(plan.emails[0].record).not.toMatch(MONEY);
  });

  type Call = { fn: string; args: Record<string, unknown> };
  const fake = () => {
    const calls: Call[] = [];
    const rpc: Rpc = async (fn, args) => {
      calls.push({ fn, args });
      return { data: fn === "claim_automation_send" ? "s1" : true, error: null };
    };
    return { rpc, calls };
  };

  it("emailPlanned stores the record, not the email", async () => {
    const f = fake();
    await emailPlanned(
      f.rpc,
      "co",
      {
        kind: "invoice_reminder",
        dedupeKey: "k",
        targetId: "1",
        customerId: "c1",
        customerName: "Ann",
        to: "ann@example.com",
        subject: "Reminder: invoice INV-1",
        text: "You owe $500.00",
        html: "<p>You owe $500.00</p>",
        record: "Automatic email: payment reminder for INV-1",
        jobId: null,
        estimateId: null,
        dueDay: "2026-11-05",
      },
      async () => "sent",
    );
    const finish = f.calls.find((c) => c.fn === "finish_automation_send");
    expect(finish?.args.p_body).toBe("Automatic email: payment reminder for INV-1");
  });

  it('a "Done" invoice email stores a line without the total', async () => {
    const f = fake();
    await emailDoneInvoice(
      f.rpc,
      "co",
      { id: "i1", number: "INV-7", jobId: "j1", customer: { id: "c1", first_name: "Ann", email: "ann@example.com" }, customerName: "Ann" },
      () => ({ subject: "Invoice INV-7: $500.00", text: "Total: $500.00", html: "x" }),
      async () => "sent",
      async () => null,
    );
    const body = String(f.calls.find((c) => c.fn === "finish_automation_send")?.args.p_body);
    expect(body).toBe("Automatic email: invoice INV-7 sent");
  });

  const estimate: CustomerEstimate = {
    title: "Big maple",
    tax_rate: 0,
    discount_type: "none",
    discount_value: 0,
    lines: [],
    accepted_option_id: "best",
    options: [
      { id: "good", label: "Good", description: "", lines: [{ description: "Prune", quantity: 1, unitPrice: 800 }] },
      { id: "best", label: "Best", description: "", lines: [{ description: "Prune + cable", quantity: 2, unitPrice: 600 }] },
    ],
  };
  it("the estimate email's thread copy has no prices, lines or link", () => {
    const token = tokenFromBytes(new Uint8Array(32).fill(7));
    const m = composeEstimateEmail({
      estimate,
      greeting: "Ann",
      company: null,
      link: acceptUrl("https://example.netlify.app", token),
      expiresAt: "2027-01-14T00:00:00Z",
    });
    expect(m.text).toMatch(MONEY);
    expect(m.recordText).not.toMatch(MONEY);
    expect(m.recordText).not.toContain("Prune");
    expect(m.recordText).not.toContain(token);
    expect(m.recordText).toContain("Big maple");
  });
});

// ---------- #3 / #11: Done, then Undo ----------
function job(id: string, over: Partial<Job> = {}): Job {
  return {
    ...seedState().jobs[0],
    id,
    customerId: "c1",
    title: id,
    date: "2026-11-16",
    startTime: "08:00",
    status: "scheduled",
    crewIds: ["gus"],
    crewArrivals: null,
    ...over,
  } as Job;
}
const invoice = (over: Partial<Invoice> = {}): Invoice =>
  ({
    id: "inv1",
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
    ...over,
  }) as Invoice;
const st = (over: Partial<AppState>): AppState => ({ ...seedState(), ...over });

describe("Done and Undo on the screen", () => {
  it("lists the jobs a change marked done", () => {
    const prev = st({ jobs: [job("j1", { status: "in_progress" }), job("j2")] });
    const next = { ...prev, jobs: [job("j1", { status: "done" }), job("j2")] };
    expect(jobsMarkedDone(prev, next)).toEqual(["j1"]);
    expect(markedAJobDone(prev, next)).toBe(true);
    expect(jobsMarkedDone(next, next)).toEqual([]);
  });
  it("reloads after Undo when the screen holds the job's automatic invoice", () => {
    const prev = st({ jobs: [job("j1", { status: "done", invoiceId: "inv1" })], invoices: [invoice({ autoCreated: true })] });
    const next = { ...prev, jobs: [job("j1", { status: "in_progress", invoiceId: "inv1" })] };
    expect(reopenedJobWithAutoInvoice(prev, next)).toBe(true);
    const manual = { ...prev, invoices: [invoice({ autoCreated: false })] };
    expect(reopenedJobWithAutoInvoice(manual, { ...manual, jobs: next.jobs })).toBe(false);
    expect(reopenedJobWithAutoInvoice(next, prev)).toBe(false);
  });
});

// ---------- #4: fixed weekly hours ----------
const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
const next = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const person = (over: Partial<CrewMember>): CrewMember =>
  ({ id: "d", name: "Sam", role: "Office", phone: "", color: "", payType: "hourly", payAmount: 30, fixedWeeklyHours: 32, ...over }) as CrewMember;
const sheet = (crewId: string, date: string, hours: number): TimesheetEntry => ({
  id: `${crewId}-${date}`,
  crewId,
  jobId: null,
  date,
  clockIn: null,
  clockOut: null,
  hours,
  notes: "",
  location: "",
});

describe("fixed weekly hours", () => {
  it("count for an active person in a week that has started", () => {
    expect(weeklyPayRows([person({ status: "active" })], [], week, "2026-11-15")[0].pay).toBe(960);
    expect(weeklyPayRows([person({})], [], week, "2026-11-09")[0].hours).toBe(32);
  });
  it("not for someone removed or not approved yet", () => {
    expect(weeklyPayRows([person({ status: "revoked" })], [], week, "2026-11-15")).toEqual([]);
    expect(weeklyPayRows([person({ status: "pending" })], [], week, "2026-11-15")).toEqual([]);
    const clocked = weeklyPayRows([person({ status: "revoked" })], [sheet("d", "2026-11-10", 5)], week, "2026-11-15");
    expect(clocked[0].hours).toBe(5);
    expect(clocked[0].fixedHours).toBe(false);
  });
  it("not for a week that has not started", () => {
    expect(weeklyPayRows([person({ status: "active" })], [], next, "2026-11-15")).toEqual([]);
    expect(fixedHoursFor(person({}), next, "2026-11-16")).toBe(32);
  });
});

// ---------- #6: replay in tap order ----------
describe("offline taps are replayed in order", () => {
  const entry: TimesheetEntry = { ...sheet("gus", "2026-11-16", 0), id: "t1", jobId: "j1", clockIn: "07:00", hours: null };
  const ops: FieldOp[] = [
    { id: "a", kind: "status", jobId: "j1", from: "scheduled", to: "in_progress", audit: [] },
    { id: "b", kind: "status", jobId: "j1", from: "in_progress", to: "done", audit: [] },
    { id: "c", kind: "clockIn", entry, audit: [] },
    { id: "d", kind: "clockOut", entryId: "t1", at: "15:00", audit: [] },
  ];
  it("Arrived then Done, and clock in then out, all survive a reload from the server", () => {
    const fromServer = st({ jobs: [job("j1")], timesheets: [] });
    expect(staleFieldOpIds(fromServer, ops)).toEqual([]);
    const after = applyFieldOps(fromServer, ops);
    expect(after.jobs[0].status).toBe("done");
    expect(after.timesheets.find((t) => t.id === "t1")?.clockOut).toBe("15:00");
  });
  it("a tap someone else's change made pointless is still dropped", () => {
    const changed = st({ jobs: [job("j1", { status: "scheduled" })], timesheets: [] });
    expect(staleFieldOpIds(changed, [ops[1]])).toEqual(["b"]);
  });
});

// ---------- #7: sign-out warning ----------
describe("signing out with taps not sent", () => {
  it("asks first, saying they will be lost", () => {
    expect(unsentTapsWarning(0)).toBeNull();
    expect(unsentTapsWarning(1)).toContain("1 clock or job tap is not sent");
    expect(unsentTapsWarning(3)).toContain("they will be lost");
  });
});

// ---------- #8: password reset with two-step login ----------
describe("password reset with two-step login", () => {
  it("explains the code is needed first", () => {
    expect(friendlyAuthError("AAL2 session is required to update email or password when MFA is enabled.")).toBe(
      "Enter the code from your authenticator app first, then set your new password.",
    );
    expect(friendlyAuthError("insufficient_aal")).toContain("authenticator");
  });
});

// ---------- #10: the next stop skips what the person finished ----------
describe("next stop", () => {
  const today = "2026-11-16";
  const s1 = job("s1", { status: "in_progress" });
  const s2 = job("s2");
  const s3 = job("s3");
  const groundsman = () => false;
  const climber = () => true;
  const clocked = (jobId: string, out: string | null): TimesheetEntry => ({
    ...sheet("gus", today, 0),
    id: `t-${jobId}`,
    jobId,
    clockIn: "07:00",
    clockOut: out,
    hours: null,
  });

  it("a done job is skipped", () => {
    expect(nextStopFor([job("s1", { status: "done" }), s2], [], "gus", today, climber)?.id).toBe("s2");
  });
  it("a groundsman who clocked out of a job he cannot close moves on", () => {
    expect(nextStopFor([s1, s2, s3], [clocked("s1", "11:00")], "gus", today, groundsman)?.id).toBe("s2");
    // still clocked in there: it is still his stop
    expect(nextStopFor([s1, s2, s3], [clocked("s1", null)], "gus", today, groundsman)?.id).toBe("s1");
  });
  it("a later stop already started also moves him on", () => {
    expect(nextStopFor([s1, job("s2", { status: "in_progress" }), s3], [], "gus", today, groundsman)?.id).toBe("s2");
  });
  it("someone who can mark it done keeps the stop until it is done", () => {
    expect(nextStopFor([s1, s2], [clocked("s1", "11:00")], "gus", today, climber)?.id).toBe("s1");
  });
  it("nothing left: no next stop", () => {
    expect(nextStopFor([job("s1", { status: "done" })], [], "gus", today, groundsman)).toBeNull();
  });
});
