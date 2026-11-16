import { describe, expect, it } from "vitest";
import {
  buildTodo,
  groupLabel,
  isOverdueInvoice,
  isUnsentInvoice,
  pastWeeksWithEntries,
  todoCount,
  todoWeekMondays,
  topItems,
  TODO_PAST_WEEKS,
  type TodoInput,
} from "../todo";
import type { AppState, BookingRequest, EquipmentProblem, Invoice, TimesheetEntry } from "../types";
import { baseState, equip, job, person } from "../planner/__tests__/fixtures";

// A Tuesday; last week is Mon 2026-11-09 to Sun 2026-11-15.
const TODAY = "2026-11-17";

const problem = (id: string, over: Partial<EquipmentProblem> = {}): EquipmentProblem => ({
  id,
  equipmentId: "chip",
  note: "Feed roller jams",
  status: "open",
  hasPhoto: false,
  reportedBy: "gus",
  reportedName: "Gus",
  createdAt: "2026-11-16T15:00:00Z",
  statusByName: null,
  statusAt: null,
  ...over,
});

const invoice = (id: string, over: Partial<Invoice> = {}): Invoice => ({
  id,
  number: id.toUpperCase(),
  customerId: "c1",
  jobId: null,
  estimateId: null,
  lines: [{ id: "l1", description: "Work", quantity: 1, unitPrice: 500 }],
  taxRate: 0,
  discountType: "percent",
  discountValue: 0,
  status: "unpaid",
  issuedDate: "2026-10-01",
  dueDate: "2026-10-31",
  paidDate: null,
  paymentMethod: null,
  emailQueuedAt: null,
  splits: [],
  emailedAt: "2026-10-01T15:00:00Z",
  ...over,
} as Invoice);

const entry = (id: string, date: string, hours: number): TimesheetEntry => ({
  id, crewId: "gus", jobId: null, date, clockIn: null, clockOut: null, hours, notes: "", location: "",
});

function state(over: Partial<AppState> = {}): AppState {
  return baseState({
    customers: [{ id: "c1", firstName: "Ann", lastName: "Smith", company: "", phone: "", email: "", address: "", city: "", zip: "" } as never],
    crew: [person("gus", ["ground_work"], { name: "Gus" })],
    equipment: [equip("chip", "Chipper", { name: "Chipper" })],
    jobs: [job("j1", { title: "Oak removal", value: 800, date: "2026-11-20" })],
    ...over,
  });
}

const input = (s: AppState, over: Partial<TodoInput> = {}): TodoInput => ({
  state: s,
  today: TODAY,
  staff: true,
  admin: true,
  showMoney: true,
  canEdit: true,
  invoiceReviews: [],
  heldBatch: null,
  weekApprovals: undefined,
  ...over,
});

describe("Dashboard To-do", () => {
  it("is empty when nothing needs a person", () => {
    expect(buildTodo(input(state()))).toEqual([]);
  });

  it("crew get no to-do list", () => {
    const s = state({ equipmentProblems: [problem("p1")] });
    expect(buildTodo(input(s, { staff: false }))).toEqual([]);
  });

  it("gathers open equipment problems; fixed or in-the-shop ones are done", () => {
    const s = state({
      equipmentProblems: [problem("p1"), problem("p2", { status: "fixed" }), problem("p3", { status: "in_shop" })],
    });
    const groups = buildTodo(input(s));
    expect(groups.map((g) => [g.kind, g.count])).toEqual([["problem", 1]]);
    expect(groups[0].items[0].text).toBe("Chipper: Feed roller jams");
    expect(groups[0].items[0].action).toEqual({ kind: "view", view: "equipment" });
  });

  it("puts groups in urgency order and the top 5 across them", () => {
    const s = state({
      equipmentProblems: [problem("p1"), problem("p2")],
      timeOff: [
        { id: "t1", crewId: "gus", startDate: "2026-11-24", endDate: "2026-11-25", reason: "Trip", status: "pending", requestedAt: TODAY, decidedBy: null, decidedAt: null },
        { id: "t2", crewId: "gus", startDate: "2026-12-01", endDate: "2026-12-01", reason: "", status: "approved", requestedAt: TODAY, decidedBy: "Alex", decidedAt: TODAY },
      ],
      invoices: [invoice("i1"), invoice("i2", { status: "overdue", dueDate: "2026-12-30" }), invoice("i3", { status: "paid" })],
      crew: [person("gus", [], { name: "Gus" }), person("new", [], { name: "Newbie", status: "pending" })],
      jobs: [job("j1", { title: "No price", value: null, date: "2026-11-20" })],
    });
    const groups = buildTodo(input(s));
    expect(groups.map((g) => g.kind)).toEqual(["problem", "timeOff", "overdueInvoice", "noValue", "account"]);
    expect(todoCount(groups)).toBe(7);
    expect(topItems(groups).map((i) => i.key)).toEqual([
      "problem:p1", "problem:p2", "timeoff:t1", "overdue:i1", "overdue:i2",
    ]);
    expect(groups.find((g) => g.kind === "timeOff")!.items[0].text).toContain("Gus: time off");
  });

  it("money and admin items follow the viewer's rights", () => {
    const s = state({
      invoices: [invoice("i1")],
      crew: [person("gus", ["x"], { name: "Gus" }), person("new", [], { status: "pending" })],
      jobs: [job("j1", { value: null, date: "2026-11-20" })],
    });
    expect(buildTodo(input(s, { showMoney: false, admin: false })).map((g) => g.kind)).toEqual([]);
    expect(buildTodo(input(s, { canEdit: false })).map((g) => g.kind)).toEqual(["overdueInvoice", "account"]);
  });

  it("invoice reviews, held emails and suggestions open the right thing", () => {
    const s = state({
      customerEditRequests: [
        { id: "r1", customerId: "c1", requestedBy: "pat", requestedName: "Pat", createdAt: "2026-11-16T10:00:00Z", changes: { phone: "1" }, note: "", status: "pending", decidedBy: null, decidedAt: null, declineReason: "", appliedChanges: null },
      ],
    });
    const groups = buildTodo(
      input(s, {
        invoiceReviews: [{ id: "rv1", jobId: "j1", customerId: "c1", reason: "hourly" } as never],
        heldBatch: { id: "b1", createdAt: "", status: "waiting", items: [{ id: "e1", ruleKind: "x", customerId: "c1", customerName: "", dueDay: null }, { id: "e2", ruleKind: "x", customerId: "c1", customerName: "", dueDay: null }] },
      }),
    );
    expect(groups.map((g) => g.kind)).toEqual(["invoiceReview", "suggestion", "heldEmails"]);
    expect(groups[0].items[0]).toMatchObject({ text: "Oak removal · Ann Smith", action: { kind: "job", id: "j1" } });
    expect(groups[1].items[0].action).toEqual({ kind: "customer", id: "c1" });
    expect(groups[2].items[0].text).toBe("2 automatic emails waiting for your OK");
  });

  it("last week needs approving when it has hours and no (or an outdated) approval", () => {
    const s = state({ timesheets: [entry("e1", "2026-11-10", 8), entry("e2", "2026-11-17", 5)] });
    const kinds = (a: TodoInput["weekApprovals"], admin = true) =>
      buildTodo(input(s, { weekApprovals: a, admin })).map((g) => g.kind);
    expect(kinds({})).toEqual(["week"]);
    expect(kinds(undefined)).toEqual([]);
    expect(kinds({}, false)).toEqual([]);
    const approval = { weekStart: "2026-11-09", approvedBy: "Alex", approvedAt: "", totalHours: 8 };
    expect(kinds({ "2026-11-09": approval })).toEqual([]);
    expect(kinds({ "2026-11-09": { ...approval, totalHours: 6 } })).toEqual(["week"]);
    expect(buildTodo(input(state(), { weekApprovals: {} }))).toEqual([]);
  });

  it("overdue invoices: 10 business days past due (business rule)", () => {
    // TODAY is Tue 17 Nov. Due Tue 3 Nov: 10 business days ago -> overdue.
    expect(isOverdueInvoice(invoice("a", { dueDate: "2026-11-03" }), TODAY)).toBe(true);
    // Due Wed 4 Nov: 9 business days -> not yet.
    expect(isOverdueInvoice(invoice("b", { dueDate: "2026-11-04" }), TODAY)).toBe(false);
    // Due yesterday: past due but not overdue for the office.
    expect(isOverdueInvoice(invoice("c", { dueDate: "2026-11-16" }), TODAY)).toBe(false);
    // Marked overdue by hand still counts.
    expect(isOverdueInvoice(invoice("d", { dueDate: "2026-11-16", status: "overdue" }), TODAY)).toBe(true);
    const s = state({ invoices: [invoice("i1", { dueDate: "2026-11-03" }), invoice("i2", { dueDate: "2026-11-04" })] });
    const g = buildTodo(input(s)).find((x) => x.kind === "overdueInvoice");
    expect(g?.items.map((i) => i.key)).toEqual(["overdue:i1"]);
  });

  it("overdue invoices: unpaid and past due, never zero or paid", () => {
    expect(isOverdueInvoice(invoice("a"), TODAY)).toBe(true);
    expect(isOverdueInvoice(invoice("b", { dueDate: "2026-12-01" }), TODAY)).toBe(false);
    expect(isOverdueInvoice(invoice("c", { status: "paid" }), TODAY)).toBe(false);
    expect(isOverdueInvoice(invoice("d", { lines: [] }), TODAY)).toBe(false);
    expect(isOverdueInvoice(invoice("e", { status: "partial" }), TODAY)).toBe(true);
  });

  it("labels count in plain words", () => {
    expect(groupLabel("problem", 1)).toBe("1 equipment problem");
    expect(groupLabel("timeOff", 3)).toBe("3 time-off requests");
  });
});

const booking = (id: string, over: Partial<BookingRequest> = {}): BookingRequest => ({
  id,
  date: "2026-11-20",
  name: "Pat Example",
  phone: "555-555-0100",
  email: null,
  address: "1 Test Way",
  details: "Big maple",
  status: "pending",
  requestedAt: "2026-11-16",
  estimateId: null,
  ...over,
});

describe("To-do: booking requests from the website", () => {
  it("lists pending requests for the office, with a button to Booking requests", () => {
    const s = state({ bookingRequests: [booking("b1"), booking("b2", { status: "accepted" }), booking("b3", { status: "declined" })] });
    const g = buildTodo(input(s)).find((x) => x.kind === "bookingRequest");
    expect(g?.count).toBe(1);
    expect(g?.label).toBe("1 booking request from the website");
    expect(g?.items[0].text).toContain("Pat Example");
    expect(g?.items[0].action).toEqual({ kind: "salesBookings" });
  });
  it("is not shown to view-only staff", () => {
    const s = state({ bookingRequests: [booking("b1")] });
    expect(buildTodo(input(s, { canEdit: false })).some((g) => g.kind === "bookingRequest")).toBe(false);
  });
});

describe("To-do: invoices saved but never emailed", () => {
  const saved = (id: string, over: Partial<Invoice> = {}) =>
    invoice(id, { emailedAt: null, autoSentAt: null, emailQueuedAt: null, ...over });
  it("a saved, never-sent invoice past its due date is not overdue", () => {
    expect(isOverdueInvoice(saved("a"), TODAY)).toBe(false);
    expect(isUnsentInvoice(saved("a"))).toBe(true);
  });
  it("emailed, auto-sent, part paid or marked overdue counts as sent", () => {
    expect(isOverdueInvoice(saved("a", { emailedAt: "2026-10-02T00:00:00Z" }), TODAY)).toBe(true);
    expect(isOverdueInvoice(saved("b", { autoSentAt: "2026-10-02T00:00:00Z" }), TODAY)).toBe(true);
    // Only "queued" is not a send (the invoice panel says "Not sent").
    expect(isOverdueInvoice(saved("c", { emailQueuedAt: "2026-10-02T00:00:00Z" }), TODAY)).toBe(false);
    expect(isUnsentInvoice(saved("c", { emailQueuedAt: "2026-10-02T00:00:00Z" }))).toBe(true);
    expect(isOverdueInvoice(saved("d", { status: "partial" }), TODAY)).toBe(true);
    expect(isOverdueInvoice(saved("e", { status: "overdue" }), TODAY)).toBe(true);
    expect(isUnsentInvoice(saved("f", { status: "paid" }))).toBe(false);
    expect(isUnsentInvoice(saved("g", { lines: [] }))).toBe(false);
  });
  it("lists it as 'not emailed yet', not as overdue", () => {
    const s = state({ invoices: [saved("i9")] });
    const groups = buildTodo(input(s));
    expect(groups.map((g) => g.kind)).toEqual(["unsentInvoice"]);
    expect(groups[0].items[0].detail).toContain("not emailed yet");
    expect(groups[0].items[0].action).toEqual({ kind: "invoice", id: "i9" });
    expect(buildTodo(input(s, { showMoney: false }))).toEqual([]);
  });
});

describe("To-do: the week to approve opens on that week", () => {
  it("passes last week's Monday to Timesheets", () => {
    const s = state({ timesheets: [entry("e1", "2026-11-10", 8)] });
    const g = buildTodo(input(s, { weekApprovals: {} })).find((x) => x.kind === "week");
    expect(g?.items[0].action).toEqual({ kind: "timesheetsWeek", monday: "2026-11-09" });
  });

  it("lists only the previous 2 finished weeks with hours not approved, each opening its own week", () => {
    // Today is Tue 17 Nov: the previous 2 weeks are 2 Nov and 9 Nov.
    const s = state({
      timesheets: [
        entry("a", "2026-10-20", 6), // week of 19 Oct: too old, never listed (business rule)
        entry("b", "2026-10-27", 4), // week of 26 Oct: too old
        entry("c", "2026-11-03", 5), // week of 2 Nov: not approved
        entry("d", "2026-11-08", 2), // Sunday: still the week of 2 Nov
        entry("e", "2026-11-10", 8), // last week: not approved
        entry("f", "2026-11-17", 5), // this week: not finished, never listed
      ],
    });
    expect(pastWeeksWithEntries(s, TODAY)).toEqual(["2026-11-02", "2026-11-09"]);
    expect(todoWeekMondays(TODAY)).toEqual(["2026-11-02", "2026-11-09"]);
    expect(TODO_PAST_WEEKS).toBe(2);
    const g = buildTodo(input(s, { weekApprovals: {} })).find((x) => x.kind === "week");
    expect(g?.label).toBe("2 weeks to approve");
    expect(g?.items.map((i) => i.action)).toEqual([
      { kind: "timesheetsWeek", monday: "2026-11-02" },
      { kind: "timesheetsWeek", monday: "2026-11-09" },
    ]);
    expect(g?.items[0].text).toContain(": approve the hours");
    expect(g?.items[0].detail).toBe("7 h");
    expect(g?.items[0].text.startsWith("Week of ")).toBe(true);
    // Approved: gone. Hours changed after approval: approve again.
    const approved = { weekStart: "2026-11-02", approvedBy: "Alex", approvedAt: "", totalHours: 7 };
    const left = buildTodo(input(s, { weekApprovals: { "2026-11-02": approved } })).find((x) => x.kind === "week");
    expect(left?.items.map((i) => i.action)).toEqual([{ kind: "timesheetsWeek", monday: "2026-11-09" }]);
    const changed = buildTodo(input(s, { weekApprovals: { "2026-11-02": { ...approved, totalHours: 4 } } })).find(
      (x) => x.kind === "week",
    );
    expect(changed?.items.map((i) => i.text.includes("approve again"))).toEqual([true, false]);
  });

  it("an old unapproved week alone gives no week line", () => {
    const s = state({ timesheets: [entry("a", "2026-10-20", 6)] });
    expect(buildTodo(input(s, { weekApprovals: {} })).some((g) => g.kind === "week")).toBe(false);
  });

  it("on a Monday the previous 2 weeks are the 2 just finished", () => {
    expect(todoWeekMondays("2026-11-16")).toEqual(["2026-11-02", "2026-11-09"]);
    expect(todoWeekMondays("2026-11-22")).toEqual(["2026-11-02", "2026-11-09"]); // Sunday
    expect(todoWeekMondays("2027-01-04")).toEqual(["2026-12-21", "2026-12-28"]); // across the new year
  });
});
