import { describe, expect, it, vi } from "vitest";
import {
  crewEquipmentSummary,
  crewTotal,
  planFromEstimate,
  toggleId,
  withCounts,
  withCrewToggled,
} from "../estimateCrew";
import { estimateCrewNeed, requiredCrew, suggestCrew } from "../crewSuggest";
import { estimateEmailPreview, estimateForCustomer } from "../estimatePreview";
import { estimateEmail } from "../email";
import { seedState } from "../data/seed";
import type { AppState, CrewMember, Customer, Equipment, Estimate, Job } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const person = (id: string, name: string, role: string, over: Partial<CrewMember> = {}): CrewMember =>
  ({ id, name, role, phone: "", color: "#000", appRole: "crew", email: "", status: "active", ...over }) as CrewMember;
const machine = (id: string, name: string, over: Partial<Equipment> = {}): Equipment =>
  ({ id, name, kind: "Truck", details: "", status: "available", ...over }) as Equipment;

const crew = [
  person("mike", "Mike", "Climber"),
  person("jose", "Jose", "Groundsman"),
  person("luis", "Luis", "Groundsman"),
];
const fleet = [machine("chiptruck", "Chip truck"), machine("chipper", "Chipper", { kind: "Chipper" })];

const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  id: "e1",
  customerId: "c1",
  jobId: null,
  title: "Remove big oak",
  lines: [{ id: "l1", description: "Remove oak", quantity: 1, unitPrice: 1200 }],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "accepted",
  createdDate: "2026-11-15",
  notes: "",
  emailQueuedAt: null,
  ...over,
});

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "j1",
    customerId: "c1",
    serviceType: "Removal",
    title: "Remove big oak",
    date: "2026-11-20",
    startTime: "08:00",
    status: "scheduled",
    crewIds: [],
    notes: "",
    treeIds: [],
    equipmentIds: [],
    estimateId: null,
    expectedCrew: null,
    ...over,
  }) as Job;

describe("expected crew total", () => {
  it("is climbers + groundsmen when no names are picked", () => {
    expect(crewTotal({ expectedClimbers: 1, expectedGroundsmen: 2 })).toBe(3);
    expect(crewTotal({ expectedClimbers: 0, expectedGroundsmen: 2 })).toBe(2);
  });
  it("is the number of names when names are picked", () => {
    expect(crewTotal({ expectedClimbers: 1, expectedGroundsmen: 2, expectedCrewIds: ["mike", "jose"] })).toBe(2);
    expect(crewTotal({ expectedCrewIds: ["mike", "mike"] })).toBe(1);
  });
  it("is null when nothing is set", () => {
    expect(crewTotal({})).toBeNull();
    expect(crewTotal({ expectedClimbers: 0, expectedGroundsmen: 0, expectedCrewIds: [] })).toBeNull();
  });
  it("steppers keep expectedCrew in step, and 0 + 0 clears everything", () => {
    expect(withCounts({}, 1, 2)).toEqual({
      expectedClimbers: 1,
      expectedGroundsmen: 2,
      expectedCrewIds: null,
      expectedCrew: 3,
    });
    expect(withCounts({ expectedClimbers: 1, expectedGroundsmen: 0 }, 0, 0)).toMatchObject({
      expectedClimbers: null,
      expectedGroundsmen: null,
      expectedCrew: null,
    });
    expect(withCounts({}, -3, 99)).toMatchObject({ expectedClimbers: 0, expectedGroundsmen: 50 });
  });
  it("tapping names switches the total to the names, and back", () => {
    const one = withCrewToggled({ expectedClimbers: 1, expectedGroundsmen: 2 }, "mike");
    expect(one.expectedCrewIds).toEqual(["mike"]);
    expect(one.expectedCrew).toBe(1);
    const none = withCrewToggled(one, "mike");
    expect(none.expectedCrewIds).toBeNull();
    expect(none.expectedCrew).toBe(3);
  });
  it("equipment taps toggle without duplicates", () => {
    expect(toggleId(null, "chipper")).toEqual(["chipper"]);
    expect(toggleId(["chipper"], "chipper")).toBeNull();
    expect(toggleId(["chiptruck"], "chipper")).toEqual(["chiptruck", "chipper"]);
  });
});

describe("crew and equipment summary line", () => {
  it("reads like the owner said it", () => {
    expect(
      crewEquipmentSummary(
        { expectedClimbers: 1, expectedGroundsmen: 2, equipmentIds: ["chiptruck", "chipper"] },
        crew,
        fleet,
      ),
    ).toBe("Crew: 1 climber + 2 groundsmen · Equipment: Chip truck, Chipper");
  });
  it("uses names when names are picked", () => {
    expect(crewEquipmentSummary({ expectedClimbers: 1, expectedCrewIds: ["mike", "jose"] }, crew, fleet)).toBe(
      "Crew: Mike, Jose",
    );
  });
  it("singular/plural and one side only", () => {
    expect(crewEquipmentSummary({ expectedClimbers: 2, expectedGroundsmen: 1 }, crew, fleet)).toBe(
      "Crew: 2 climbers + 1 groundsman",
    );
    expect(crewEquipmentSummary({ expectedGroundsmen: 2 }, crew, fleet)).toBe("Crew: 2 groundsmen");
  });
  it("an older estimate with only a number still reads", () => {
    expect(crewEquipmentSummary({ expectedCrew: 3 }, crew, fleet)).toBe("Crew: 3 people");
  });
  it("is empty when nothing is set, and skips removed equipment", () => {
    expect(crewEquipmentSummary({}, crew, fleet)).toBe("");
    expect(crewEquipmentSummary({ equipmentIds: ["gone", "chipper"] }, crew, fleet)).toBe("Equipment: Chipper");
  });
});

describe("making the job from the estimate", () => {
  const state = { crew, timeOff: [], unavailability: [] } as unknown as AppState;

  it("merges the equipment onto the job without duplicates", () => {
    const plan = planFromEstimate(
      state,
      job({ equipmentIds: ["chipper"] }),
      estimate({ equipmentIds: ["chiptruck", "chipper", "chiptruck"] }),
    );
    expect(plan.equipmentIds).toEqual(["chipper", "chiptruck"]);
  });
  it("carries the total when the job has none", () => {
    expect(planFromEstimate(state, job(), estimate({ expectedCrew: 3 })).expectedCrew).toBe(3);
    expect(planFromEstimate(state, job({ expectedCrew: 2 }), estimate({ expectedCrew: 3 })).expectedCrew).toBe(2);
  });
  it("puts named crew on a job with a day, minus anyone off or unavailable", () => {
    const busy = {
      crew,
      timeOff: [{ id: "t", crewId: "jose", startDate: "2026-11-19", endDate: "2026-11-21", status: "approved" }],
      unavailability: [{ id: "u", crewId: "luis", startDate: "2026-11-20", endDate: "2026-11-20" }],
    } as unknown as AppState;
    const plan = planFromEstimate(busy, job(), estimate({ expectedCrewIds: ["mike", "jose", "luis", "gone"] }));
    expect(plan.crewIds).toEqual(["mike"]);
    expect(plan.skipped).toEqual(["Jose", "Luis"]);
  });
  it("leaves people who are no longer active off", () => {
    const left = { crew: [person("mike", "Mike", "Climber", { status: "revoked" })], timeOff: [], unavailability: [] };
    const plan = planFromEstimate(left as unknown as AppState, job(), estimate({ expectedCrewIds: ["mike"] }));
    expect(plan.crewIds).toEqual([]);
    expect(plan.skipped).toEqual(["Mike"]);
  });
  it("puts no named crew on a job without a day", () => {
    const plan = planFromEstimate(state, job({ date: "" }), estimate({ expectedCrewIds: ["mike"] }));
    expect(plan.crewIds).toEqual([]);
  });
  it("keeps people already on the job", () => {
    const plan = planFromEstimate(state, job({ crewIds: ["jose"] }), estimate({ expectedCrewIds: ["mike", "jose"] }));
    expect(plan.crewIds).toEqual(["jose", "mike"]);
  });
});

describe("the estimate's counts are the job's crew requirement", () => {
  it("reads the counts", () => {
    expect(estimateCrewNeed(estimate({ expectedClimbers: 1, expectedGroundsmen: 2 }))).toEqual({
      climbers: 1,
      groundsmen: 2,
    });
    expect(estimateCrewNeed(estimate())).toBeNull();
    expect(estimateCrewNeed(null)).toBeNull();
  });
  it("replaces the crew rules for a job made from that estimate", () => {
    const s = seedState();
    const est = estimate({ id: "e-x", expectedClimbers: 2, expectedGroundsmen: 3 });
    const st: AppState = { ...s, estimates: [...s.estimates, est] };
    const j = job({ id: "j-x", estimateId: "e-x", date: "2030-01-07" });
    const need = requiredCrew(st, j, j.date);
    expect(need).toMatchObject({ climbers: 2, groundsmen: 3, allAvailable: false, fromEstimate: true });
    expect(suggestCrew({ ...st, jobs: [...st.jobs, j] }, j, j.date).reasons[0]).toBe(
      "From the estimate: 2 climbers + 3 groundsmen.",
    );
  });
  it("falls back to the rules when the estimate has no counts", () => {
    const s = seedState();
    const est = estimate({ id: "e-y", expectedCrew: 3 });
    const st: AppState = { ...s, estimates: [...s.estimates, est] };
    const need = requiredCrew(st, job({ estimateId: "e-y" }), "2030-01-07");
    expect(need.fromEstimate).toBeUndefined();
  });
});

describe("never shown to the customer", () => {
  const est = estimate({
    equipmentIds: ["chiptruck", "chipper"],
    expectedCrewIds: ["mike"],
    expectedClimbers: 1,
    expectedGroundsmen: 2,
    expectedCrew: 1,
  });
  const customer = { id: "c1", firstName: "Dana", lastName: "T", email: "dana@example.com" } as Customer;

  it("the customer copy has none of the new fields", () => {
    const copy = JSON.stringify(estimateForCustomer(est));
    for (const k of ["equipment", "chiptruck", "chipper", "mike", "climber", "groundsm", "expected"]) {
      expect(copy.toLowerCase()).not.toContain(k);
    }
  });
  it("the emails have none of them", () => {
    const bodies = [
      estimateEmailPreview(est, customer, { name: "Co", phone: "", email: "" }).body,
      estimateEmail(est, customer, "t1", "Co").body,
    ];
    for (const b of bodies) {
      for (const k of ["chiptruck", "chipper", "mike", "climber", "groundsm"]) {
        expect(b.toLowerCase()).not.toContain(k);
      }
    }
  });
});
