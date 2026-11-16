import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOCK_OUT_MAX_AGE_HOURS,
  clockMoments,
  clockNow,
  eightPmClockOut,
  dayBefore,
  isTapTooOldMessage,
  tappedAtFromMessage,
} from "../clockTime";
import {
  addFieldOp,
  dismissTooOldTap,
  fieldOpsSent,
  fieldQueueSummary,
  markTooOldTaps,
  queuedFieldOps,
  selectFieldQueueUser,
  sendableFieldOps,
  setFieldOpsState,
  tooOldTapIds,
  type FieldOp,
} from "../fieldQueue";
import type { TimesheetEntry } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

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

const entry = (over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: "t1",
  crewId: "gus",
  jobId: null,
  date: "2026-11-14",
  clockIn: "07:02",
  clockOut: null,
  hours: null,
  notes: "",
  location: "",
  ...over,
});
const clockInOp = (id: string, e: TimesheetEntry): FieldOp => ({ id, kind: "clockIn", entry: e, audit: [] });
const oldMsg = (h: number, date: string, time: string) =>
  `This tap was made more than ${h} hours ago and couldn't be saved. Tell the office the time you tapped: ${date} at ${time}.`;

describe("tap times are Denver time, whatever the phone's zone", () => {
  it("takes the Denver date and time of a moment", () => {
    // 2026-11-16 02:30 UTC is still the 15th, 7:30 pm, in Denver (MST).
    expect(clockNow(new Date("2026-11-16T02:30:00Z"))).toEqual({ date: "2026-11-15", time: "19:30" });
    // Summer (MDT, -6).
    expect(clockNow(new Date("2026-07-01T14:05:00Z"))).toEqual({ date: "2026-07-01", time: "08:05" });
    expect(clockNow(new Date("2026-11-16T07:00:00Z"))).toEqual({ date: "2026-11-16", time: "00:00" });
  });
  it("a Denver time maps back to its moment", () => {
    expect(clockMoments("2026-11-15", "19:30")).toEqual([Date.parse("2026-11-16T02:30:00Z")]);
    // A clock-out earlier than the clock-in is the next day.
    expect(clockMoments("2026-11-15", "00:30", "23:00")).toEqual([Date.parse("2026-11-16T07:30:00Z")]);
  });
  it("the repeated 1 am hour when the clocks go back has two readings; the skipped one none", () => {
    expect(clockMoments("2026-11-01", "01:30").sort()).toEqual(
      [Date.parse("2026-11-01T07:30:00Z"), Date.parse("2026-11-01T08:30:00Z")].sort(),
    );
    expect(clockMoments("2026-03-08", "02:30")).toEqual([]);
  });
});

describe("forgotten clock-outs: the 8 PM rule ends them (no overnight shifts)", () => {
  const morning = new Date("2026-11-16T15:00:00Z"); // 8:00 am Denver, Nov 16
  const night = new Date("2026-11-16T09:00:00Z"); // 2:00 am Denver, Nov 16
  it("today's open entry still runs before 8 PM", () => {
    expect(CLOCK_OUT_MAX_AGE_HOURS).toBe(24);
    expect(eightPmClockOut(entry({ date: "2026-11-16", clockIn: "07:00" }), morning)).toBeNull();
  });
  it("an entry from an earlier day ended at 8 PM", () => {
    expect(eightPmClockOut(entry({ date: "2026-11-15", clockIn: "07:00" }), morning)).toBe("20:00");
    expect(eightPmClockOut(entry({ date: "2026-11-14", clockIn: "07:00" }), morning)).toBe("20:00");
    // Older than 3 days: left for the office, as the database does.
    expect(eightPmClockOut(entry({ date: "2026-11-12", clockIn: "07:00" }), morning)).toBeNull();
    expect(eightPmClockOut(entry({ date: "2026-11-15", clockIn: "07:00" }), night)).toBe("20:00");
  });
  it("one clocked in at 8 PM or later (typed by the office) is left alone", () => {
    expect(eightPmClockOut(entry({ date: "2026-11-15", clockIn: "22:00" }), night)).toBeNull();
  });
  it("uses the Denver date, not the phone's", () => {
    // 2026-11-16 02:30 UTC: the 16th in UTC, still the 15th (7:30 pm) in Denver.
    expect(eightPmClockOut(entry({ date: "2026-11-15", clockIn: "07:00" }), new Date("2026-11-16T02:30:00Z"))).toBeNull();
    // 03:10 UTC = 8:10 pm Denver on the 15th: today's entry has ended.
    expect(eightPmClockOut(entry({ date: "2026-11-15", clockIn: "07:00" }), new Date("2026-11-16T03:10:00Z"))).toBe("20:00");
    expect(dayBefore("2026-11-01")).toBe("2026-10-31");
  });
  it("entries without a clock-in, or already closed, are not touched", () => {
    expect(eightPmClockOut(entry({ clockIn: null }), morning)).toBeNull();
    expect(eightPmClockOut(entry({ date: "2026-11-15", clockIn: "07:00", clockOut: "15:00" }), morning)).toBeNull();
  });
});

describe("taps refused as too old are kept, never dropped", () => {
  beforeEach(() => {
    localStorage.clear();
    selectFieldQueueUser(null);
    selectFieldQueueUser("user-1");
  });
  it("reads the database's too-old message", () => {
    const m = oldMsg(12, "2026-11-14", "07:02");
    expect(isTapTooOldMessage(m)).toBe(true);
    expect(isTapTooOldMessage("Clock times come from tapping Clock in and Clock out")).toBe(false);
    expect(tappedAtFromMessage(m)).toEqual({ date: "2026-11-14", time: "07:02" });
  });
  it("matches the message to the queued tap by its date and time", () => {
    addFieldOp(clockInOp("a", entry()), "Clock in");
    addFieldOp(clockInOp("b", entry({ id: "t2", clockIn: "09:00" })), "Clock in");
    addFieldOp({ id: "c", kind: "clockOut", entryId: "t9", at: "16:10", date: "2026-11-13", audit: [] }, "Clock out");
    const hits = tooOldTapIds(queuedFieldOps(), [oldMsg(12, "2026-11-14", "07:02"), oldMsg(72, "2026-11-13", "16:10")]);
    expect([...hits.keys()].sort()).toEqual(["a", "c"]);
  });
  it("the earlier-day clock-out message is kept the same way, with the entry's clock-in", () => {
    const msg =
      "This clock-out is for an entry from an earlier day and couldn't be saved. Ask the office to close this entry. Tell the office the time you tapped: 2026-11-14 at 21:00.";
    expect(isTapTooOldMessage(msg)).toBe(true);
    // Clocked in and out without signal yesterday: one row, two taps.
    addFieldOp(clockInOp("in", entry({ clockIn: "20:00" })), "Clock in");
    addFieldOp({ id: "out", kind: "clockOut", entryId: "t1", at: "21:00", date: "2026-11-14", audit: [] }, "Clock out");
    expect(markTooOldTaps([msg])).toBe(2);
    fieldOpsSent(["in", "out"]);
    const q = queuedFieldOps();
    expect(q.map((x) => x.op.id)).toEqual(["in", "out"]);
    expect(q[0].tooOld).toContain("tapped: 2026-11-14 at 20:00");
    expect(q[1].tooOld).toContain("tapped: 2026-11-14 at 21:00");
  });
  it("a refused tap stays queued, failed with the message, after the save reports it sent", () => {
    addFieldOp(clockInOp("a", entry()), "Clock in");
    addFieldOp(clockInOp("b", entry({ id: "t2", clockIn: "09:00" })), "Clock in");
    expect(markTooOldTaps([oldMsg(12, "2026-11-14", "07:02")])).toBe(1);
    fieldOpsSent(["a", "b"]);
    const q = queuedFieldOps();
    expect(q.map((x) => x.op.id)).toEqual(["a"]);
    expect(q[0].state).toBe("failed");
    expect(q[0].tooOld).toContain("Tell the office the time you tapped: 2026-11-14 at 07:02");
    // Not sent again, not re-marked by later saves, and kept across a reload.
    expect(sendableFieldOps(q)).toEqual([]);
    setFieldOpsState("waiting");
    expect(queuedFieldOps()[0].state).toBe("failed");
    selectFieldQueueUser(null);
    selectFieldQueueUser("user-1");
    expect(queuedFieldOps()[0].tooOld).toBeTruthy();
    expect(fieldQueueSummary(queuedFieldOps())).toEqual({ tone: "failed", text: q[0].tooOld });
  });
  it("only the person's own 'I told the office' removes it", () => {
    addFieldOp(clockInOp("a", entry()), "Clock in");
    dismissTooOldTap("a");
    expect(queuedFieldOps()).toHaveLength(1); // not too old: not removable this way
    markTooOldTaps([oldMsg(12, "2026-11-14", "07:02")]);
    dismissTooOldTap("a");
    expect(queuedFieldOps()).toEqual([]);
  });
  it("other refusals do not mark taps", () => {
    addFieldOp(clockInOp("a", entry()), "Clock in");
    expect(markTooOldTaps(["Clock times come from tapping Clock in and Clock out on your phone."])).toBe(0);
    fieldOpsSent(["a"]);
    expect(queuedFieldOps()).toEqual([]);
  });
});

describe("the save treats a too-old tap as a per-row refusal", () => {
  it("CT001 counts like 42501, so the rest of the save still goes through", async () => {
    const { isRefusalCode } = await import("../data/supabaseAdapter");
    expect(isRefusalCode("42501")).toBe(true);
    expect(isRefusalCode("CT001")).toBe(true);
    expect(isRefusalCode("23505")).toBe(false);
    expect(isRefusalCode(undefined)).toBe(false);
  });
});
