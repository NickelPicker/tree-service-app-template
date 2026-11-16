// Business rule: "Should the automatic past-due email also wait 10
// business days?" -> yes. The email may only go once the invoice is
// overdue by the office's rule (src/overdueInvoice.ts), and the
// Automations "Timing (days)" can only make it later.
import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  pastDueEmailDay,
  planAutomaticEmails,
  type PlanInput,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import * as shared from "../../supabase/functions/_shared/businessDays.ts";
import { addBusinessDays, businessDaysAfter, isPastDueForOffice, OVERDUE_BUSINESS_DAYS } from "../overdueInvoice";
import { pastDueTimingNote } from "../automationOrder";
import { pastDueEmailInvoices } from "../pastDueEmails";
import type { Invoice } from "../types";
import { defaultAutomations } from "../data/seed";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

function rules(days: number, extraOn: string[] = []): RuleRow[] {
  return defaultAutomations().map((r) => ({
    kind: r.kind,
    enabled: r.kind === "overdue_escalation" || extraOn.includes(r.kind),
    timing_days: r.kind === "overdue_escalation" ? days : r.timingDays,
    template: r.template,
    label: r.label,
  }));
}

const inv = (id: string, due: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: `INV-${id}`,
  customer_id: "c1",
  status: "unpaid",
  issued_date: addDays(due, -30),
  due_date: due,
  paid_date: null,
  lines: [{ quantity: 1, unitPrice: 400 }],
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
  ...extra,
});

function plan(today: string, days: number, invoices: ReturnType<typeof inv>[]): string[] {
  const input: PlanInput = {
    today,
    since: "2026-10-01",
    rules: rules(days),
    customers: [{ id: "c1", first_name: "Ann", email: "ann@example.com" }],
    invoices,
    estimates: [],
    jobs: [],
    phc: [],
    company: { name: "Your Tree Company", phone: "555-0100" },
  };
  return planAutomaticEmails(input).emails.map((e) => e.dedupeKey);
}

describe("the automatic past-due email waits 10 business days", () => {
  it("app and server share one rule (same module)", () => {
    expect(isPastDueForOffice).toBe(shared.isPastDueForOffice);
    expect(businessDaysAfter).toBe(shared.businessDaysAfter);
    expect(OVERDUE_BUSINESS_DAYS).toBe(10);
  });

  it("addBusinessDays skips weekends", () => {
    expect(addBusinessDays("2026-11-02", 10)).toBe("2026-11-16"); // Mon -> Mon
    expect(addBusinessDays("2026-11-06", 1)).toBe("2026-11-09"); // Fri -> Mon
    expect(addBusinessDays("2026-11-07", 10)).toBe("2026-11-20"); // Sat -> Fri
    expect(addBusinessDays("2026-11-02", 0)).toBe("2026-11-02");
    expect(addBusinessDays("", 3)).toBe("");
  });

  it("0 days: not on business day 9, sent on business day 10", () => {
    // Due Mon 2 Nov: Fri 13 Nov = 9 business days, Mon 16 Nov = 10.
    expect(pastDueEmailDay("2026-11-02", 0)).toBe("2026-11-16");
    expect(plan("2026-11-13", 0, [inv("a", "2026-11-02")])).toEqual([]);
    expect(plan("2026-11-15", 0, [inv("a", "2026-11-02")])).toEqual([]); // Sunday
    expect(plan("2026-11-16", 0, [inv("a", "2026-11-02")])).toEqual(["overdue_escalation:a"]);
  });

  it("calendar days under the floor never make it earlier", () => {
    for (const d of [0, 1, 3, 7, 13]) expect(pastDueEmailDay("2026-11-02", d)).toBe("2026-11-16");
    expect(plan("2026-11-10", 7, [inv("a", "2026-11-02")])).toEqual([]);
  });

  it("more days than the floor still wait for the days", () => {
    expect(pastDueEmailDay("2026-11-02", 14)).toBe("2026-11-16");
    expect(pastDueEmailDay("2026-11-02", 30)).toBe("2026-12-02");
    expect(plan("2026-12-01", 30, [inv("a", "2026-11-02")])).toEqual([]);
    expect(plan("2026-12-02", 30, [inv("a", "2026-11-02")])).toEqual(["overdue_escalation:a"]);
  });

  it("a weekend due date: 10 business days from the Monday after", () => {
    expect(pastDueEmailDay("2026-11-07", 0)).toBe("2026-11-20");
    expect(plan("2026-11-19", 0, [inv("a", "2026-11-07")])).toEqual([]);
    expect(plan("2026-11-20", 0, [inv("a", "2026-11-07")])).toEqual(["overdue_escalation:a"]);
  });

  it("marked overdue by hand still waits for the email", () => {
    expect(plan("2026-11-13", 0, [inv("a", "2026-11-02", { status: "overdue" })])).toEqual([]);
  });

  it("guards stay: split, paid and zero invoices are never chased", () => {
    const today = "2026-11-20";
    expect(
      plan(today, 0, [
        inv("s", "2026-11-02", { splits: [{ id: "p1", name: "X", email: "x@example.com", percent: 50 }] }),
        inv("p", "2026-11-02", { status: "paid", paid_date: "2026-11-10" }),
        inv("z", "2026-11-02", { lines: [] }),
      ]),
    ).toEqual([]);
  });

  it("parity: the email never goes on a day the office does not call it overdue", () => {
    // 400 random due dates and days settings.
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 400; k++) {
      const due = addDays("2026-01-01", rnd(700));
      const days = rnd(40);
      const day = pastDueEmailDay(due, days);
      expect(isPastDueForOffice(due, day)).toBe(true);
      expect(day >= addDays(due, days)).toBe(true);
      // The day before is either not overdue yet or not enough days yet.
      const before = addDays(day, -1);
      expect(!isPastDueForOffice(due, before) || before < addDays(due, days)).toBe(true);
    }
  });

  it("the Automations page says what the days mean", () => {
    const t = pastDueTimingNote(3);
    expect(t).toContain("10 business days");
    expect(t).toContain("at least 3 days");
    expect(t).toContain("never makes it go sooner");
    expect(pastDueTimingNote(1)).toContain("at least 1 day past");
  });
});

describe("Automations 'Right now' for the past-due rule matches the email", () => {
  const app = (id: string, due: string, extra: Partial<Invoice> = {}): Invoice => ({
    id,
    number: `INV-${id}`,
    customerId: "c1",
    jobId: null,
    estimateId: null,
    lines: [{ id: "l1", description: "Work", quantity: 1, unitPrice: 400 }] as Invoice["lines"],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "unpaid",
    issuedDate: addDays(due, -30),
    dueDate: due,
    paidDate: null,
    paymentMethod: null,
    emailQueuedAt: null,
    splits: [],
    ...extra,
  });

  it("counts only invoices the email would treat as due", () => {
    const invoices = [
      app("a", "2026-11-02"), // 10 business days on 16 Nov
      app("b", "2026-11-03"), // 9 business days on 16 Nov
      app("h", "2026-11-03", { status: "overdue" }), // marked by hand: email still waits
      app("p", "2026-10-01", { status: "paid", paidDate: "2026-10-05" }),
      app("z", "2026-10-01", { lines: [] }),
      app("s", "2026-10-01", { splits: [{ id: "p1" } as Invoice["splits"][number]] }),
      app("w", "2026-10-01", { autoCreated: true, autoSendStatus: "waiting" }), // never reached the customer
    ];
    expect(pastDueEmailInvoices(invoices, 0, "2026-11-16").map((i) => i.id)).toEqual(["a"]);
    expect(pastDueEmailInvoices(invoices, 0, "2026-11-17").map((i) => i.id)).toEqual(["a", "b", "h"]);
    // Timing 30: only after 30 calendar days too.
    expect(pastDueEmailInvoices(invoices, 30, "2026-12-01").map((i) => i.id)).toEqual([]);
    expect(pastDueEmailInvoices(invoices, 30, "2026-12-02").map((i) => i.id)).toEqual(["a"]);
  });

  it("agrees with the server plan, invoice by invoice, over 300 random cases", () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 300; k++) {
      const today = addDays("2026-11-01", rnd(60));
      const due = addDays(today, -rnd(40)); // within the server's 14-day catch-up for most
      const days = rnd(25);
      const onPage = pastDueEmailInvoices([app("x", due)], days, today).length === 1;
      const server = plan(today, days, [inv("x", due)]).length === 1;
      // The server also skips what came due over 14 days ago (catch-up
      // window); the page still lists those. Otherwise they agree.
      if (server) expect(onPage).toBe(true);
      if (onPage && pastDueEmailDay(due, days) >= addDays(today, -14)) expect(server).toBe(true);
      if (!onPage) expect(server).toBe(false);
    }
  });
});
