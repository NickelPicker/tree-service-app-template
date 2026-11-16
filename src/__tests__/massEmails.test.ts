import { describe, expect, it, vi } from "vitest";
import {
  MASS_EMAIL_LIMIT,
  SECOND_TAP_DELAY_MS,
  masterSwitchTexts,
  massEmailTexts,
  needsDoubleConfirm,
  ruleOnTexts,
  tapAllowed,
} from "../doubleConfirm";
import {
  addDays,
  displayName,
  planAutomaticEmails,
  type CustomerRow,
  type PlanInput,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import {
  approvalActions,
  customerTakesEmail,
  decideRun,
  heldItems,
  invoiceKey,
} from "../../supabase/functions/run-automations/batch.ts";
import { dayPlanRecipientCount } from "../../supabase/functions/send-day-plan/compose.ts";
import { dayPlanEmailCount, dayPlanEmailMessage } from "../dayPlanEmail";
import { batchResultText, parseBatchReply, runOutcomeText } from "../automationStatus";
import { defaultAutomations } from "../data/seed";
import type { CrewMember, Job } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

describe("the owner's double confirm (more than 3 emails at once)", () => {
  it("1 to 3 emails need no extra confirm; 4 or more need both", () => {
    expect(MASS_EMAIL_LIMIT).toBe(3);
    expect([0, 1, 2, 3].map(needsDoubleConfirm)).toEqual([false, false, false, false]);
    expect([4, 5, 25, 150].map(needsDoubleConfirm)).toEqual([true, true, true, true]);
    expect(needsDoubleConfirm(Number.NaN)).toBe(false);
  });

  it("the wording says how many, in plain English", () => {
    const t = massEmailTexts(7, "Everyone on this day's jobs gets their day.");
    expect(t.first.title).toBe("Send 7 emails?");
    expect(t.first.body).toBe("Everyone on this day's jobs gets their day.");
    expect(t.first.yes).toBe("Yes, continue");
    expect(t.second.title).toBe("Are you sure?");
    expect(t.second.body).toBe("This emails 7 people now.");
    expect(t.second.yes).toBe("Yes, send 7 emails");
  });

  it("switching emails on also asks twice", () => {
    expect(masterSwitchTexts(2).first.body).toContain("2 rules");
    expect(masterSwitchTexts(2).second.yes).toBe("Yes, turn it on");
    expect(ruleOnTexts("Thank-you").first.title).toBe('Turn on "Thank-you"?');
  });

  it("the second yes ignores taps for the first 0.8 seconds", () => {
    expect(SECOND_TAP_DELAY_MS).toBe(800);
    expect(tapAllowed(1000, 1000)).toBe(false);
    expect(tapAllowed(1000, 1799)).toBe(false);
    expect(tapAllowed(1000, 1800)).toBe(true);
  });
});

// ---------- Save day: how many crew would be emailed ----------

const job = (id: string, date: string, crewIds: string[], extra: Partial<Job> = {}): Job =>
  ({ id, title: id, date, endDate: null, startTime: "08:00", customerId: "c", crewIds, status: "scheduled", ...extra }) as Job;
const person = (id: string, email: string, status: CrewMember["status"] = "active"): CrewMember =>
  ({ id, name: id, email, status }) as CrewMember;

describe("day-plan email count (before saving)", () => {
  const crew = [
    person("a", "a@example.com"),
    person("b", "b@example.com"),
    person("c", ""),
    person("d", "d@example.com", "revoked"),
    person("e", "e@example.com"),
    person("f", "f@example.com"),
  ];

  it("counts people on that day's jobs with a usable email, once each", () => {
    const jobs = [job("j1", "2026-11-16", ["a", "b", "c"]), job("j2", "2026-11-16", ["a", "d"])];
    expect(dayPlanEmailCount("2026-11-16", jobs, crew)).toBe(2);
  });

  it("leaves out finished jobs and other days, includes multi-day jobs", () => {
    const jobs = [
      job("j1", "2026-11-16", ["a"], { status: "done" }),
      job("j2", "2026-11-17", ["b"]),
      job("j3", "2026-11-15", ["e"], { endDate: "2026-11-17" }),
    ];
    expect(dayPlanEmailCount("2026-11-16", jobs, crew)).toBe(1);
  });

  it("4 people means the double confirm", () => {
    const jobs = [job("j1", "2026-11-16", ["a", "b"]), job("j2", "2026-11-16", ["e", "f"])];
    const n = dayPlanEmailCount("2026-11-16", jobs, crew);
    expect(n).toBe(4);
    expect(needsDoubleConfirm(n)).toBe(true);
  });

  it("the function counts the same way", () => {
    const n = dayPlanRecipientCount(
      "2026-11-16",
      [{ id: "j", title: null, date: "2026-11-16", start_time: null, customer_id: null, crew_ids: ["x", "y"] }],
      [
        { id: "x", name: "X", email: "x@example.com" },
        { id: "y", name: "Y", email: "not-an-email" },
      ],
    );
    expect(n).toBe(1);
  });

  it("a refused send (more than confirmed) says the day was saved", () => {
    expect(dayPlanEmailMessage({ sent: 0, skipped: 0, reason: "needs-confirm" })).toMatch(/Day saved\. No emails sent/);
  });
});

// ---------- The hourly check: more than 3 wait for approval ----------

const TODAY = "2026-11-16";

function rules(on: string[]): RuleRow[] {
  return defaultAutomations().map((r) => ({
    kind: r.kind,
    enabled: on.includes(r.kind),
    timing_days: r.timingDays,
    template: r.template,
    label: r.label,
  }));
}

const customers: CustomerRow[] = [
  { id: "c1", first_name: "Ann", last_name: "Lee", email: "ann@example.com" },
  { id: "c2", first_name: "Bob", email: "bob@example.com" },
  { id: "c3", first_name: "Cy", email: "cy@example.com" },
  { id: "c4", first_name: "Di", email: "di@example.com" },
  { id: "c5", first_name: "Ed", email: "", no_auto_emails: false },
  { id: "c6", first_name: "Fay", email: "fay@example.com", no_auto_emails: true },
];

const inv = (id: string, customer: string, issued: string) => ({
  id,
  number: `INV-${id}`,
  customer_id: customer,
  status: "unpaid",
  issued_date: issued,
  due_date: addDays(issued, 30),
  paid_date: null,
  lines: [{ quantity: 1, unitPrice: 500 }],
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    today: TODAY,
    since: "2026-11-01",
    rules: rules(["invoice_reminder"]),
    customers,
    invoices: [],
    estimates: [],
    jobs: [],
    phc: [],
    company: { name: "Your Tree Company" },
    ...over,
  };
}

describe("decideRun", () => {
  it("nothing due: nothing happens", () => {
    expect(decideRun(0, 25)).toBe("none");
  });
  it("1 to 3 emails go as before", () => {
    expect(decideRun(1, 25)).toBe("send");
    expect(decideRun(3, 25)).toBe("send");
  });
  it("more than 3 are all held, whatever the run's limit", () => {
    expect(decideRun(4, 25)).toBe("hold");
    expect(decideRun(40, 2)).toBe("hold");
    expect(decideRun(40, 0)).toBe("hold");
  });
  it("1 to 3 with the daily limit used up wait as before", () => {
    expect(decideRun(2, 0)).toBe("daily-limit");
  });
});

describe("holding a batch", () => {
  const byId = new Map(customers.map((c) => [c.id, c]));

  it("a 'Done' invoice counts only when it would really be emailed", () => {
    expect(customerTakesEmail(byId.get("c1"))).toBe(true);
    expect(customerTakesEmail(byId.get("c5"))).toBe(false); // no email
    expect(customerTakesEmail(byId.get("c6"))).toBe(false); // "No automatic emails"
    expect(customerTakesEmail(undefined)).toBe(false);
  });

  it("holds every due invoice and reminder, with name and kind for the review list", () => {
    const plan = planAutomaticEmails(
      input({ invoices: [inv("1", "c2", "2026-11-09"), inv("2", "c3", "2026-11-09"), inv("3", "c4", "2026-11-09")] }),
    );
    expect(plan.emails).toHaveLength(3);
    const done = [
      { id: "d1", customer_id: "c1" },
      { id: "d2", customer_id: "c5" },
    ];
    const items = heldItems(done, byId, plan, TODAY, displayName);
    expect(items.map((x) => `${x.kind}:${x.customer_name}`)).toEqual([
      "invoice_send:Ann Lee",
      "invoice_reminder:Bob",
      "invoice_reminder:Cy",
      "invoice_reminder:Di",
    ]);
    expect(items[0].dedupe_key).toBe(invoiceKey("d1"));
    expect(decideRun(items.length, 25)).toBe("hold");
  });

  it("emails held or turned down are left out of the next automatic run", () => {
    const invoices = [inv("1", "c2", "2026-11-09"), inv("2", "c3", "2026-11-09")];
    const plan = planAutomaticEmails(input({ invoices, done: new Set(["invoice_reminder:1"]) }));
    expect(plan.emails.map((m) => m.dedupeKey)).toEqual(["invoice_reminder:2"]);
  });
});

describe("Send them (approved batch)", () => {
  it("plans only the approved emails", () => {
    const invoices = [inv("1", "c2", "2026-11-09"), inv("2", "c3", "2026-11-09"), inv("3", "c4", "2026-11-09")];
    const plan = planAutomaticEmails(input({ invoices, onlyKeys: new Set(["invoice_reminder:1", "invoice_reminder:3"]) }));
    expect(plan.emails.map((m) => m.dedupeKey)).toEqual(["invoice_reminder:1", "invoice_reminder:3"]);
  });

  it("sends what is still due, keeps what waits for the customer, skips the rest", () => {
    // c2 has two approved reminders: only one a day per customer.
    const invoices = [inv("1", "c2", "2026-11-09"), inv("2", "c2", "2026-11-09"), inv("3", "c4", "2026-11-09")];
    const approved = ["invoice_reminder:1", "invoice_reminder:2", "invoice_reminder:3", "invoice_reminder:gone"];
    const plan = planAutomaticEmails(input({ invoices, onlyKeys: new Set(approved) }));
    expect(plan.heldKeys).toEqual(["invoice_reminder:2"]);
    const items = [
      ...approved.map((k, i) => ({ id: `i${i}`, rule_kind: "invoice_reminder", dedupe_key: k, target_id: "", customer_id: "", status: "waiting" })),
      { id: "inv-ok", rule_kind: "invoice_send", dedupe_key: "invoice_send:A", target_id: "A", customer_id: "c1", status: "waiting" },
      { id: "inv-stopped", rule_kind: "invoice_send", dedupe_key: "invoice_send:B", target_id: "B", customer_id: "c1", status: "waiting" },
      { id: "old", rule_kind: "thank_you", dedupe_key: "thank_you:x", target_id: "", customer_id: "", status: "discarded" },
    ];
    const a = approvalActions(items, new Set(["A"]), plan);
    expect(Object.fromEntries(a)).toEqual({
      i0: "send",
      i1: "wait",
      i2: "send",
      i3: "skip",
      "inv-ok": "send",
      "inv-stopped": "skip",
    });
  });

  it("a rule switched off since the batch was held: its emails are skipped", () => {
    const invoices = [inv("1", "c2", "2026-11-09")];
    const plan = planAutomaticEmails(input({ rules: rules([]), invoices, onlyKeys: new Set(["invoice_reminder:1"]) }));
    const a = approvalActions(
      [{ id: "i", rule_kind: "invoice_reminder", dedupe_key: "invoice_reminder:1", target_id: "1", customer_id: "c2", status: "waiting" }],
      new Set(),
      plan,
    );
    expect(a.get("i")).toBe("skip");
  });

  it("an opted-out customer is skipped", () => {
    const invoices = [inv("1", "c6", "2026-11-09")];
    const plan = planAutomaticEmails(input({ invoices, onlyKeys: new Set(["invoice_reminder:1"]) }));
    expect(plan.emails).toHaveLength(0);
    expect(plan.skippedOptedOut).toBe(1);
  });
});

describe("Automations page wording", () => {
  it("says when emails wait for approval", () => {
    const run = { startedAt: "", gmailReady: true, switchedOn: true, sent: 0, failed: 0, skipped: 0 };
    expect(runOutcomeText({ ...run, outcome: "needs-approval", waiting: 6 })).toMatch(/6 emails .* none were sent/);
    expect(runOutcomeText({ ...run, outcome: "waiting-for-gmail", waiting: 6 })).toMatch(/Waiting for Gmail: nothing was sent\. 6/);
    expect(runOutcomeText({ ...run, outcome: "waiting-for-gmail", waiting: 0 })).toBe("Waiting for Gmail: nothing was sent.");
  });

  it("reads the Send them reply", () => {
    expect(parseBatchReply(null).reason).toBe("error");
    const r = parseBatchReply({ sent: 4, failed: 0, skipped: 1, left: 2, reason: "daily-limit" });
    expect(batchResultText(r)).toBe(
      "Sent 4, 1 not sent (no longer due, already sent, or the customer said no), 2 still waiting (daily limit reached).",
    );
    expect(batchResultText({ sent: 0, failed: 0, skipped: 0, left: 0, reason: "gmail-not-set-up" })).toMatch(/Nothing was sent/);
    expect(batchResultText({ sent: 0, failed: 0, skipped: 0, left: 0, reason: "quiet-hours" })).toMatch(/8 AM/);
  });
});
