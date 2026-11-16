import { describe, expect, it, vi } from "vitest";
import type { AuditEntry, CrewMember, Customer, Estimate, TimesheetEntry } from "../types";
import { addressLine, customerMatches, phoneDigits, telHref } from "../customerSearch";
import { findDuplicates } from "../addresses";
import { auditLine, describeAudit, plainTime } from "../auditText";
import { isEmailAddress, possessive, sendBlockedReason } from "../sendReady";
import { changedSinceApproval, payrollCsv, weeklyPayRows, weekTotals } from "../weeklyPay";
import { filterEstimates } from "../estimateGroups";
import { defaultOptionId, needsOptionPick, sayYesStep, scheduledText } from "../sayYes";
import { clearFlash, getFlash, showFlash } from "../flash";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const cust = (over: Partial<Customer> = {}): Customer =>
  ({
    id: "c1",
    firstName: "Dana",
    lastName: "Testwood",
    company: "",
    phone: "555-555-0199",
    email: "",
    address: "12 Elm St",
    city: "Anytown",
    zip: "12302",
    addresses: [],
    propertyNotes: "",
    gateCode: "",
    notes: "",
    contacts: [],
    ...over,
  }) as Customer;

describe("phone search matches on digits only", () => {
  const dana = cust();
  it.each(["(555) 555-0199", "555 555 0199", "5555550199", "+1 555 555 0199", "555.555.0199", "555-0199", "0199"])(
    "finds 555-555-0199 for %s",
    (q) => expect(customerMatches(dana, q)).toBe(true),
  );
  it("still matches names and addresses as words", () => {
    expect(customerMatches(dana, "dana")).toBe(true);
    expect(customerMatches(dana, "elm st")).toBe(true);
    expect(customerMatches(dana, "carl")).toBe(false);
  });
  it("does not treat a short or wrong number as a match", () => {
    expect(customerMatches(dana, "77")).toBe(false);
    expect(customerMatches(dana, "(444) 555-0199")).toBe(false);
  });
  it("matches commercial contact phones", () => {
    const c = cust({ phone: "", contacts: [{ id: "k", name: "Pat", role: "Other", email: "", phone: "444-111-2222" }] });
    expect(customerMatches(c, "(444) 111 2222")).toBe(true);
  });
  it("normalises digits", () => {
    expect(phoneDigits("+1 (555) 555-0199")).toBe("5555550199");
    expect(telHref("(555) 555-0199")).toBe("tel:5555550199");
  });
  it("the duplicate warning sees the same number written differently", () => {
    const found = findDuplicates([dana], { firstName: "D", lastName: "X", phone: "(555) 555 0199", email: "", address: "" });
    expect(found.map((f) => f.reasons)).toEqual([["same phone"]]);
  });
  it("address line has no lone comma", () => {
    expect(addressLine({ address: "", city: "", zip: "" })).toBe("");
    expect(addressLine({ address: "12 Elm", city: "Anytown", zip: "" })).toBe("12 Elm, Anytown");
  });
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "a",
  timestamp: "2026-11-15T10:00:00Z",
  actor: "Alex",
  entity: "Job",
  entityId: "j1",
  entityLabel: "Big oak",
  field: "(created)",
  oldValue: "",
  newValue: "",
  customerId: "c1",
  jobId: "j1",
  ...over,
});

describe("activity log in plain English", () => {
  const names = { equipment: (id: string) => ({ "eq-chip": "Chipper", "eq-dump": "Dump trailer", "eq-bigtruck": "Big Truck" })[id] };
  it("names equipment instead of ids", () => {
    expect(auditLine(entry({ field: "equipmentIds", oldValue: "(blank)", newValue: "eq-chip" }), names)).toBe(
      "Alex added the Chipper to Big oak",
    );
    expect(auditLine(entry({ field: "equipmentIds", oldValue: "eq-chip,eq-dump,eq-bigtruck", newValue: "eq-chip" }), names)).toBe(
      "Alex took the Dump trailer and Big Truck off Big oak",
    );
  });
  it("crew, times and status read as sentences", () => {
    expect(auditLine(entry({ field: "crew", oldValue: "", newValue: "added Gus" }))).toBe("Alex added Gus to Big oak");
    expect(auditLine(entry({ field: "crew", oldValue: "Gus", newValue: "removed" }))).toBe("Alex took Gus off Big oak");
    expect(auditLine(entry({ field: "startTime", oldValue: "08:00", newValue: "07:00" }))).toBe(
      "Alex changed the start time of Big oak from 8:00 AM to 7:00 AM",
    );
    expect(auditLine(entry({ field: "status", oldValue: "scheduled", newValue: "done" }))).toBe("Alex marked Big oak Done");
  });
  it("never shows database ids and hides no-change rows", () => {
    const s = auditLine(
      entry({ entity: "Estimate", entityLabel: "Maple", field: "jobId", oldValue: "(blank)", newValue: "cda763c1-9cdf-4ff8-9a1b-1234567890ab" }),
    );
    expect(s).toBe("Alex made a job from estimate Maple");
    expect(s).not.toMatch(/cda763c1/);
    expect(describeAudit(entry({ field: "visitDate", oldValue: "(blank)", newValue: "(blank)" })).hidden).toBe(true);
    expect(auditLine(entry({ entity: "Invoice", entityLabel: "INV-1002", field: "email", oldValue: "(not queued)", newValue: "queued (thread thread-1f3d74d7)" }))).not.toMatch(/thread-/);
  });
  it("created / deleted / call logs", () => {
    expect(auditLine(entry({}))).toBe("Alex added the job Big oak");
    expect(auditLine(entry({ entity: "Message", entityLabel: "Call log to Dana Testwood" }))).toBe("Alex logged a call with Dana Testwood");
    expect(auditLine(entry({ entity: "Note", entityLabel: "Team note for Dana Testwood" }))).toBe("Alex added a team note for Dana Testwood");
    expect(auditLine(entry({ field: "(deleted)" }))).toBe("Alex deleted the job Big oak");
  });
  it("dates and blanks", () => {
    expect(auditLine(entry({ field: "date", oldValue: "2026-11-16", newValue: "2026-11-17" }))).toBe(
      "Alex changed the date of Big oak from Mon, Nov 16 to Tue, Nov 17",
    );
    expect(auditLine(entry({ field: "notes", oldValue: "(blank)", newValue: "Bring ropes" }))).toBe("Alex set the notes of Big oak to Bring ropes");
    expect(plainTime("13:05")).toBe("1:05 PM");
  });
});

describe("send needs an email", () => {
  it("blocks with the customer's name", () => {
    expect(sendBlockedReason(cust())).toBe("Add Dana's email to send this.");
    expect(sendBlockedReason(cust({ firstName: "James", email: "nope" }))).toBe("Add James' email to send this.");
    expect(sendBlockedReason(cust({ email: "dana@example.com" }))).toBeNull();
    expect(sendBlockedReason(null)).toBe("Choose a customer first.");
  });
  it("email check", () => {
    expect(isEmailAddress(" a@b.co ")).toBe(true);
    expect(isEmailAddress("a@b")).toBe(false);
    expect(possessive("Chris")).toBe("Chris'");
  });
});

const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
const crew = (id: string, name: string, over: Partial<CrewMember> = {}): CrewMember =>
  ({ id, name, role: "Groundsman", phone: "", color: "", ...over }) as CrewMember;
const ts = (crewId: string, date: string, hours: number, over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: `${crewId}-${date}-${hours}`,
  crewId,
  jobId: null,
  date,
  clockIn: null,
  clockOut: null,
  hours,
  notes: "",
  location: "",
  ...over,
});

describe("weekly pay", () => {
  const team = [
    crew("g", "Gus", { payType: "hourly", payAmount: 25 }),
    crew("o", "Otto", { payType: "day", payAmount: 200 }),
    crew("p", "Pat", { payType: "percent", payAmount: 10 }),
    crew("n", "Nobody"),
  ];
  const sheets = [
    ...week.slice(0, 5).map((d) => ts("g", d, 9)), // 45 h
    ts("o", "2026-11-09", 8),
    ts("o", "2026-11-10", 6),
    ts("o", "2026-11-10", 2),
    ts("p", "2026-11-11", 0, { clockIn: "07:00", clockOut: "15:30", hours: null }),
    ts("p", "2026-11-12", 0, { clockIn: "07:00", clockOut: null, hours: null }),
    ts("g", "2026-11-16", 10), // next week
  ];
  const rows = weeklyPayRows(team, sheets, week);
  it("hours, overtime and straight-time pay per person", () => {
    const g = rows.find((r) => r.crewId === "g")!;
    expect(g.hours).toBe(45);
    expect(g.overtimeHours).toBe(5);
    expect(g.pay).toBe(1125);
    const o = rows.find((r) => r.crewId === "o")!;
    expect(o.days).toBe(2);
    expect(o.pay).toBe(400);
    const p = rows.find((r) => r.crewId === "p")!;
    expect(p.hours).toBe(8.5);
    expect(p.pay).toBeNull();
    expect(p.openEntries).toBe(1);
    expect(rows.some((r) => r.crewId === "n")).toBe(false);
    expect(g.overtimeRules).toEqual(["week"]);
    expect(g.overtimePremium).toBe(62.5);
    expect(g.total).toBe(1187.5);
    expect(weekTotals(rows)).toEqual({ hours: 69.5, overtimeHours: 5, pay: 1525, overtimePremium: 62.5, total: 1587.5 });
  });
  it("CSV for payroll", () => {
    const csv = payrollCsv(rows, week[0], week[6]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toMatch(/^Week start,Week end,Name,/);
    expect(lines).toContain(
      "2026-11-09,2026-11-15,Gus,Groundsman,5,45.00,40.00,5.00,over 40 in the week,Hourly,25.00,25.00,1125.00,62.50,1187.50,,",
    );
    expect(lines[lines.length - 1]).toBe(",,Total,,,69.50,64.50,5.00,,,,,1525.00,62.50,1587.50,,");
    expect(csv).not.toMatch(/@/);
  });
  it("CSV cells are safe", () => {
    const csv = payrollCsv(weeklyPayRows([crew("x", "=HYPERLINK(1), Bob")], [ts("x", week[0], 1)], week), week[0], week[6]);
    expect(csv).toContain(`"'=HYPERLINK(1), Bob"`);
  });
  it("notices hours changed after approval", () => {
    expect(changedSinceApproval(61.5, 61.5)).toBe(false);
    expect(changedSinceApproval(61.5, 62)).toBe(true);
  });
});

const est = (over: Partial<Estimate>): Estimate => ({
  id: "e1",
  customerId: "c1",
  jobId: null,
  title: "Maple",
  lines: [],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "draft",
  createdDate: "2026-11-10",
  notes: "",
  emailQueuedAt: null,
  ...over,
});

describe("estimate groups and Customer said yes", () => {
  it("accepted estimates wait to be scheduled, not under Done", () => {
    const list = [
      est({ id: "d", status: "draft" }),
      est({ id: "a", status: "accepted" }),
      est({ id: "b", status: "accepted" }),
      est({ id: "x", status: "closed" }),
    ];
    const g = filterEstimates(list, [cust()], "all", "", [{ estimateId: "b" }]);
    expect(g.needsAttention.map((e) => e.id)).toEqual(["d"]);
    expect(g.toSchedule.map((e) => e.id)).toEqual(["a"]);
    expect(g.finished.map((e) => e.id).sort()).toEqual(["b", "x"]);
  });
  it("steps", () => {
    expect(sayYesStep(est({}), [])).toBe("ask");
    expect(sayYesStep(est({ status: "accepted" }), [])).toBe("schedule");
    expect(sayYesStep(est({ status: "accepted" }), [{ estimateId: "e1" }])).toBe("booked");
    expect(sayYesStep(est({ status: "closed" }), [])).toBe("closed");
  });
  it("option picking", () => {
    const two = est({
      options: [
        { id: "g", label: "Good", description: "", lines: [] },
        { id: "b", label: "Best", description: "", lines: [] },
      ],
    });
    expect(defaultOptionId(two)).toBeNull();
    expect(needsOptionPick(two, null)).toBe(true);
    expect(needsOptionPick(two, "b")).toBe(false);
    expect(defaultOptionId({ ...two, acceptedOptionId: "b" })).toBe("b");
    expect(defaultOptionId(est({ options: [{ id: "o", label: "Better", description: "", lines: [] }] }))).toBe("o");
    expect(needsOptionPick(est({}), null)).toBe(false);
  });
  it("confirmation line", () => {
    expect(scheduledText("2026-11-16", "07:00")).toBe("Scheduled for Mon, Nov 16 at 7:00 AM");
  });
});

describe("confirmation line (flash)", () => {
  it("shows and clears", () => {
    showFlash("Sent to carl@example.com — now under Sent.");
    expect(getFlash()?.text).toBe("Sent to carl@example.com — now under Sent.");
    clearFlash();
    expect(getFlash()).toBeNull();
  });
});

describe("fixed weekly hours (Sam, 32 a week)", () => {
  it("uses the fixed hours whatever was clocked, even with no entries", () => {
    const sam = crew("d", "Sam Manager", { payType: "hourly", payAmount: 30, fixedWeeklyHours: 32 });
    const rows = weeklyPayRows([sam], [ts("d", week[0], 3)], week);
    expect(rows[0].hours).toBe(32);
    expect(rows[0].fixedHours).toBe(true);
    expect(rows[0].pay).toBe(960);
    expect(weeklyPayRows([sam], [], week)[0].hours).toBe(32);
  });
});
