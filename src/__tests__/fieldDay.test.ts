import { describe, expect, it } from "vitest";
import { arrivalLabel, planTimeNote, shouldOfferClockOut, whereLine } from "../fieldDay";
import { saveBannerKind, type QueuedFieldOp } from "../fieldQueue";
import type { Job, TimesheetEntry } from "../types";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j",
    customerId: "c1",
    serviceType: "Removal",
    title: "Big oak",
    date: "2026-11-16",
    startTime: "07:00",
    status: "scheduled",
    crewIds: ["gus", "cal"],
    notes: "",
    customerNotes: "",
    teamNotes: "",
    officeNotes: "",
    pruneClass: null,
    ...over,
  } as Job;
}

const open: TimesheetEntry = {
  id: "t",
  crewId: "gus",
  jobId: "j",
  date: "2026-11-16",
  clockIn: "07:00",
  clockOut: null,
  hours: null,
  notes: "",
  location: "",
};

describe("one time per job, personal times labelled (audit #12)", () => {
  it("shows the saved start time when there is no personal arrival", () => {
    expect(arrivalLabel(job(), "cal")).toEqual({ main: "7:00 AM", sub: null });
  });
  it("labels a Plan board arrival as yours, next to the job's start", () => {
    expect(arrivalLabel(job({ crewArrivals: { gus: "15:17" } }), "gus")).toEqual({
      main: "You arrive ~3:17 PM",
      sub: "job starts 7:00 AM",
    });
    expect(arrivalLabel(job({ crewArrivals: { gus: "15:17" } }), "cal").main).toBe("7:00 AM");
  });
  it("an arrival equal to the start is just the start", () => {
    expect(arrivalLabel(job({ crewArrivals: { gus: "07:00" } }), "gus")).toEqual({ main: "7:00 AM", sub: null });
  });
  it("Plan board: says when the board's time differs from the saved one", () => {
    expect(planTimeNote("14:05", 7 * 60)).toBe("Saved start 2:05 PM: the board suggests 7:00 AM. Save day to use it.");
    expect(planTimeNote("07:00", 7 * 60)).toBeNull();
    expect(planTimeNote("07:00", null)).toBeNull();
  });
});

describe("a pin with no address (audit #13)", () => {
  it("says Dropped pin, not ask the office", () => {
    expect(whereLine("", { lat: 39.86, lng: -104.98 })).toBe("Dropped pin — tap Navigate");
    expect(whereLine(null, { lat: null, lng: null })).toBe("No address — ask the office");
    expect(whereLine("1 Main St", { lat: 1, lng: 2 })).toBe("1 Main St");
  });
});

describe("clock out after the last Done", () => {
  it("offers it when every job today is done and the clock is still running", () => {
    expect(shouldOfferClockOut([job({ status: "done" })], open)).toBe(true);
    expect(shouldOfferClockOut([job({ status: "done" }), job({ id: "k" })], open)).toBe(false);
    expect(shouldOfferClockOut([job({ status: "done" })], null)).toBe(false);
    expect(shouldOfferClockOut([], open)).toBe(false);
  });
});

describe("save banner: no signal is not a failure (audit #8)", () => {
  const q = (state: QueuedFieldOp["state"]): QueuedFieldOp => ({
    op: { id: "1", kind: "status", jobId: "j", from: "scheduled", to: "done", audit: [] },
    label: "Done",
    state,
    addedAt: 0,
  });
  it("a field tap kept on the phone gets the calm note", () => {
    expect(saveBannerKind("error", "TypeError: Failed to fetch", [q("waiting")], true, false)).toBe("offline-saved");
    expect(saveBannerKind("error", "anything", [q("waiting")], false, false)).toBe("offline-saved");
  });
  it("another change waiting with the tap (only in memory) stays red", () => {
    expect(saveBannerKind("error", "TypeError: Failed to fetch", [q("waiting")], true, true)).toBe("offline-unsaved");
    expect(saveBannerKind("error", "anything", [q("waiting")], false, true)).toBe("offline-unsaved");
  });
  it("a sign-in problem while online is never 'saved on this phone'", () => {
    expect(saveBannerKind("error", "Couldn't save — sign-in needs refreshing", [q("waiting")], true, false)).toBe(
      "offline-unsaved",
    );
    expect(saveBannerKind("error", "no company access", [q("waiting")], true, false)).toBe("offline-unsaved");
  });
  it("no signal with nothing kept on the phone stays red", () => {
    expect(saveBannerKind("error", "Failed to fetch", [], true, false)).toBe("offline-unsaved");
  });
  it("a refusal from the database is red", () => {
    expect(saveBannerKind("error", "new row violates row-level security", [q("failed")], true, false)).toBe("failed");
  });
  it("nothing to show when the save went through", () => {
    expect(saveBannerKind("saved", null, [], true, false)).toBe("none");
  });
});
