import { describe, expect, it, vi } from "vitest";
import { coloradoOvertime, entryMinutes, fixedHoursOvertime } from "../overtime";
import { percentPay } from "../percentPay";
import { overtimeRuleText, payrollCsv, weeklyPayRows } from "../weeklyPay";
import {
  canMakeInvoiceForEstimate,
  canMakeInvoiceForJob,
  invoiceEmailStatus,
  jobInvoicePricing,
  nextInvoiceNumber,
  okToInvoiceWithOpenClock,
  okToMakeZeroInvoice,
  okToSendZeroInvoice,
  openClockEntriesOnJob,
  serviceTypeForEstimate,
} from "../invoiceMaking";
import { jobValue } from "../jobValue";
import { addDaysISO } from "../utils";
import type { AppState, CrewMember, Estimate, Invoice, Job, TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

// Monday Nov 9 to Sunday Nov 15, 2026.
const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];

let n = 0;
const clock = (date: string, clockIn: string, clockOut: string | null, over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: `t${++n}`,
  crewId: "a",
  jobId: null,
  date,
  clockIn,
  clockOut,
  hours: null,
  notes: "",
  location: "",
  ...over,
});
const typed = (date: string, hours: number, over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: `t${++n}`,
  crewId: "a",
  jobId: null,
  date,
  clockIn: null,
  clockOut: null,
  hours,
  notes: "",
  location: "",
  ...over,
});
const person = (over: Partial<CrewMember> = {}): CrewMember =>
  ({ id: "a", name: "Al", role: "Climber", phone: "", color: "", payType: "hourly", payAmount: 20, ...over }) as CrewMember;

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "j1",
    customerId: "c1",
    serviceType: "Removal",
    title: "Big oak",
    date: "2026-11-09",
    startTime: "08:00",
    status: "done",
    crewIds: [],
    estimateId: null,
    invoiceId: null,
    value: null,
    estimatedHours: null,
    ...over,
  }) as Job;

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1",
  number: "INV-1001",
  customerId: "c1",
  jobId: "j1",
  estimateId: null,
  lines: [{ id: "l1", description: "Work", quantity: 1, unitPrice: 5000 }],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "unpaid",
  issuedDate: "2026-11-09",
  dueDate: "2026-11-09",
  paidDate: null,
  paymentMethod: null,
  emailQueuedAt: null,
  splits: [],
  ...over,
});

const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  id: "e1",
  customerId: "c1",
  jobId: null,
  title: "Maple",
  lines: [{ id: "el", description: "Prune", quantity: 1, unitPrice: 1200 }],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "accepted",
  createdDate: "2026-11-01",
  notes: "",
  emailQueuedAt: null,
  ...over,
});

describe("Colorado overtime rules", () => {
  it("a 13-hour day: 1 hour of overtime, counted once (day and in-a-row are the same hour)", () => {
    const r = coloradoOvertime([clock("2026-11-09", "06:00", "19:00")], week);
    expect(r).toEqual({ hours: 13, regularHours: 12, overtimeHours: 1, rules: ["day", "row"] });
  });

  it("a 50-hour week of 10-hour days: 10 hours of overtime by the week rule", () => {
    const r = coloradoOvertime(week.slice(0, 5).map((d) => clock(d, "07:00", "17:00")), week);
    expect(r).toEqual({ hours: 50, regularHours: 40, overtimeHours: 10, rules: ["week"] });
  });

  it("a shift crossing midnight counts its real hours, and over 12 in a row is overtime", () => {
    // 6 PM Monday to 8 AM Tuesday: 6 h on Monday + 8 h on Tuesday, 14 in a row.
    const e = clock("2026-11-09", "18:00", "08:00");
    expect(entryMinutes(e)).toBe(14 * 60);
    const r = coloradoOvertime([e], week);
    expect(r).toEqual({ hours: 14, regularHours: 12, overtimeHours: 2, rules: ["row"] });
  });

  it("two entries split at midnight with a short break still count as one stretch", () => {
    const r = coloradoOvertime([clock("2026-11-09", "15:00", "23:30"), clock("2026-11-10", "00:00", "06:00")], week);
    expect(r.hours).toBe(14.5);
    // 15:00 to 06:00 is a 15-hour stretch (the half-hour break included):
    // the clocked hours after 03:00 are overtime.
    expect(r.overtimeHours).toBe(3);
    expect(r.rules).toEqual(["row"]);
  });

  it("a break is part of the stretch: 6:00-12:00 and 12:30-19:00 is one 13-hour stretch", () => {
    const r = coloradoOvertime([clock("2026-11-09", "06:00", "12:00"), clock("2026-11-09", "12:30", "19:00")], week);
    // 12.5 hours clocked (the gap is not added to the hours); the 13th
    // hour of the stretch, 18:00 to 19:00, is overtime. The day rule
    // alone would give only 0.5.
    expect(r.hours).toBe(12.5);
    expect(r.regularHours).toBe(11.5);
    expect(r.overtimeHours).toBe(1);
    expect(r.rules).toEqual(["day", "row"]);
  });

  it("the daily rule uses calendar days: a 22:00-02:00 shift is 2 hours on each day", () => {
    // Monday 22:00-02:00 (2 h Monday, 2 h Tuesday), then Tuesday 06:00-17:00 (11 h).
    // Tuesday: 2 + 11 = 13 h in the calendar day, so 1 hour over 12. The
    // four-hour gap ends the stretch, so no in-a-row overtime.
    const r = coloradoOvertime([clock("2026-11-09", "22:00", "02:00"), clock("2026-11-10", "06:00", "17:00")], week);
    expect(r.hours).toBe(15);
    expect(r.overtimeHours).toBe(1);
    expect(r.rules).toEqual(["day"]);
    // The same shift followed by an 11-hour Wednesday: Tuesday has only
    // its 2 hours after midnight, so no day is over 12.
    const apart = coloradoOvertime([clock("2026-11-09", "22:00", "02:00"), clock("2026-11-11", "06:00", "17:00")], week);
    expect(apart.overtimeHours).toBe(0);
  });

  it("a break of 1 hour 15 minutes or more ends the stretch (business rule)", () => {
    // 3 + 11 = 14 h with a 75-minute gap: a new stretch; no day is over 12.
    const r = coloradoOvertime([clock("2026-11-09", "20:00", "23:00"), clock("2026-11-10", "00:15", "11:15")], week);
    expect(r.overtimeHours).toBe(0);
    // A one-hour gap no longer ends it: 20:00 to 11:00 is a 15-hour stretch.
    const hour = coloradoOvertime([clock("2026-11-09", "20:00", "23:00"), clock("2026-11-10", "00:00", "11:00")], week);
    expect(hour.overtimeHours).toBeGreaterThan(0);
    expect(hour.rules).toEqual(["row"]);
  });

  it("does not double count: four 13-hour days (52 h) pay 12 overtime hours, not 4 + 12", () => {
    const r = coloradoOvertime(week.slice(0, 4).map((d) => clock(d, "06:00", "19:00")), week);
    expect(r.overtimeHours).toBe(12);
    expect(r.rules).toEqual(["week"]);
  });

  it("uses whichever gives more: three 14-hour days (42 h) pay 6 daily hours, not 2 weekly", () => {
    const r = coloradoOvertime(week.slice(0, 3).map((d) => clock(d, "05:00", "19:00")), week);
    expect(r.overtimeHours).toBe(6);
    expect(r.rules).toEqual(["day", "row"]);
  });

  it("typed hours count toward the day", () => {
    expect(coloradoOvertime([typed("2026-11-11", 13)], week).overtimeHours).toBe(1);
    // 8 typed + 5 clocked on the same day = 13.
    const r = coloradoOvertime([typed("2026-11-11", 8), clock("2026-11-11", "13:00", "18:00")], week);
    expect(r.overtimeHours).toBe(1);
    expect(r.rules).toEqual(["day"]);
  });

  it("still clocked in counts 0 and entries outside the week are ignored", () => {
    const r = coloradoOvertime([clock("2026-11-09", "06:00", null), clock("2026-11-16", "06:00", "20:00")], week);
    expect(r.hours).toBe(0);
  });
});

describe("weekly pay with overtime", () => {
  it("hourly: premium is half the rate per overtime hour", () => {
    const sheets = week.slice(0, 5).map((d) => clock(d, "07:00", "17:00"));
    const [r] = weeklyPayRows([person()], sheets, week, "2026-11-15");
    expect(r.pay).toBe(1000);
    expect(r.regularRate).toBe(20);
    expect(r.overtimeHours).toBe(10);
    expect(r.overtimePremium).toBe(100);
    expect(r.total).toBe(1100);
  });

  it("day rate: regular rate = day pay / hours worked", () => {
    // 4 days at $300, 12.5 hours each = 50 hours, $1,200: $24/h; 10 OT hours x $12 = $120.
    const sheets = week.slice(0, 4).map((d) => clock(d, "06:00", "18:30"));
    const [r] = weeklyPayRows([person({ payType: "day", payAmount: 300 })], sheets, week, "2026-11-15");
    expect(r.days).toBe(4);
    expect(r.pay).toBe(1200);
    expect(r.regularRate).toBe(24);
    expect(r.overtimeHours).toBe(10);
    expect(r.overtimePremium).toBe(120);
    expect(r.total).toBe(1320);
  });

  it("percent: regular rate = percent pay / hours worked", () => {
    // 20% of a $5,000 job paid this week = $1,000; 50 hours: $20/h, 10 OT hours x $10 = $100.
    const sheets = week.slice(0, 5).map((d) => clock(d, "07:00", "17:00", { jobId: "j1" }));
    const work = { jobs: [job()], invoices: [invoice({ status: "paid", paidDate: "2026-11-14" })] };
    const [r] = weeklyPayRows([person({ payType: "percent", payAmount: 20 })], sheets, week, "2026-11-15", work);
    expect(r.pay).toBe(1000);
    expect(r.regularRate).toBe(20);
    expect(r.overtimePremium).toBe(100);
    expect(r.total).toBe(1100);
    expect(r.percent?.paid.map((j) => j.title)).toEqual(["Big oak"]);
  });

  it("fixed weekly hours count for overtime: Sam at 32 gets none (whatever was clocked)", () => {
    const sheets = week.slice(0, 5).map((d) => clock(d, "07:00", "17:00"));
    const [sam] = weeklyPayRows([person({ fixedWeeklyHours: 32, payAmount: 30 })], sheets, week, "2026-11-15");
    expect(sam.hours).toBe(32);
    expect(sam.overtimeHours).toBe(0);
    expect(sam.overtimeRules).toEqual([]);
    expect(sam.noOvertime).toBeNull();
    expect(sam.total).toBe(960);
    expect(overtimeRuleText(sam)).toBe("");
  });

  it("fixed weekly hours over 40 are overtime: 45 fixed hours give 5", () => {
    const [r] = weeklyPayRows([person({ fixedWeeklyHours: 45, payAmount: 30 })], [], week, "2026-11-15");
    expect(r.hours).toBe(45);
    expect(r.regularHours).toBe(40);
    expect(r.overtimeHours).toBe(5);
    expect(r.overtimeRules).toEqual(["week"]);
    expect(r.pay).toBe(1350);
    expect(r.overtimePremium).toBe(75);
    expect(r.total).toBe(1425);
    expect(fixedHoursOvertime(32)).toEqual({ hours: 32, regularHours: 32, overtimeHours: 0, rules: [] });
  });

  it("1099 contractors get no overtime: 50 hours, none", () => {
    const sheets = week.slice(0, 5).map((d) => clock(d, "07:00", "17:00"));
    const [c] = weeklyPayRows([person({ employmentType: "1099" })], sheets, week, "2026-11-15");
    expect(c.hours).toBe(50);
    expect(c.overtimeHours).toBe(0);
    expect(c.noOvertime).toBe("contractor");
    expect(c.total).toBe(1000);
    expect(overtimeRuleText(c)).toBe("No overtime: 1099 contractor");
    // A 1099 person on fixed hours over 40 gets none either.
    const [f] = weeklyPayRows([person({ employmentType: "1099", fixedWeeklyHours: 45 })], [], week, "2026-11-15");
    expect(f.overtimeHours).toBe(0);
  });

  it("CSV has the overtime columns and stays formula-safe", () => {
    const sheets = [clock("2026-11-09", "06:00", "19:00")];
    const rows = weeklyPayRows([person({ name: "+Al" })], sheets, week, "2026-11-15");
    const lines = payrollCsv(rows, week[0], week[6]).trim().split("\r\n");
    expect(lines[0]).toContain("Overtime hours,Overtime rule,Pay type,Rate,Regular rate,Straight pay,Overtime premium (half time),Total pay");
    expect(lines[1]).toBe(
      "2026-11-09,2026-11-15,'+Al,Climber,1,13.00,12.00,1.00,over 12 in a day and over 12 hours in a row,Hourly,20.00,20.00,260.00,10.00,270.00,,",
    );
  });
});

describe("percent-of-job pay", () => {
  const pct = person({ payType: "percent", payAmount: 10 });
  it("a job worked on several days pays once, in the week its invoice is paid", () => {
    const sheets = [
      clock("2026-11-02", "08:00", "16:00", { jobId: "j1" }),
      clock("2026-11-03", "08:00", "16:00", { jobId: "j1" }),
    ];
    const paid = invoice({ status: "paid", paidDate: "2026-11-11" });
    const r = percentPay(pct, sheets, [job()], [paid], week);
    expect(r.paid).toHaveLength(1);
    expect(r.total).toBe(500);
    // The week the work was done is not the week it pays.
    const before = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
    expect(percentPay(pct, sheets, [job()], [paid], before).total).toBe(0);
  });

  it("uses the value before tax (after any discount)", () => {
    const inv = invoice({ status: "paid", paidDate: "2026-11-10", taxRate: 8, discountType: "percent", discountValue: 10 });
    const r = percentPay(pct, [clock("2026-11-09", "08:00", "12:00", { jobId: "j1" })], [job()], [inv], week);
    expect(r.paid[0].base).toBe(4500);
    expect(r.total).toBe(450);
  });

  it("unpaid or not-yet-invoiced jobs are waiting for payment", () => {
    const sheets = [
      clock("2026-11-09", "08:00", "12:00", { jobId: "j1" }),
      clock("2026-11-10", "08:00", "12:00", { jobId: "j2" }),
    ];
    const jobs = [job(), job({ id: "j2", title: "Elm trim" })];
    const r = percentPay(pct, sheets, jobs, [invoice()], week);
    expect(r.total).toBe(0);
    expect(r.waiting.map((j) => [j.title, j.amount, j.invoiceNumber])).toEqual([
      ["Big oak", 500, "INV-1001"],
      ["Elm trim", null, null],
    ]);
  });

  it("shows in weekly pay even with no hours that week", () => {
    const sheets = [clock("2026-11-02", "08:00", "16:00", { jobId: "j1" })];
    const work = { jobs: [job()], invoices: [invoice({ status: "paid", paidDate: "2026-11-12" })] };
    const rows = weeklyPayRows([pct], sheets, week, "2026-11-15", work);
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toBe(0);
    expect(rows[0].total).toBe(500);
    const csv = payrollCsv(rows, week[0], week[6]);
    expect(csv).toContain("Big oak (500.00)");
  });
});

describe("making an invoice from a job", () => {
  const state = (over: Partial<AppState> = {}) =>
    ({ jobs: [], invoices: [], estimates: [], timesheets: [], ...over }) as unknown as AppState;

  it("a job with no estimate is priced from its value, not $0", () => {
    const p = jobInvoicePricing(state(), job({ value: 6500 }));
    expect(p.total).toBe(6500);
    expect(p.source).toBe("job value");
    expect(p.lines[0].unitPrice).toBe(6500);
  });

  it("an hourly job is priced from hours clocked x rate (estimated hours if none clocked)", () => {
    const j = job({ billingType: "hourly", hourlyRate: 100, estimatedHours: 4 });
    expect(jobInvoicePricing(state(), j).total).toBe(400);
    const s = state({
      timesheets: [clock("2026-11-09", "08:00", "11:30", { jobId: "j1" }), clock("2026-11-09", "08:00", "12:00", { jobId: "j1", crewId: "b" })],
    });
    const p = jobInvoicePricing(s, j);
    expect(p.total).toBe(750);
    expect(p.source).toBe("hourly");
  });

  it("a job with an estimate gets the estimate's lines", () => {
    const p = jobInvoicePricing(state({ estimates: [estimate()] }), job({ estimateId: "e1", value: 50 }));
    expect(p.total).toBe(1200);
    expect(p.source).toBe("estimate");
  });

  it("no price anywhere: $0, and the office is asked first", () => {
    expect(jobInvoicePricing(state(), job()).total).toBe(0);
    const ask = vi.fn(() => false);
    expect(okToMakeZeroInvoice(0, ask)).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    const never = vi.fn(() => false);
    expect(okToMakeZeroInvoice(10, never)).toBe(true);
    expect(okToSendZeroInvoice(10, never)).toBe(true);
    expect(never).not.toHaveBeenCalled();
    expect(okToSendZeroInvoice(0, () => true)).toBe(true);
  });

  it("a $0 invoice never wipes the job's value", () => {
    const zero = invoice({ lines: [{ id: "z", description: "Removal — Big oak", quantity: 1, unitPrice: 0 }] });
    const j = job({ value: 6500, invoiceId: "i1" });
    expect(jobValue(state({ invoices: [zero], jobs: [j] }), j)).toBe(6500);
    expect(jobValue(state({ invoices: [zero], jobs: [job({ invoiceId: "i1" })] }), job({ invoiceId: "i1" }))).toBe(0);
    expect(jobValue(state({ invoices: [invoice()], jobs: [j] }), j)).toBe(5000);
  });
});

describe("when the Create invoice buttons show", () => {
  const s = (jobs: Job[], invoices: Invoice[] = []) => ({ jobs, invoices }) as unknown as AppState;
  it("only for a Done job with no invoice", () => {
    expect(canMakeInvoiceForJob(s([]), job({ status: "scheduled" }))).toBe(false);
    expect(canMakeInvoiceForJob(s([]), job())).toBe(true);
    expect(canMakeInvoiceForJob(s([], [invoice()]), job())).toBe(false);
    expect(canMakeInvoiceForJob(s([], [invoice({ jobId: null, estimateId: "e1" })]), job({ estimateId: "e1" }))).toBe(false);
  });
  it("estimates: only once their job is Done and nothing invoiced them", () => {
    const e = estimate();
    // No job at all (a deposit, work not scheduled in the app): invoice straight away.
    expect(canMakeInvoiceForEstimate(s([]), e)).toBe(true);
    expect(canMakeInvoiceForEstimate(s([], [invoice({ jobId: null, estimateId: "e1" })]), e)).toBe(false);
    expect(canMakeInvoiceForEstimate(s([job({ estimateId: "e1", status: "in_progress" })]), e)).toBe(false);
    expect(canMakeInvoiceForEstimate(s([job({ estimateId: "e1" })]), e)).toBe(true);
    expect(canMakeInvoiceForEstimate(s([job({ estimateId: "e1" })], [invoice({ jobId: null, estimateId: "e1" })]), e)).toBe(false);
  });
});

describe("a job from an estimate gets its service type", () => {
  it("from the title, else the lines", () => {
    expect(serviceTypeForEstimate(estimate({ title: "Stump grinding (2 stumps)" }))).toBe("Stump Grinding");
    expect(serviceTypeForEstimate(estimate({ title: "Remove oak and grind stump" }))).toBe("Removal");
    expect(serviceTypeForEstimate(estimate({ title: "EAB treatment" }))).toBe("Plant Health Care");
    expect(serviceTypeForEstimate(estimate({ title: "Spring fertilization" }))).toBe("Fertilization");
    expect(serviceTypeForEstimate(estimate({ title: "Storm cleanup" }))).toBe("Emergency");
    expect(
      serviceTypeForEstimate(estimate({ title: "Smith backyard", lines: [{ id: "x", description: "Grind 3 stumps", quantity: 1, unitPrice: 1 }] })),
    ).toBe("Stump Grinding");
    expect(serviceTypeForEstimate(estimate({ title: "Smith backyard", lines: [] }))).toBe("Trimming");
  });
});

describe("invoice numbers and the status line", () => {
  it("one number format: INV-<highest + 1>", () => {
    expect(nextInvoiceNumber([])).toBe("INV-1001");
    expect(nextInvoiceNumber([{ number: "1001" }, { number: "INV-1002" }])).toBe("INV-1003");
  });
  it("an automatic invoice always says whether it will email", () => {
    const auto = invoice({ autoCreated: true });
    expect(invoiceEmailStatus(auto, false)).toBe("Not sent: automatic emails are off — press Email invoice.");
    expect(invoiceEmailStatus(auto, true)).toBe("Not sent yet: press Email invoice.");
    expect(invoiceEmailStatus({ ...auto, emailedAt: "2026-11-15T10:00:00Z" }, false)).toBe("Emailed from the app by the office.");
    expect(invoiceEmailStatus({ ...auto, emailQueuedAt: "2026-11-15T10:00:00Z" }, false)).toBe(
      "Not sent: automatic emails are off — press Email invoice.",
    );
    const waiting = { ...auto, autoSendStatus: "waiting" as const, autoSendAt: "2026-11-15T21:15:00Z" };
    expect(invoiceEmailStatus(waiting, true, new Date("2026-11-15T19:00:00Z"))).toBe("Sends at 2:15 PM");
    expect(invoiceEmailStatus(invoice(), false)).toBeNull();
  });
});

describe("invoicing an hourly job while someone is still clocked in", () => {
  const ts = [
    clock("2026-11-09", "08:00", "16:00", { jobId: "j1" }),
    clock("2026-11-09", "08:00", null, { jobId: "j1", crewId: "b" }),
    clock("2026-11-09", "08:00", null, { jobId: "j2" }),
  ];
  it("counts open entries on that job only", () => {
    expect(openClockEntriesOnJob({ timesheets: ts }, "j1")).toBe(1);
    expect(openClockEntriesOnJob({ timesheets: ts }, "j3")).toBe(0);
  });
  it("asks first for an hourly job, never for a flat one or when nobody is clocked in", () => {
    const asked: string[] = [];
    const no = (m: string) => {
      asked.push(m);
      return false;
    };
    expect(okToInvoiceWithOpenClock({ timesheets: ts }, job({ billingType: "hourly" }), no)).toBe(false);
    expect(asked[0]).toMatch(/1 person is still clocked in/);
    expect(okToInvoiceWithOpenClock({ timesheets: ts }, job({ billingType: "hourly" }), () => true)).toBe(true);
    expect(okToInvoiceWithOpenClock({ timesheets: ts }, job({ billingType: "flat" }), no)).toBe(true);
    expect(okToInvoiceWithOpenClock({ timesheets: ts }, job({ id: "j3", billingType: "hourly" }), no)).toBe(true);
    expect(asked).toHaveLength(1);
  });
});

describe("a Sunday night shift running into this Monday", () => {
  it("counts toward Monday's 12-hour day, paid only on this week's own minutes", () => {
    const sun = clock("2026-11-08", "22:00", "06:00");
    const mon = clock("2026-11-09", "13:00", "21:00");
    const r = coloradoOvertime([mon], week, [sun]);
    expect(r.hours).toBe(8);
    expect(r.overtimeHours).toBe(2);
    expect(r.rules).toEqual(["day"]);
    // Without the day before, the 2 hours are missed.
    expect(coloradoOvertime([mon], week).overtimeHours).toBe(0);
    // Last week's run pays nothing extra for the spill-over alone.
    const lastWeek = week.map((d) => addDaysISO(d, -7));
    expect(coloradoOvertime([sun], lastWeek).overtimeHours).toBe(0);
  });
  it("counts toward 12 hours in a row across midnight", () => {
    const sun = clock("2026-11-08", "22:00", "04:00");
    const mon = clock("2026-11-09", "04:30", "12:00");
    const r = coloradoOvertime([mon], week, [sun]);
    // 22:00 Sunday to 12:00 Monday is a 14-hour stretch (the half-hour
    // break included): Monday's 10:00-12:00 is overtime.
    expect(r.overtimeHours).toBe(2);
    expect(r.rules).toEqual(["row"]);
  });
  it("weekly pay passes the day before to the overtime check", () => {
    const rows = weeklyPayRows(
      [person()],
      [clock("2026-11-08", "22:00", "06:00"), clock("2026-11-09", "13:00", "21:00")],
      week,
      "2026-11-15",
    );
    expect(rows[0].hours).toBe(8);
    expect(rows[0].overtimeHours).toBe(2);
  });
});
