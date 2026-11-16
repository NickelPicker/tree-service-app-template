/**
 * Regression tests for defects found in review of the day planner engine.
 */
import { describe, expect, it } from "vitest";
import type { AppState, Job } from "../../types";
import { buildPlannerInput } from "../input";
import { planDay } from "../plan";
import type { PlanMode } from "../types";
import { validatePlan } from "../validate";
import {
  BASIC_RULES,
  DATE,
  MONDAY,
  TUESDAY,
  YARD,
  baseState,
  codes,
  driver,
  equip,
  flagsFor,
  job,
  person,
  run,
} from "./fixtures";

const far = (dLat: number, dLng: number) => ({ lat: YARD.lat + dLat, lng: YARD.lng + dLng });
const go = (state: AppState, mode: PlanMode = "keep") => {
  const input = buildPlannerInput(state, DATE, { yard: YARD, mode });
  const plan = planDay(input);
  return { input, plan, problems: validatePlan(input, plan) };
};

describe("rig choice", () => {
  it("picks the light chipper when the heavy one would need a CDL", () => {
    const state = baseState({
      crew: [driver("d", ["climbing", "chipper"]), person("g", ["ground_work"])],
      jobs: [job("j", { serviceType: "Trimming" })],
      equipment: [
        equip("truck-a", "Truck", { weightLbs: 8000 }),
        equip("chip-a", "Chipper", { weightLbs: 20000 }),
        equip("chip-b", "Chipper", { weightLbs: 2000 }),
      ],
    });
    const { plan } = run(state);
    expect(codes(plan)).not.toContain("NO_LEGAL_DRIVER");
    expect(plan.crews[0].rigs).toEqual([{ truckId: "truck-a", haulId: "chip-b", carriedIds: [] }]);
  });

  it("truck choice in crew 1 does not strand crew 2's chipper", () => {
    const state = baseState({
      crew: [
        driver("d1", ["climbing", "chipper"]),
        person("g1", ["ground_work"]),
        driver("d2", ["climbing", "chipper"]),
        person("g2", ["ground_work"]),
      ],
      jobs: [
        job("big", { serviceType: "Trimming", value: 5000, estimatedHours: 6, startTime: "", ...far(0.2, 0) }),
        job("small", { serviceType: "Trimming", value: 1000, estimatedHours: 6, startTime: "", ...far(-0.2, 0) }),
      ],
      equipment: [
        equip("truck-a", "Truck"),
        equip("truck-b", "Truck", { tows: ["chip-a"] }),
        equip("chip-a", "Chipper"),
        equip("chip-b", "Chipper"),
      ],
    });
    const { plan } = run(state);
    expect(plan.notPlaced).toEqual([]);
    expect(codes(plan)).not.toContain("NO_RIG");
    expect(codes(plan)).not.toContain("NO_LEGAL_DRIVER");
    expect(plan.crews.length).toBe(2);
    expect(plan.crews.every((c) => c.rigs.length === 1)).toBe(true);
  });

  it("CDL A combination weight counts the carried machine", () => {
    const state = baseState({
      crew: [driver("p1", ["climbing", "mini_skid"]), person("p2", ["ground_work"])],
      equipment: [
        equip("truck-a", "Truck", { weightLbs: 14000 }),
        equip("eqtrailer", "Equipment trailer", { weightLbs: 4000 }),
        equip("skid", "Mini skid", { weightLbs: 9000 }),
      ],
      jobs: [job("j", { equipmentIds: ["skid"] })],
    });
    const { plan, problems } = go(state, "replan");
    expect(problems).toEqual([]);
    expect(plan.crews.flatMap((c) => c.rigs).some((r) => r.carriedIds.includes("skid"))).toBe(false);
    expect(codes(plan)).toContain("NO_LEGAL_DRIVER");
  });
});

describe("score order", () => {
  it("a Big Truck extra drive is softer than the cluster cap and drive minutes", () => {
    const droveBigTruck = (who: string, date: string, id: string): Job =>
      job(id, { date, status: "done", crewIds: [who], equipmentIds: ["bigtruck", "chip-1"], equipmentDrivers: { bigtruck: who } });
    const state = baseState({
      crew: [
        driver("d1", ["climbing", "chipper"]),
        person("g1", ["ground_work"]),
        driver("d2", ["climbing", "chipper"]),
        person("g2", ["ground_work"]),
      ],
      jobs: [
        job("north", { serviceType: "Trimming", value: 2000, startTime: "", ...far(0.3, 0) }),
        job("south", { serviceType: "Trimming", value: 1000, startTime: "", ...far(-0.3, 0) }),
        droveBigTruck("d1", MONDAY, "m1"),
        droveBigTruck("d2", TUESDAY, "m2"),
      ],
      equipment: [
        equip("bigtruck", "Truck", { weeklyDriverLimit: 1 }),
        equip("truck-b", "Truck"),
        equip("chip-1", "Chipper"),
        equip("chip-2", "Chipper"),
      ],
    });
    const { plan } = run(state);
    expect(plan.crews.length).toBe(2);
    expect(codes(plan)).not.toContain("OVER_CLUSTER_CAP");
    expect(codes(plan)).toContain("VEHICLE_EXTRA_DRIVE");
  });
});

describe("last resort", () => {
  it("LAST_RESORT_USED names only the need Jordan really fills", () => {
    const state = baseState({
      crew: [
        person("john", ["climbing"], { lastResort: true, driverLicensed: true, companyInsured: true }),
        driver("g", ["chipper", "cleanup", "ground_work"]),
      ],
      jobs: [job("j", { serviceType: "Trimming" })],
      equipment: [equip("truck-a", "Truck"), equip("chipper", "Chipper")],
    });
    const { plan } = run(state);
    expect(plan.crews[0].memberIds).toEqual(["g", "john"]);
    expect(plan.crews[0].drivers["truck-a"]).toBe("g");
    const f = flagsFor(plan, "LAST_RESORT_USED");
    expect(f.length).toBe(1);
    expect(f[0].text).not.toContain("driver");
  });
});

describe("driver locks", () => {
  it("a locked driver for truck-b is kept", () => {
    const state = baseState({
      crew: [driver("p1", ["climbing"]), driver("p2", ["ground_work"])],
      equipment: [
        equip("truck-a", "Truck"),
        equip("truck-b", "Truck", { tows: ["chipper"] }),
        equip("chipper", "Chipper"),
        equip("dump", "Dump trailer"),
      ],
      jobs: [
        job("j", {
          serviceType: "Removal",
          crewIds: ["p1", "p2"],
          equipmentIds: ["truck-a", "truck-b", "chipper", "dump"],
          equipmentDrivers: { "truck-b": "p1" },
        }),
      ],
    });
    const { plan, problems } = go(state);
    expect(problems).toEqual([]);
    expect(plan.crews[0].drivers["truck-b"]).toBe("p1");
    expect(plan.crews[0].drivers["truck-a"]).toBe("p2");
  });

  it("a locked driver lacking CDL A does not block the CDL driver", () => {
    const state = baseState({
      crew: [driver("p1", ["climbing"]), driver("p2", ["ground_work"], { cdlClass: "A" })],
      equipment: [equip("truck-a", "Truck", { weightLbs: 18000 }), equip("chipper", "Chipper", { weightLbs: 10000 })],
      jobs: [
        job("j", { crewIds: ["p1", "p2"], equipmentIds: ["truck-a", "chipper"], equipmentDrivers: { "truck-a": "p1" } }),
      ],
    });
    const { plan, problems } = go(state);
    expect(problems).toEqual([]);
    expect(plan.crews[0].rigs.map((r) => r.truckId)).toEqual(["truck-a"]);
    expect(plan.crews[0].drivers["truck-a"]).toBe("p2");
    expect(flagsFor(plan, "LOCK_CONFLICT").some((f) => f.personId === "p1")).toBe(true);
  });

  it("a locked driver on time off (not in crewIds) is flagged", () => {
    const state = baseState({
      crew: [driver("dr", ["ground_work"]), driver("c", ["climbing", "chipper"]), person("g", ["ground_work"])],
      jobs: [job("j", { equipmentIds: ["t1", "ch"], equipmentDrivers: { t1: "dr" } })],
      equipment: [equip("t1", "Truck"), equip("ch", "Chipper")],
      timeOff: [{ id: "to", crewId: "dr", startDate: DATE, endDate: DATE, status: "approved", reason: "" }] as never,
    });
    const { input, plan } = go(state);
    expect(input.off.map((o) => o.crewId)).toContain("dr");
    expect(plan.flags.some((f) => f.code === "LOCK_CONFLICT" && f.personId === "dr")).toBe(true);
  });
});

describe("weekly limits", () => {
  it("a limited chipper's drives count when other days name only the truck's driver", () => {
    const state = baseState({
      crew: [driver("p1", ["climbing", "chipper"]), person("p2", ["ground_work"])],
      equipment: [equip("truck-a", "Truck"), equip("chipper", "Chipper", { weeklyDriverLimit: 1 })],
      jobs: [
        job("j", { serviceType: "Trimming" }),
        job("mon", { date: MONDAY, status: "done", crewIds: ["p1"], equipmentIds: ["truck-a", "chipper"], equipmentDrivers: { "truck-a": "p1" } }),
        job("tue", { date: TUESDAY, status: "done", crewIds: ["p1"], equipmentIds: ["truck-a", "chipper"], equipmentDrivers: { "truck-a": "p1" } }),
      ],
    });
    const { plan, problems } = go(state, "replan");
    expect(problems).toEqual([]);
    expect(plan.crews.flatMap((c) => c.rigs).some((r) => r.haulId === "chipper")).toBe(false);
  });
});

describe("seats", () => {
  it("locked people over the truck's seats get a flag and pass the self-check", () => {
    const state = baseState({
      crew: [driver("p1", ["climbing"]), person("p2", ["ground_work"]), person("p3", ["ground_work"])],
      equipment: [equip("truck-a", "Truck", { seats: 2 }), equip("chipper", "Chipper")],
      jobs: [job("j", { crewIds: ["p1", "p2", "p3"], equipmentIds: ["truck-a", "chipper"] })],
    });
    const { plan, problems } = go(state);
    expect(problems).toEqual([]);
    expect(codes(plan)).not.toContain("PLAN_CHECK_FAILED");
    expect(codes(plan)).toContain("SEATS_SHORT");
  });
});

describe("equipment locked to another crew", () => {
  it("a locked chipper on a lower-value job is not also given to another crew", () => {
    const state = baseState({
      crew: [
        driver("c1", ["climbing", "chipper"]),
        person("g1", ["ground_work"]),
        driver("c2", ["climbing", "chipper"]),
        person("g2", ["ground_work"]),
      ],
      jobs: [
        job("big", { value: 5000, ...far(0.3, 0) }),
        job("small", { value: 500, equipmentIds: ["chipper-x"], ...far(-0.3, 0) }),
      ],
      equipment: [equip("truck-a", "Truck"), equip("truck-b", "Truck"), equip("chipper-x", "Chipper")],
    });
    const { plan, problems } = go(state);
    expect(problems).toEqual([]);
    expect(plan.crews.flatMap((c) => c.rigs.map((r) => r.haulId)).filter((x) => x === "chipper-x").length).toBeLessThanOrEqual(1);
  });

  it("a locked truck on a lower-value job is not also given to another crew", () => {
    const state = baseState({
      crew: [
        driver("c1", ["climbing", "chipper"]),
        person("g1", ["ground_work"]),
        driver("c2", ["climbing", "chipper"]),
        person("g2", ["ground_work"]),
      ],
      jobs: [
        job("big", { value: 5000, ...far(0.3, 0) }),
        job("small", { value: 500, equipmentIds: ["truck-a", "chipper-y"], ...far(-0.3, 0) }),
      ],
      equipment: [
        equip("truck-a", "Truck"),
        equip("chipper-x", "Chipper"),
        equip("chipper-y", "Chipper"),
        equip("truck-z", "Truck", { down: true }),
      ],
    });
    const { plan, problems } = go(state);
    expect(problems).toEqual([]);
    expect(plan.crews.flatMap((c) => c.rigs.map((r) => r.truckId)).filter((x) => x === "truck-a").length).toBeLessThanOrEqual(1);
  });
});

describe("gaps always flagged", () => {
  it("jobs on a closed day are accounted for", () => {
    const state = baseState({
      crew: [person("c", ["climbing"]), person("g", ["ground_work"])],
      jobs: [job("j1", { serviceType: "Plant Health Care" })],
      closedDays: [{ id: "cd", date: DATE, label: "Holiday" }] as never,
    });
    const { input, plan, problems } = go(state);
    expect(input.closed).toBe(true);
    expect(problems).toEqual([]);
    expect(plan.notPlaced.map((n) => n.jobId)).toEqual(["j1"]);
  });

  it("no crew goes out empty on 'everyone available' jobs with 0/0 minimums", () => {
    const state = baseState({
      crew: [person("a", ["climbing"]), person("b", ["ground_work"]), person("c", ["ground_work"])],
      jobs: [
        job("x", { serviceType: "Plant Health Care", ...far(0.4, 0) }),
        job("y", { serviceType: "Plant Health Care", ...far(-0.4, 0) }),
      ],
    });
    state.settings.crewRules = [{ ...BASIC_RULES[0], climbers: 0, groundsmen: 0, allAvailable: true }];
    const { plan, problems } = go(state);
    expect(problems).toEqual([]);
    for (const c of plan.crews) expect(c.memberIds.length).toBeGreaterThan(0);
  });
});

describe("performance", () => {
  it("15 jobs x 15 people x 9 equipment plans within 2 s", () => {
    const crew = Array.from({ length: 15 }, (_, i) => {
      const id = `p${String(i).padStart(2, "0")}`;
      return i % 3 === 0
        ? driver(id, ["climbing", "ground_work", "chipper", "stump_grinding"])
        : person(id, i % 3 === 1 ? ["climbing"] : ["ground_work"]);
    });
    const jobs = Array.from({ length: 15 }, (_, i) =>
      job(`j${String(i).padStart(2, "0")}`, {
        value: 500 + i * 37,
        estimatedHours: 1,
        serviceType: i % 3 === 0 ? "Removal" : i % 3 === 1 ? "Trimming" : "Stump Grinding",
        ...far((i % 5) * 0.03, Math.floor(i / 5) * 0.2),
      }),
    );
    const equipment = [
      equip("t1", "Truck"),
      equip("t2", "Truck"),
      equip("t3", "Truck"),
      equip("t4", "Truck"),
      equip("ch1", "Chipper"),
      equip("ch2", "Chipper"),
      equip("d1", "Dump trailer"),
      equip("e1", "Equipment trailer"),
      equip("sg", "Stump grinder"),
    ];
    const t0 = performance.now();
    const { plan, problems } = go(baseState({ crew, jobs, equipment }));
    const ms = performance.now() - t0;
    expect(problems).toEqual([]);
    expect(plan.stats.evaluations).toBeLessThanOrEqual(plan.stats.budget);
    expect(ms).toBeLessThan(2000);
  });
});

// Owner browser test, 2026-11-14: after a plan was accepted (keep mode,
// everything locked), the planner merged every job into the one crew
// holding the only chipper, running until about 22:00. An impossible
// day must lose to a missing machine.
describe("keep mode never builds an impossible day", () => {
  it("leaves locked crews apart rather than run hours past day end", async () => {
    const f = await import("./fixtures");
    const state = f.baseState({
      crew: [
        f.driver("a", ["climbing"]),
        f.person("b", ["ground_work", "chipper"]),
        f.driver("c", ["climbing"]),
        f.person("d", ["ground_work", "chipper"]),
      ],
      equipment: [f.equip("t1", "Truck"), f.equip("ch", "Chipper")],
      jobs: [
        f.job("lk1", { serviceType: "Removal", estimatedHours: 6, lat: 39.9, lng: -104.98, crewIds: ["a", "b"], equipmentIds: ["t1", "ch"], equipmentDrivers: { t1: "a", ch: "a" } }),
        f.job("lk2", { serviceType: "Removal", estimatedHours: 6, lat: 39.5, lng: -105.05, crewIds: ["c", "d"] }),
      ],
    });
    const plan = planDay(buildPlannerInput(state, f.DATE, { mode: "keep", today: f.DATE, yard: f.YARD }));
    const lastEnd = Math.max(...plan.crews.flatMap((c) => c.stops.map((st) => st.endMin)));
    expect(plan.crews.length).toBe(2);
    expect(lastEnd).toBeLessThanOrEqual(17 * 60 + 30);
    expect(plan.flags.some((fl) => fl.severity === "red" && fl.jobId === "lk2")).toBe(true);
  });
});

// Owner browser test, 2026-11-14: re-planning an accepted day in keep
// mode re-paired the trucks and trailers (the chipper changed driver).
describe("keep mode keeps the accepted truck + trailer pairing", () => {
  it("does not swap which truck tows the chipper", async () => {
    const f = await import("./fixtures");
    const state = f.baseState({
      crew: [f.driver("a", ["climbing", "ground_work"]), f.driver("b", ["ground_work", "chipper"])],
      equipment: [f.equip("ram", "Truck"), f.equip("ford", "Truck"), f.equip("ch", "Chipper"), f.equip("dt", "Dump trailer")],
      jobs: [
        f.job("j1", {
          serviceType: "Removal",
          lat: 39.8,
          lng: -105.0,
          crewIds: ["a", "b"],
          equipmentIds: ["ram", "ford", "ch", "dt"],
          equipmentDrivers: { ram: "b", ch: "b", ford: "a", dt: "a" },
        }),
      ],
    });
    const plan = planDay(buildPlannerInput(state, f.DATE, { mode: "keep", today: f.DATE, yard: f.YARD }));
    const rigs = plan.crews[0].rigs.map((r) => `${r.truckId}+${r.haulId}`).sort();
    expect(rigs).toEqual(["ford+dt", "ram+ch"]);
  });
});

// Owner decision: extra people go to the biggest jobs (up to
// a largest-crew setting when Pat set no expected crew).
describe("extras go to the biggest job", () => {
  it("adds a spare groundsman to the higher-value crew, not home", async () => {
    const f = await import("./fixtures");
    const state = f.baseState({
      crew: [
        f.driver("c1", ["climbing"]),
        f.person("g1", ["ground_work", "chipper"]),
        f.driver("c2", ["climbing"]),
        f.person("g2", ["ground_work", "chipper"]),
        f.person("g3", ["ground_work"]),
      ],
      equipment: [f.equip("t1", "Truck"), f.equip("t2", "Truck"), f.equip("ch1", "Chipper"), f.equip("ch2", "Chipper")],
      jobs: [
        f.job("big", { value: 5000 - 1, lat: 39.9, lng: -104.98 }),
        f.job("small", { value: 500, lat: 39.5, lng: -105.05 }),
      ],
    });
    const plan = planDay(buildPlannerInput(state, f.DATE, { mode: "replan", today: f.DATE, yard: f.YARD }));
    const crewOf = (jobId: string) => plan.crews.find((c) => c.stops.some((st) => st.jobId === jobId));
    expect(plan.crews.length).toBe(2);
    expect(crewOf("big")?.memberIds).toContain("g3");
    expect(plan.spare.map((x) => x.crewId)).not.toContain("g3");
  });
});
