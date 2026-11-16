import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AFTER_8PM_TEXT,
  clockOutTapTime,
  pastClockDayEnd,
} from "../clockTime";
import {
  closedAt8Entries,
  jobCoversDay,
  liveEntryHours,
  overlappingEntryIds,
  runningEntries,
  switchClock,
} from "../crewDay";
import { clockInJobsToday } from "../geofence";
import { firstAssignedJobToday, jobsOnDay } from "../scheduling";
import { entryHours, endsNextDay, hoursBetween } from "../utils";
import { unsentTapsWarning } from "../fieldQueue";
import { canManualClockIn } from "../permissions";
import { geocodeAddress } from "../routing";
import type { AppState, CrewMember, Job, Role, TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    customerId: "c1",
    serviceType: "Removal",
    title: id,
    date: "2026-11-16",
    startTime: "08:00",
    status: "scheduled",
    crewIds: ["gus"],
    notes: "",
    customerNotes: "",
    teamNotes: "",
    officeNotes: "",
    pruneClass: null,
    ...over,
  } as Job;
}

function entry(id: string, over: Partial<TimesheetEntry> = {}): TimesheetEntry {
  return {
    id,
    crewId: "gus",
    jobId: null,
    date: "2026-11-16",
    clockIn: "07:00",
    clockOut: null,
    hours: null,
    notes: "",
    location: "",
    ...over,
  };
}

const stateWith = (jobs: Job[]): AppState => ({ jobs, timesheets: [], crew: [] }) as unknown as AppState;

// Denver is UTC-7 in November.
const denver = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-07:00`);

describe("multi-day jobs are on the crew's Today on every day they span", () => {
  const big = job("big", { date: "2026-11-16", endDate: "2026-11-18" });
  it("covers each day from the start to the end date", () => {
    expect(jobCoversDay(big, "2026-11-15")).toBe(false);
    expect(jobCoversDay(big, "2026-11-17")).toBe(true);
    expect(jobCoversDay(big, "2026-11-18")).toBe(true);
    expect(jobCoversDay(big, "2026-11-19")).toBe(false);
    // An end date before the start counts as one day.
    expect(jobCoversDay(job("x", { endDate: "2026-11-10" }), "2026-11-16")).toBe(true);
  });
  it("is in the clock-in list and the default clock-in job on day 2", () => {
    const state = stateWith([big, job("other", { date: "2026-11-17", startTime: "09:00" })]);
    expect(jobsOnDay(state, "2026-11-17").map((j) => j.id)).toEqual(["big", "other"]);
    expect(firstAssignedJobToday(state, "gus", "2026-11-17")?.id).toBe("big");
  });
});

describe('"Clock in here" checks the tapped job, not only the first stop', () => {
  const stop1 = job("stop1", { startTime: "07:00", status: "in_progress" });
  const stop2 = job("stop2", { startTime: "10:00" });
  const done = job("done", { startTime: "06:00", status: "done" });
  const notMine = job("cover", { startTime: "11:00", crewIds: ["cal"] });
  const state = stateWith([stop1, stop2, done, notMine]);
  it("every unfinished stop of mine today opens clock-in", () => {
    expect(clockInJobsToday(state, "gus", null, "2026-11-16").map((j) => j.id)).toEqual(["stop1", "stop2"]);
  });
  it("the tapped job comes first, even one I'm covering", () => {
    expect(clockInJobsToday(state, "gus", "stop2", "2026-11-16").map((j) => j.id)).toEqual(["stop2", "stop1"]);
    expect(clockInJobsToday(state, "gus", "cover", "2026-11-16").map((j) => j.id)).toEqual(["cover", "stop1", "stop2"]);
  });
});

describe("hours past midnight are never shown as 0", () => {
  it("counts an end before the start as the next day, like weekly pay", () => {
    expect(hoursBetween("22:00", "02:00")).toBe(4);
    expect(hoursBetween("07:00", "15:30")).toBe(8.5);
    expect(entryHours(entry("n", { clockIn: "22:00", clockOut: "02:00" }))).toBe(4);
    expect(endsNextDay(entry("n", { clockIn: "22:00", clockOut: "02:00" }))).toBe(true);
    expect(endsNextDay(entry("d", { clockIn: "07:00", clockOut: "15:00" }))).toBe(false);
  });
  it("finds overlaps with an entry that runs past midnight", () => {
    const ids = overlappingEntryIds([
      entry("night", { clockIn: "22:00", clockOut: "02:00" }),
      entry("late", { clockIn: "23:00", clockOut: "23:30" }),
    ]);
    expect([...ids].sort()).toEqual(["late", "night"]);
  });
});

describe("the 8 PM rule on the phone", () => {
  it("no live clock-in after 8 PM", () => {
    expect(pastClockDayEnd(denver("2026-11-16", "19:59"))).toBe(false);
    expect(pastClockDayEnd(denver("2026-11-16", "20:00"))).toBe(true);
    expect(AFTER_8PM_TEXT).toBe("After 8 PM the office enters hours.");
  });
  it("Clock out after 8 PM, or on an earlier day's entry, saves 20:00", () => {
    const today = entry("t", { date: "2026-11-16" });
    expect(clockOutTapTime(today, denver("2026-11-16", "15:42"))).toEqual({ time: "15:42", autoClosed: false });
    expect(clockOutTapTime(today, denver("2026-11-16", "21:05"))).toEqual({ time: "20:00", autoClosed: true });
    expect(clockOutTapTime(today, denver("2026-11-17", "07:00"))).toEqual({ time: "20:00", autoClosed: true });
  });
  it("Today shows an earlier day's open clock as closed at 8 PM, not as running", () => {
    const now = denver("2026-11-17", "07:30");
    const timesheets = [
      entry("monday", { date: "2026-11-16" }),
      entry("auto", { date: "2026-11-16", clockIn: "12:00", clockOut: "20:00", autoClosed: true }),
      entry("old-auto", { date: "2026-11-10", clockOut: "20:00", autoClosed: true }),
      entry("now", { date: "2026-11-17", clockIn: "07:15" }),
    ];
    expect(runningEntries(timesheets, "gus", now).map((t) => t.id)).toEqual(["now"]);
    expect(closedAt8Entries(timesheets, "gus", now).map((t) => t.id).sort()).toEqual(["auto", "monday"]);
    // After 8 PM today's open clock has ended too.
    expect(runningEntries(timesheets, "gus", denver("2026-11-17", "20:30"))).toEqual([]);
  });
  it("My hours counts an open clock only up to 8 PM", () => {
    expect(liveEntryHours(entry("o", { date: "2026-11-16" }), "2026-11-16", "21:00")).toBe(13);
    expect(liveEntryHours(entry("o", { date: "2026-11-16" }), "2026-11-16", "10:30")).toBe(3.5);
  });
  it("clocking in closes an earlier day's open clock at 8 PM, marked automatic", () => {
    const res = switchClock(
      [entry("monday", { date: "2026-11-16" }), entry("late", { date: "2026-11-15", clockIn: "21:00" })],
      entry("tue", { date: "2026-11-17", clockIn: "07:00", jobId: "j" }),
    );
    expect(res.closed.map((t) => [t.id, t.clockOut, t.autoClosed])).toEqual([["monday", "20:00", true]]);
    // One clocked in after 8 PM (typed by the office) is left for the office.
    expect(res.timesheets.find((t) => t.id === "late")?.clockOut).toBeNull();
  });
});

describe("Timesheets: the office sees the manual hours form by default", () => {
  const person = (appRole: Role, perms?: CrewMember["permissions"]): CrewMember =>
    ({ id: `p-${appRole}`, name: appRole, role: "Office", appRole, permissions: perms ?? null }) as CrewMember;
  it("office logins may enter hours by hand unless turned off", () => {
    expect(canManualClockIn(null, person("office"))).toBe(true);
    expect(canManualClockIn(null, person("office", { canManualClockIn: false }))).toBe(false);
    expect(canManualClockIn(null, person("crew"))).toBe(false);
    expect(canManualClockIn(null, person("manager"))).toBe(true);
  });
});

describe("sign-out warning tells refused taps apart", () => {
  const refused =
    "This tap was made more than 12 hours ago and couldn't be saved. Tell the office the time you tapped: 2026-11-16 at 06:58.";
  it("a refused tap is not 'sent when there is signal'", () => {
    const w = unsentTapsWarning(0, [refused]) ?? "";
    expect(w).toContain("You haven't told the office about a refused clock tap (2026-11-16 at 06:58)");
    expect(w).toContain("Signing out removes this note.");
    expect(w).not.toContain("no signal");
  });
  it("waiting taps still get the no-signal text", () => {
    expect(unsentTapsWarning(2) ?? "").toContain("2 clock or job taps are not sent yet (no signal)");
    expect(unsentTapsWarning(0, [])).toBeNull();
  });
});

describe("a failed address lookup is tried again", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("does not keep the failure for the whole page load", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("no signal"))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ lat: "39.7", lon: "-105.0" }] });
    vi.stubGlobal("fetch", fetchMock);
    const first = geocodeAddress("1 Weak Signal Rd, Anytown");
    await vi.runAllTimersAsync();
    expect(await first).toBeNull();
    const second = geocodeAddress("1 Weak Signal Rd, Anytown");
    await vi.runAllTimersAsync();
    expect(await second).toEqual({ lat: 39.7, lng: -105.0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Found: kept, no third lookup.
    await geocodeAddress("1 Weak Signal Rd, Anytown");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
