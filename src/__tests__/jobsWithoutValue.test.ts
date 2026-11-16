import { describe, expect, it } from "vitest";
import { jobsWithoutValue } from "../jobsWithoutValue";
import { baseState, job } from "../planner/__tests__/fixtures";

describe("jobs without a value", () => {
  it("lists upcoming, not-done jobs with no value, soonest first", () => {
    const state = baseState({
      jobs: [
        job("later", { date: "2026-12-05", value: null }),
        job("soon", { date: "2026-11-20", value: 0 }),
        job("priced", { date: "2026-11-21", value: 800 }),
        job("past", { date: "2026-11-01", value: null }),
        job("done", { date: "2026-11-22", value: null, status: "done" }),
        job("hourly", { date: "2026-11-23", value: null, billingType: "hourly", hourlyRate: 100, estimatedHours: 4 }),
      ],
    });
    expect(jobsWithoutValue(state, "2026-11-15").map((j) => j.id)).toEqual(["soon", "later"]);
  });
});
