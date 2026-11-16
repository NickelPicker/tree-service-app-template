import { describe, expect, it } from "vitest";
import {
  changeSummary,
  changesFor,
  priceBoxLines,
  priceChanged,
  priceOf,
  reasonOk,
  unseenCrewChanges,
  type JobPrice,
} from "../priceChange";
import type { JobPriceChange } from "../types";

// Business rule (the "invoice email by hand" rules): a Climber sees the
// job's current price and what it will change to, and says why.
const flat = (value: number | null): JobPrice => ({ billingType: "flat", value, hourlyRate: null });
const hourly = (rate: number | null): JobPrice => ({ billingType: "hourly", value: null, hourlyRate: rate });

describe("price box text", () => {
  it("shows the current price and nothing new until it changes", () => {
    expect(priceBoxLines(flat(900), flat(900), null)).toEqual({ current: "Current price: $900", next: null });
  });

  it("shows the new price and the increase as it is typed", () => {
    expect(priceBoxLines(flat(900), flat(1100), null).next).toBe("New price: $1,100 (+$200)");
  });

  it("shows a decrease with a minus sign", () => {
    expect(priceBoxLines(flat(900), flat(850.5), null).next).toBe("New price: $850.50 (−$49.50)");
  });

  it("hourly: rate, the total for the hours, and the difference in total", () => {
    const l = priceBoxLines(hourly(90), hourly(100), 8);
    expect(l.current).toBe("Current price: $90/hr (≈ $720 for 8h)");
    expect(l.next).toBe("New price: $100/hr (≈ $800 for 8h) (+$80)");
  });

  it("hourly without hours: the difference per hour", () => {
    expect(priceBoxLines(hourly(90), hourly(80), null).next).toBe("New price: $80/hr (−$10/hr)");
  });

  it("flat to hourly with hours compares totals; without hours, no difference", () => {
    expect(priceBoxLines(flat(900), hourly(100), 8).next).toBe("New price: $100/hr (≈ $800 for 8h) (−$100)");
    expect(priceBoxLines(flat(900), hourly(100), null).next).toBe("New price: $100/hr");
  });

  it("an unset price reads 'not set'", () => {
    expect(priceBoxLines(flat(null), flat(400), null)).toEqual({
      current: "Current price: not set",
      next: "New price: $400",
    });
  });
});

describe("what counts as a change", () => {
  it("unset billing is flat", () => {
    const job = { billingType: null, value: 900, hourlyRate: null };
    expect(priceOf(job).billingType).toBeNull();
    expect(priceChanged(priceOf(job), flat(900))).toBe(false);
    expect(priceChanged(priceOf(job), hourly(null))).toBe(true);
  });

  it("a reason needs 3 to 1000 characters, spaces trimmed", () => {
    expect(reasonOk("")).toBe(false);
    expect(reasonOk("  ok ")).toBe(false);
    expect(reasonOk("Second stump")).toBe(true);
    expect(reasonOk("x".repeat(1000))).toBe(true);
    expect(reasonOk("x".repeat(1001))).toBe(false);
  });
});

describe("logged changes", () => {
  const base: JobPriceChange = {
    id: "c1",
    jobId: "j1",
    changedBy: "cal",
    changedByName: "Cal",
    byOffice: false,
    changedAt: "2026-11-16T15:00:00Z",
    oldValue: 900,
    newValue: 1100,
    oldHourlyRate: null,
    newHourlyRate: null,
    oldBillingType: "flat",
    newBillingType: "flat",
    reason: "Second stump",
    seenBy: null,
    seenAt: null,
  };

  it("reads old → new", () => {
    expect(changeSummary(base, null)).toBe("$900 → $1,100");
  });

  it("the office card lists only unseen crew changes, newest first", () => {
    const list: JobPriceChange[] = [
      base,
      { ...base, id: "c2", changedAt: "2026-11-16T16:00:00Z" },
      { ...base, id: "c3", seenAt: "2026-11-16T17:00:00Z", seenBy: "Dee" },
      { ...base, id: "c4", byOffice: true },
    ];
    expect(unseenCrewChanges(list).map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(changesFor(list, "j1").map((c) => c.id)[0]).toBe("c2");
    expect(changesFor(list, "other")).toEqual([]);
  });
});
