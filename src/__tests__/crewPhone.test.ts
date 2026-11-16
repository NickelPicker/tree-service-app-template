import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrivalTime,
  clashingTimes,
  clock12,
  liveEntryHours,
  myStopOrder,
  myWeek,
  overlappingEntryIds,
  switchClock,
} from "../crewDay";
import {
  addFieldOp,
  applyFieldOp,
  applyFieldOps,
  fieldOpsSent,
  fieldQueueSummary,
  isNoSignalError,
  isStaleFieldOp,
  queuedFieldOps,
  selectFieldQueueUser,
  setFieldOpsState,
  type FieldOp,
} from "../fieldQueue";
import { canMarkJobDone, canTapJobStatus, doneNeedsConfirm } from "../liveProgress";
import { groupPriceRows } from "../crewPrices";
import { seedState } from "../data/seed";
import type { AppState, Job, TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

// A small in-memory localStorage (tests run without a browser).
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

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
    jobId: "big-oak",
    date: "2026-11-16",
    clockIn: "07:00",
    clockOut: null,
    hours: null,
    notes: "",
    location: "",
    ...over,
  };
}

function state(over: Partial<AppState> = {}): AppState {
  return { ...seedState(), ...over };
}

describe("one route order for the crew screen", () => {
  it("orders stops by when this person gets there, not the job's start", () => {
    const bigOak = job("big-oak", { startTime: "07:00", crewArrivals: { gus: "09:42" } });
    const rush = job("rush-hedge", { startTime: "07:00", crewArrivals: { gus: "07:00" } });
    const elm = job("elm", { startTime: "11:00" });
    expect(myStopOrder([bigOak, elm, rush], "gus").map((j) => j.id)).toEqual([
      "rush-hedge",
      "big-oak",
      "elm",
    ]);
    expect(arrivalTime(bigOak, "gus")).toBe("09:42");
    expect(arrivalTime(bigOak, "cal")).toBe("07:00");
  });

  it("flags two stops at the same time", () => {
    const a = job("a", { startTime: "07:00" });
    const b = job("b", { startTime: "07:00" });
    const c = job("c", { startTime: "10:00" });
    expect(clashingTimes(myStopOrder([a, b, c], "gus"), "gus")).toEqual(["07:00"]);
    expect(clashingTimes([a, c], "gus")).toEqual([]);
  });

  it("writes times the crew read", () => {
    expect(clock12("07:05")).toBe("7:05 AM");
    expect(clock12("13:30")).toBe("1:30 PM");
    expect(clock12("00:15")).toBe("12:15 AM");
  });
});

describe("clocking in while already clocked in", () => {
  it("closes the open entry at the new clock-in time", () => {
    const open = entry("t1");
    const next = entry("t2", { jobId: "elm", clockIn: "09:30" });
    const res = switchClock([open], next);
    expect(res.unchanged).toBe(false);
    expect(res.closed.map((t) => t.id)).toEqual(["t1"]);
    expect(res.timesheets.find((t) => t.id === "t1")?.clockOut).toBe("09:30");
    expect(res.timesheets.find((t) => t.id === "t2")?.clockOut).toBeNull();
    expect(res.timesheets.filter((t) => t.clockOut === null)).toHaveLength(1);
  });

  it("does nothing when already clocked in to that job", () => {
    const res = switchClock([entry("t1")], entry("t2", { clockIn: "09:00" }));
    expect(res.unchanged).toBe(true);
    expect(res.timesheets).toHaveLength(1);
  });

  it("leaves other people alone, and closes an earlier day's open clock at 8 PM", () => {
    const mine = entry("t1");
    const yesterday = entry("t0", { date: "2026-11-15", clockIn: "15:00" });
    const cal = entry("c1", { crewId: "cal" });
    const res = switchClock([mine, yesterday, cal], entry("t2", { jobId: "elm", clockIn: "10:00" }));
    expect(res.closed.map((t) => t.id)).toEqual(["t0", "t1"]);
    const t0 = res.timesheets.find((t) => t.id === "t0");
    expect(t0?.clockOut).toBe("20:00");
    expect(t0?.autoClosed).toBe(true);
    expect(res.timesheets.find((t) => t.id === "c1")?.clockOut).toBeNull();
  });
});

describe("overlapping entries (shown in red)", () => {
  it("finds two open entries and crossing clock times", () => {
    const ids = overlappingEntryIds([
      entry("a"),
      entry("b", { clockIn: "08:00" }),
      entry("c", { crewId: "cal" }),
      entry("d", { date: "2026-11-17", clockIn: "07:00", clockOut: "09:00" }),
      entry("e", { date: "2026-11-17", clockIn: "08:30", clockOut: "10:00" }),
      entry("f", { date: "2026-11-18", clockIn: "07:00", clockOut: "09:00" }),
      entry("g", { date: "2026-11-18", clockIn: "09:00", clockOut: "10:00" }),
    ]);
    expect([...ids].sort()).toEqual(["a", "b", "d", "e"]);
  });
});

describe("My hours", () => {
  it("totals this week, counting today's open entry up to now", () => {
    const week = myWeek(
      [
        entry("mon", { date: "2026-11-16", clockIn: "07:00", clockOut: "15:30" }),
        entry("tue", { date: "2026-11-17", clockIn: "07:00", clockOut: null }),
        entry("hand", { date: "2026-11-18", clockIn: null, hours: 2 }),
        entry("last-week", { date: "2026-11-15", clockIn: "07:00", clockOut: "17:00" }),
        entry("cal", { crewId: "cal", date: "2026-11-16", clockIn: "07:00", clockOut: "15:00" }),
      ],
      "gus",
      "2026-11-17",
      "10:00",
    );
    expect(week.monday).toBe("2026-11-16");
    expect(week.sunday).toBe("2026-11-22");
    expect(week.entries.map((t) => t.id)).toEqual(["hand", "tue", "mon"]);
    expect(week.total).toBe(13.5);
    // An open entry from an earlier day counts to 8 PM of its day (the 8 PM rule).
    expect(liveEntryHours(entry("old", { date: "2026-11-16" }), "2026-11-17", "10:00")).toBe(13);
    // Today's open entry stops counting at 8 PM.
    expect(liveEntryHours(entry("late", { date: "2026-11-17" }), "2026-11-17", "21:30")).toBe(13);
  });
});

describe("who may mark a job done (business rule)", () => {
  const j = job("j", { crewIds: ["gus", "cal"] });
  it("anyone on the job, the office and owners: yes", () => {
    expect(canMarkJobDone(j, "cal", "crew")).toBe(true);
    expect(canMarkJobDone(j, "gus", "crew")).toBe(true);
    expect(canMarkJobDone(j, "x", "office")).toBe(true);
    expect(canMarkJobDone(j, "x", "owner")).toBe(true);
    expect(canMarkJobDone(j, "x", "manager")).toBe(true);
    expect(canTapJobStatus(j, "gus", "crew")).toBe(true);
  });
  it("crew not on the job: no", () => {
    expect(canMarkJobDone(j, "sam", "crew")).toBe(false);
  });
  it("groundsmen confirm Done with a second tap; climbers, office and owners do not", () => {
    expect(doneNeedsConfirm("crew", "Groundsman")).toBe(true);
    expect(doneNeedsConfirm("crew", null)).toBe(true);
    expect(doneNeedsConfirm("crew", "Climber")).toBe(false);
    expect(doneNeedsConfirm("office", "Groundsman")).toBe(false);
    expect(doneNeedsConfirm("owner", null)).toBe(false);
    expect(doneNeedsConfirm("manager", null)).toBe(false);
  });
});

describe("field actions kept on the phone", () => {
  beforeEach(() => {
    localStorage.clear();
    selectFieldQueueUser(null);
    selectFieldQueueUser("user-1");
  });

  const clockOp = (id: string, e: TimesheetEntry): FieldOp => ({ id, kind: "clockIn", entry: e, audit: [] });

  it("applies a clock-in once, however often it is re-applied", () => {
    const s0 = state({ timesheets: [entry("t1")] });
    const op = clockOp("op1", entry("t2", { jobId: "elm", clockIn: "09:30" }));
    const s1 = applyFieldOp(s0, op);
    expect(s1.timesheets).toHaveLength(2);
    expect(s1.timesheets.find((t) => t.id === "t1")?.clockOut).toBe("09:30");
    const s2 = applyFieldOp(s1, op);
    expect(s2).toBe(s1);
    // After a reload from the last good server copy, it goes back in.
    expect(applyFieldOp(s0, op).timesheets).toHaveLength(2);
  });

  it("re-applies a status tap only while the job is as it was", () => {
    const op: FieldOp = { id: "op2", kind: "status", jobId: "j", from: "scheduled", to: "in_progress", audit: [] };
    const s0 = state({ jobs: [job("j")] });
    expect(applyFieldOp(s0, op).jobs[0].status).toBe("in_progress");
    const changed = state({ jobs: [job("j", { status: "done" })] });
    expect(isStaleFieldOp(changed, op)).toBe(true);
    expect(applyFieldOp(changed, op)).toBe(changed);
  });

  it("clock-out sets the time only if still open; audit entries are added once", () => {
    const audit = [
      {
        id: "a1",
        timestamp: "2026-11-16T10:00:00Z",
        actor: "Gus",
        entity: "Timesheet",
        entityId: "t1",
        entityLabel: "x",
        field: "clockOut",
        oldValue: "",
        newValue: "10:00",
        customerId: null,
      },
    ];
    const op: FieldOp = { id: "op3", kind: "clockOut", entryId: "t1", at: "10:00", audit };
    const s1 = applyFieldOps(state({ timesheets: [entry("t1")] }), [op, op]);
    expect(s1.timesheets[0].clockOut).toBe("10:00");
    expect(s1.auditLog.filter((a) => a.id === "a1")).toHaveLength(1);
    const closed = state({ timesheets: [entry("t1", { clockOut: "09:00" })] });
    expect(applyFieldOp(closed, op).timesheets[0].clockOut).toBe("09:00");
  });

  it("keeps actions per login across a reload until they are sent", () => {
    addFieldOp(clockOp("op1", entry("t2")), "Clock in");
    expect(queuedFieldOps()).toHaveLength(1);
    expect(queuedFieldOps()[0].state).toBe("sending");
    // Reload: what was not sent yet waits for signal.
    selectFieldQueueUser(null);
    expect(queuedFieldOps()).toHaveLength(0);
    selectFieldQueueUser("user-1");
    expect(queuedFieldOps().map((q) => q.state)).toEqual(["waiting"]);
    // Another login on the phone never sees it.
    selectFieldQueueUser("user-2");
    expect(queuedFieldOps()).toHaveLength(0);
    selectFieldQueueUser("user-1");
    fieldOpsSent(["op1"]);
    expect(queuedFieldOps()).toHaveLength(0);
    selectFieldQueueUser(null);
    selectFieldQueueUser("user-1");
    expect(queuedFieldOps()).toHaveLength(0);
  });

  it("says no signal, or not saved, in plain words", () => {
    expect(fieldQueueSummary([])).toBeNull();
    addFieldOp(clockOp("op1", entry("t2")), "Clock in");
    expect(fieldQueueSummary(queuedFieldOps())).toBeNull();
    setFieldOpsState("waiting");
    expect(fieldQueueSummary(queuedFieldOps())?.text).toBe("No signal: saved on this phone, will send when you're back online");
    setFieldOpsState("failed", ["sending", "waiting"]);
    expect(fieldQueueSummary(queuedFieldOps())).toEqual({ tone: "failed", text: "Not saved — tap to retry" });
  });

  it("tells a lost signal from a refusal", () => {
    expect(isNoSignalError("anything", false)).toBe(true);
    expect(isNoSignalError("Supabase audit_log write failed: TypeError: Failed to fetch", true)).toBe(true);
    expect(isNoSignalError("Request timed out after 15s — the database didn't answer.", true)).toBe(true);
    expect(isNoSignalError("new row violates row-level security policy", true)).toBe(false);
  });
});

describe("Climber prices", () => {
  it("groups the database rows by job", () => {
    const m = groupPriceRows([
      { job_id: "j1", line_id: "b1", description: "Remove oak", price: 1500 },
      { job_id: "j1", line_id: "b2", description: "Grind stump", price: "251.00" },
      { job_id: "j2", line_id: "l1", description: "Trim elm", price: 400 },
      { job_id: null, description: "bad" },
    ]);
    expect(m.get("j1")).toEqual([
      { lineId: "b1", description: "Remove oak", price: 1500 },
      { lineId: "b2", description: "Grind stump", price: 251 },
    ]);
    expect(m.get("j2")?.[0].price).toBe(400);
    expect(m.size).toBe(2);
    expect(groupPriceRows(null).size).toBe(0);
  });
});
