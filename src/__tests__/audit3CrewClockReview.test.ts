// Review fixes on the 8 PM rule (the "crew day and 8pm clockout" rules):
// a queued clock-out that arrives after the 8 PM close replaces it,
// old open entries are left for the office, and office screens count
// an entry the 8 PM rule ended up to 20:00.
import { describe, expect, it, vi } from "vitest";
import { autoClosesOn, clockOutTapTime, eightPmClockOut } from "../clockTime";
import { entryHoursNow, liveEntryHours, switchClock } from "../crewDay";
import { applyFieldOp, replacesAutoClose, type FieldOp } from "../fieldQueue";
import type { AppState, TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

function entry(id: string, over: Partial<TimesheetEntry> = {}): TimesheetEntry {
  return {
    id,
    crewId: "gus",
    jobId: null,
    date: "2026-11-16",
    clockIn: "08:00",
    clockOut: null,
    hours: null,
    notes: "",
    location: "",
    ...over,
  };
}

const denver = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-07:00`);
const stateOf = (timesheets: TimesheetEntry[]): AppState =>
  ({ jobs: [], timesheets, crew: [], auditLog: [] }) as unknown as AppState;
const clockOutOp = (entryId: string, at: string): FieldOp =>
  ({ id: "op1", kind: "clockOut", entryId, at, date: "2026-11-16", audit: [] }) as FieldOp;

describe("a clock-out tap that waited for signal past the 8 PM close", () => {
  const closed = entry("e1", { clockOut: "20:00", autoClosed: true });
  it("replaces the 20:00 with the tapped time", () => {
    const next = applyFieldOp(stateOf([closed]), clockOutOp("e1", "17:00"));
    const e = next.timesheets.find((t) => t.id === "e1");
    expect(e?.clockOut).toBe("17:00");
    expect(e?.autoClosed).toBe(false);
  });
  it("only for a tap between the clock-in and 8 PM", () => {
    expect(replacesAutoClose(closed, "17:00")).toBe(true);
    expect(replacesAutoClose(closed, "20:30")).toBe(false);
    expect(replacesAutoClose(closed, "07:00")).toBe(false);
  });
  it("never changes a clock-out the office typed", () => {
    const typed = entry("e2", { clockOut: "20:00", autoClosed: false });
    expect(replacesAutoClose(typed, "17:00")).toBe(false);
    const s = stateOf([typed]);
    expect(applyFieldOp(s, clockOutOp("e2", "17:00")).timesheets[0].clockOut).toBe("20:00");
  });
});

describe("old open entries are left for the office", () => {
  it("the automatic close covers today and the 2 days before", () => {
    expect(autoClosesOn("2026-11-16", "2026-11-16")).toBe(true);
    expect(autoClosesOn("2026-11-14", "2026-11-16")).toBe(true);
    expect(autoClosesOn("2026-11-13", "2026-11-16")).toBe(false);
    expect(autoClosesOn("2026-10-31", "2026-11-01")).toBe(true);
  });
  it("an open entry from weeks ago is not shown as ended at 8 PM, and counts 0 h", () => {
    const old = entry("old", { date: "2026-10-20" });
    expect(eightPmClockOut(old, denver("2026-11-16", "09:00"))).toBeNull();
    expect(liveEntryHours(old, "2026-11-16", "09:00")).toBe(0);
  });
  it("clocking in does not close an open entry from weeks ago", () => {
    const old = entry("old", { date: "2026-10-20" });
    const yesterday = entry("y", { date: "2026-11-15" });
    const res = switchClock([old, yesterday], entry("new", { date: "2026-11-16", clockIn: "07:00" }));
    expect(res.timesheets.find((t) => t.id === "old")?.clockOut).toBeNull();
    expect(res.timesheets.find((t) => t.id === "y")?.clockOut).toBe("20:00");
  });
  it("a Clock out tap on an old entry still saves 20:00 of its day, as the database does", () => {
    expect(clockOutTapTime(entry("old", { date: "2026-10-20" }), denver("2026-11-16", "09:00"))).toEqual({
      time: "20:00",
      autoClosed: true,
    });
  });
});

describe("office screens count an entry the 8 PM rule ended", () => {
  it("an open entry from today counts to 20:00 after 8 PM", () => {
    expect(entryHoursNow(entry("t"), denver("2026-11-16", "21:00"))).toBe(12);
  });
  it("yesterday's open entry counts to 20:00 before the server closes it", () => {
    expect(entryHoursNow(entry("y", { date: "2026-11-15" }), denver("2026-11-16", "07:00"))).toBe(12);
  });
  it("a running entry counts up to now", () => {
    expect(entryHoursNow(entry("t"), denver("2026-11-16", "10:30"))).toBe(2.5);
  });
  it("a finished entry counts its hours", () => {
    expect(entryHoursNow(entry("f", { clockOut: "16:00" }), denver("2026-11-16", "21:00"))).toBe(8);
  });
});

describe("a failed 8 PM close turns the hourly run red", () => {
  it("the function reports it and the workflow fails on it", async () => {
    const { readFileSync } = await import("node:fs");
    const fn = readFileSync("supabase/functions/run-automations/index.ts", "utf8");
    const wf = readFileSync(".github/workflows/automations.yml", "utf8");
    expect(fn).toMatch(/clockCloseFailed/);
    expect(fn).toMatch(/reply\(200, \{[^}]*clockCloseFailed/);
    expect(wf).toMatch(/\.clockCloseFailed \/\/ false\) then "the 8 PM clock close failed/);
  });
});
