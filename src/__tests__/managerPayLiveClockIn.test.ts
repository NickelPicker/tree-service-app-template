import { describe, expect, it } from "vitest";
import {
  canDecideTimeOff,
  canManualClockIn,
  canRunWeeklyPay,
  limitTimesheetEdit,
  mayTypeClockTimes,
} from "../permissions";
import { applyFieldOp, type FieldOp } from "../fieldQueue";
import type { AppState, CrewMember, Role, TimesheetEntry } from "../types";

const person = (appRole: Role, perms?: CrewMember["permissions"]): CrewMember =>
  ({
    id: `p-${appRole}`,
    name: appRole,
    role: "Groundsman",
    phone: "",
    color: "",
    appRole,
    messageIntro: "",
    permissions: perms ?? null,
  }) as CrewMember;

const entry = (over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: "t1",
  crewId: "p-crew",
  jobId: null,
  date: "2026-11-16",
  clockIn: "07:00",
  clockOut: "15:30",
  hours: null,
  notes: "",
  location: "",
  ...over,
});

describe("Sam (manager) runs weekly pay and decides time off", () => {
  it("weekly pay and Approve week: owners and managers only", () => {
    expect(canRunWeeklyPay("manager")).toBe(true);
    expect(canRunWeeklyPay("owner")).toBe(true);
    expect(canRunWeeklyPay("office")).toBe(false);
    expect(canRunWeeklyPay("crew")).toBe(false);
    expect(canRunWeeklyPay(null)).toBe(false);
  });
  it("time off: owners, managers and the office approve or deny; crew cannot", () => {
    expect(canDecideTimeOff("manager")).toBe(true);
    expect(canDecideTimeOff("owner")).toBe(true);
    expect(canDecideTimeOff("office")).toBe(true);
    expect(canDecideTimeOff("crew")).toBe(false);
    expect(canDecideTimeOff(undefined)).toBe(false);
  });
});

describe("live-only clock-in unless allowed", () => {
  it("crew may not type clock times or hours by default", () => {
    expect(mayTypeClockTimes(null, person("crew"))).toBe(false);
    expect(canManualClockIn(null, person("crew"))).toBe(false);
    expect(mayTypeClockTimes(null, null)).toBe(false);
  });
  it('"May enter hours by hand" lets one crew member type them', () => {
    const hank = person("crew", { canManualClockIn: true });
    expect(mayTypeClockTimes(null, hank)).toBe(true);
    expect(canManualClockIn(null, hank)).toBe(true);
    expect(mayTypeClockTimes(null, person("crew", { canManualClockIn: false }))).toBe(false);
  });
  it("owners, managers and the office always fix entries", () => {
    expect(mayTypeClockTimes(null, person("owner"))).toBe(true);
    expect(mayTypeClockTimes(null, person("manager"))).toBe(true);
    expect(mayTypeClockTimes(null, person("office"))).toBe(true);
    expect(mayTypeClockTimes(null, person("manager", { canManualClockIn: false }))).toBe(true);
  });
  it("the freshest roster card decides (a switch flipped moments ago)", () => {
    const stale = person("crew");
    const state = { crew: [{ ...stale, permissions: { canManualClockIn: true } }] } as unknown as AppState;
    expect(mayTypeClockTimes(state, stale)).toBe(true);
  });
  it("an edit without the right keeps date, clock times and hours, and saves job, notes and location", () => {
    const old = entry();
    const next = entry({
      date: "2026-11-15",
      clockIn: "05:00",
      clockOut: "18:00",
      hours: 10,
      notes: "chipper",
      location: "Shop",
      jobId: "j1",
    });
    expect(limitTimesheetEdit(old, next, false)).toEqual(
      entry({ notes: "chipper", location: "Shop", jobId: "j1" }),
    );
    expect(limitTimesheetEdit(old, next, true)).toEqual(next);
  });
  it("a tap kept on the phone (no signal) is sent with the time it was tapped", () => {
    // The database allows such a tap up to 12 hours old (migration
    // the "manager pay and live clock-in" rules), so a day without signal still saves.
    const open = entry({ clockOut: null });
    const state = { timesheets: [open], auditLog: [], jobs: [] } as unknown as AppState;
    const op: FieldOp = { id: "op1", kind: "clockOut", entryId: "t1", at: "15:42", audit: [] };
    expect(applyFieldOp(state, op).timesheets[0].clockOut).toBe("15:42");
  });
});
