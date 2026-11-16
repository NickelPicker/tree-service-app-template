import { describe, expect, it, vi } from "vitest";
import {
  hourlyLaborCost,
  jobCosting,
  jobEstimate,
  jobPriceBeforeChange,
  jobValue,
  jobValueBeforeTax,
  jobValueSource,
  replacedJobPrice,
} from "../jobValue";
import { estimateInvoicePricing, invoiceBillsReplacedPrice, jobInvoicePricing } from "../invoiceMaking";
import { priceOrNull } from "../crewPrices";
import { weeklyPayRows } from "../weeklyPay";
import { climberNewPrice, crewChangesFor, priceBoxLines, priceOf, unseenCrewChanges } from "../priceChange";
import { sharesTotal, splitsSendProblem } from "../../supabase/functions/_shared/splitShares";
import type { AppState, CrewMember, Estimate, Invoice, Job, JobPriceChange, TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];

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

const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  id: "e1",
  customerId: "c1",
  jobId: null,
  title: "Oak",
  lines: [{ id: "el", description: "Remove oak", quantity: 1, unitPrice: 1000 }],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "accepted",
  createdDate: "2026-11-01",
  notes: "",
  emailQueuedAt: null,
  ...over,
});

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1",
  number: "INV-1001",
  customerId: "c1",
  jobId: "j1",
  estimateId: null,
  lines: [{ id: "l1", description: "Work", quantity: 1, unitPrice: 1000 }],
  taxRate: 8,
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

const person = (over: Partial<CrewMember> = {}): CrewMember =>
  ({ id: "a", name: "Al", role: "Groundsman", phone: "", color: "", payType: "hourly", payAmount: 30, ...over }) as CrewMember;

const clock = (date: string, clockIn: string, clockOut: string | null, over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: `${date}-${clockIn}`,
  crewId: "a",
  jobId: "j1",
  date,
  clockIn,
  clockOut,
  hours: null,
  notes: "",
  location: "",
  ...over,
});

const state = (over: Partial<AppState> = {}): AppState =>
  ({ jobs: [], estimates: [], invoices: [], timesheets: [], crew: [], ...over }) as unknown as AppState;

describe("job costing counts live-clocked time", () => {
  it("a $30/hr groundsman clocked 07:00-17:00 on a $2,000 job costs $300", () => {
    const j = job({ value: 2000 });
    const s = state({ jobs: [j], crew: [person()], timesheets: [clock("2026-11-09", "07:00", "17:00")] });
    const c = jobCosting(s, j);
    expect(c.laborHours).toBe(10);
    expect(c.laborCost).toBe(300);
    expect(c.laborByPerson).toHaveLength(1);
    expect(c.profit).toBe(1700);
  });
  it("still counts typed hours, and not an open clock-in", () => {
    const j = job({ value: 2000 });
    const s = state({
      jobs: [j],
      crew: [person()],
      timesheets: [
        clock("2026-11-09", "", null, { clockIn: null, hours: 2 }),
        clock("2026-11-10", "07:00", null),
      ],
    });
    expect(jobCosting(s, j).laborHours).toBe(2);
  });
});

describe("percent labor is a percent of the value before tax", () => {
  it("$1,000 of lines with 8% tax: a 30% person costs $300, as payroll pays", () => {
    const j = job({ invoiceId: "i1" });
    const s = state({
      jobs: [j],
      invoices: [invoice()],
      crew: [person({ payType: "percent", payAmount: 30 })],
      timesheets: [clock("2026-11-09", "07:00", "15:00")],
    });
    expect(jobValue(s, j)).toBe(1080);
    expect(jobValueBeforeTax(s, j)).toBe(1000);
    expect(jobCosting(s, j).laborCost).toBe(300);
  });
  it("from an estimate with tax and discount: before tax is lines minus discount", () => {
    const j = job({ estimateId: "e1", estimatedHours: 10 });
    const s = state({
      jobs: [j],
      estimates: [estimate({ taxRate: 10, discountType: "percent", discountValue: 10 })],
      crew: [person({ payType: "percent", payAmount: 30 })],
    });
    expect(jobValueBeforeTax(s, j)).toBe(900);
    const lines = hourlyLaborCost(s, j, ["a"]).lines;
    expect(lines[0].rate).toBe(27); // 30% of $900 ÷ 10h
  });
});

describe("unpaid overtime is flagged on weekly pay", () => {
  it("a percent employee with 50 hours and no paid invoice: overtime with no pay is flagged", () => {
    const days = week.slice(0, 5).map((d) => clock(d, "07:00", "17:00"));
    const rows = weeklyPayRows([person({ payType: "percent", payAmount: 30 })], days, week, "2026-11-16", {
      jobs: [job()],
      invoices: [],
    });
    expect(rows[0].overtimeHours).toBe(10);
    expect(rows[0].pay).toBe(0);
    expect(rows[0].overtimeUnpaid).toBe(true);
  });
  it("an hourly employee with overtime is not flagged", () => {
    const days = week.slice(0, 5).map((d) => clock(d, "07:00", "17:00"));
    const rows = weeklyPayRows([person()], days, week, "2026-11-16");
    expect(rows[0].overtimeUnpaid).toBe(false);
  });
});

describe("all-percentage splits must bill the total to the cent", () => {
  const pct = (v: number) => ({ kind: "percentage", value: v });
  it("33.333% x 3 of $10,000 bills $9,999.90: refused", () => {
    expect(sharesTotal([pct(33.333), pct(33.333), pct(33.333)], 10000)).toBe(9999.9);
    expect(splitsSendProblem([pct(33.333), pct(33.333), pct(33.333)], 10000)).toContain("$9999.90");
  });
  it("50.005% + 50% of $10,000 bills $10,000.50: refused", () => {
    expect(splitsSendProblem([pct(50.005), pct(50)], 10000)).toContain("$10000.50");
  });
  it("normal splits still pass (rounding is fixed up)", () => {
    expect(splitsSendProblem([pct(50), pct(50)], 10.01)).toBeNull();
    expect(splitsSendProblem([pct(33.33), pct(33.33), pct(33.34)], 100)).toBeNull();
    expect(splitsSendProblem([pct(33.33), pct(33.33), pct(33.34)], 10000)).toBeNull();
  });
});

describe("a Climber's price replaces the estimate's", () => {
  const est = estimate();
  it("before: the job is priced by its estimate", () => {
    const j = job({ estimateId: "e1", value: null });
    const s = state({ jobs: [j], estimates: [est] });
    expect(jobValue(s, j)).toBe(1000);
    expect(jobPriceBeforeChange(s, j)).toBe(1000);
    expect(replacedJobPrice(s, j)).toBeNull();
  });
  it("after: the Climber's price is the job's price, the old one is shown struck", () => {
    const j = job({ estimateId: "e1", value: 1200, replacedPrice: 1000 });
    const s = state({ jobs: [j], estimates: [est] });
    expect(jobValue(s, j)).toBe(1200);
    expect(jobValueSource(s, j).label).toBe("price set by a Climber");
    expect(replacedJobPrice(s, j)).toBe(1000);
    expect(jobPriceBeforeChange(s, j)).toBe(1200);
  });
  it("the invoice made from the job bills the new price", () => {
    const j = job({ estimateId: "e1", value: 1200, replacedPrice: 1000 });
    const p = jobInvoicePricing(state({ estimates: [est] }), j);
    expect(p.source).toBe("job value");
    expect(p.total).toBe(1200);
  });
  it("the Climber's price list strikes the estimate's prices and names the new one", () => {
    expect(climberNewPrice(job({ estimateId: "e1", value: 1200, replacedPrice: 1000 }))).toBe("$1,200");
    expect(climberNewPrice(job({ estimateId: "e1", value: null }))).toBeNull();
  });
  it("the price box shows the estimate's price as the current price", () => {
    const j = job({ estimateId: "e1", value: null, billingType: "flat" });
    const lines = priceBoxLines(priceOf(j), { ...priceOf(j), value: 1200 }, null, 1000);
    expect(lines.current).toBe("Current price: $1,000");
    expect(lines.next).toContain("+$200");
  });
});

describe("the job's price-change list is Climbers' changes only", () => {
  const change = (over: Partial<JobPriceChange>): JobPriceChange => ({
    id: "x",
    jobId: "j1",
    changedBy: null,
    changedByName: "",
    byOffice: false,
    changedAt: "2026-11-17T10:00:00Z",
    oldValue: 900,
    newValue: 1100,
    oldHourlyRate: null,
    newHourlyRate: null,
    oldBillingType: "flat",
    newBillingType: "flat",
    reason: "Second stump",
    seenBy: null,
    seenAt: null,
    ...over,
  });
  it("leaves out the office's own edits", () => {
    const list = [change({ id: "a" }), change({ id: "b", byOffice: true, seenAt: "2026-11-17T11:00:00Z" })];
    expect(crewChangesFor(list, "j1").map((c) => c.id)).toEqual(["a"]);
    expect(unseenCrewChanges(list).map((c) => c.id)).toEqual(["a"]);
  });
});

describe("review fixes: invoices from the estimate follow the Climber's price", () => {
  // $1,000 of lines, 10% off, 8% tax = $972.
  const est = estimate({ jobId: "j1", taxRate: 8, discountType: "percent", discountValue: 10 });
  it("an estimate whose job was not changed bills its lines, tax and discount", () => {
    const j = job({ estimateId: "e1" });
    const p = estimateInvoicePricing(state({ jobs: [j], estimates: [est] }), est);
    expect(p.source).toBe("estimate");
    expect(p.total).toBe(972);
    expect(p.lines[0]).toMatchObject({ id: "el", unitPrice: 1000 });
  });
  it("after a Climber replaced the price, it bills the job's price instead", () => {
    const j = job({ estimateId: "e1", value: 1300, replacedPrice: 972 });
    const p = estimateInvoicePricing(state({ jobs: [j], estimates: [est] }), est);
    expect(p.source).toBe("job value");
    expect(p.total).toBe(1300);
    expect(p.taxRate).toBe(0);
  });
  it("the invoice note shows only when the invoice bills the new price", () => {
    const j = job({ estimateId: "e1", value: 1300, replacedPrice: 972 });
    const s = state({ jobs: [j], estimates: [est] });
    const newBill = invoice({ lines: [{ id: "x", description: "Work", quantity: 1, unitPrice: 1300 }], taxRate: 0 });
    const oldBill = invoice({ lines: [{ id: "x", description: "Work", quantity: 1, unitPrice: 1000 }], taxRate: 8, discountType: "percent", discountValue: 10 });
    expect(invoiceBillsReplacedPrice(s, j, newBill)).toBe(true);
    expect(invoiceBillsReplacedPrice(s, j, oldBill)).toBe(false);
    expect(invoiceBillsReplacedPrice(s, job({ estimateId: "e1", value: 1300 }), newBill)).toBe(false);
  });
});

describe("review fixes: an estimate linked only by its job id", () => {
  const est = estimate({ jobId: "j1", taxRate: 8, discountType: "percent", discountValue: 10 });
  it("is the job's estimate, as the database finds it", () => {
    const j = job({ estimateId: null, value: 500 });
    expect(jobEstimate(state({ estimates: [est] }), j)?.id).toBe("e1");
    expect(jobEstimate(state({ estimates: [{ ...est, status: "sent" }] }), j)).toBeNull();
  });
  it("its total is the price a Climber's change replaces (not the old manual value)", () => {
    const j = job({ estimateId: null, value: 500 });
    expect(jobPriceBeforeChange(state({ estimates: [est] }), j)).toBe(972);
  });
  it("the linked estimate comes first", () => {
    const other = estimate({ id: "e0", jobId: "j1" });
    const linked = estimate({ id: "e9", lines: [{ id: "z", description: "Trim", quantity: 1, unitPrice: 300 }] });
    const j = job({ estimateId: "e9" });
    expect(jobPriceBeforeChange(state({ estimates: [other, linked] }), j)).toBe(300);
  });
});

describe("review fixes: profit leaves out sales tax", () => {
  it("a $1,080 invoice ($1,000 + 8% tax) with $300 of labor makes $700 profit", () => {
    const j = job({ invoiceId: "i1" });
    const s = state({ jobs: [j], invoices: [invoice()], crew: [person()], timesheets: [clock("2026-11-09", "07:00", "17:00")] });
    const c = jobCosting(s, j);
    expect(c.estimated).toBe(1080);
    expect(c.beforeTax).toBe(1000);
    expect(c.profit).toBe(700);
  });
});

describe("review fixes: the Climber's current price from the database", () => {
  it("reads the rpc number, else nothing", () => {
    expect(priceOrNull("972.00")).toBe(972);
    expect(priceOrNull(972)).toBe(972);
    expect(priceOrNull(null)).toBeNull();
    expect(priceOrNull("x")).toBeNull();
  });
});
