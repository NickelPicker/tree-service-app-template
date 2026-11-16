import { describe, expect, it } from "vitest";
import { hourlyLaborCost } from "../jobValue";
import { baseState, job, person } from "../planner/__tests__/fixtures";

describe("count on every job's labor cost", () => {
  it("adds people ticked on their card, once, instead of a hard-coded name", () => {
    const state = baseState({
      crew: [
        person("g", ["ground_work"], { payType: "hourly", payAmount: 25 }),
        person("d", [], { name: "Sam Manager", payType: "hourly", payAmount: 30, countedOnEveryJob: true }),
        person("x", [], { name: "Not Ticked", payType: "hourly", payAmount: 99 }),
      ],
      jobs: [job("j", { crewIds: ["g"] })],
    });
    const r = hourlyLaborCost(state, state.jobs[0], ["g"]);
    expect(r.perHour).toBe(55);
    expect(r.alwaysCounted).toEqual(["Sam Manager"]);
    expect(hourlyLaborCost(state, state.jobs[0], ["g", "d"]).perHour).toBe(55);
  });
});
