import { describe, expect, it } from "vitest";
import type { CrewMember, Equipment, Job } from "../../types";
import { buildPlannerInput } from "../input";
import { planToJobPatches } from "../patches";
import { planDay } from "../plan";
import {
  BASIC_RULES,
  DATE,
  MONDAY,
  TUESDAY,
  YARD,
  baseState,
  codes,
  crewOf,
  driver,
  equip,
  flagsFor,
  fleet,
  job,
  person,
  run,
} from "./fixtures";

const far = (dLat: number, dLng: number) => ({ lat: YARD.lat + dLat, lng: YARD.lng + dLng });

describe("priority order", () => {
  it("a skill beats driving: the one pruner's two far-apart jobs share a crew", () => {
    const crew = [
      person("p", ["climbing", "pruning"]),
      person("c2", ["climbing"]),
      person("g1", ["ground_work"]),
      person("g2", ["ground_work"]),
    ];
    const jobs = [
      job("near", { serviceType: "Plant Health Care", pruneClass: "2", ...far(0.01, 0.01) }),
      job("far", { serviceType: "Plant Health Care", pruneClass: "2", ...far(0.3, 0.01) }),
    ];
    const { plan } = run(baseState({ crew, jobs }));
    expect(codes(plan)).not.toContain("UNFILLED_SKILL");
    expect(crewOf(plan, "near")?.key).toBe(crewOf(plan, "far")?.key);
    expect(crewOf(plan, "near")?.memberIds).toContain("p");
    expect(codes(plan)).toContain("OVER_CLUSTER_CAP");

    // Without the pruning need, the same two jobs split into two crews (less driving).
    const plain = jobs.map((j) => ({ ...j, pruneClass: null }));
    const { plan: split } = run(baseState({ crew, jobs: plain }));
    expect(split.crews.length).toBe(2);
    expect(codes(split)).not.toContain("OVER_CLUSTER_CAP");
  });

  it("a driver beats headcount: under a cap of 3 the crew takes the driver over a third groundsman", () => {
    const state = baseState({
      crew: [
        person("c", ["climbing", "chipper"]),
        person("g1", ["ground_work"]),
        person("g2", ["ground_work"]),
        driver("dr", ["cleanup"]),
      ],
      jobs: [job("j", { serviceType: "Trimming", expectedCrew: 3 })],
      equipment: [equip("truck-a", "Truck"), equip("chipper", "Chipper")],
    });
    state.settings.crewRules = [{ ...BASIC_RULES[0], groundsmen: 2 }];
    const { plan } = run(state);
    const c = plan.crews[0];
    expect(c.memberIds).toContain("dr");
    expect(c.memberIds).toContain("c");
    expect(c.memberIds.length).toBe(3);
    expect(c.rigs).toEqual([{ truckId: "truck-a", haulId: "chipper", carriedIds: [] }]);
    expect(c.drivers["truck-a"]).toBe("dr");
    expect(flagsFor(plan, "SHORT_HANDED").map((f) => f.jobId)).toEqual(["j"]);
    expect(codes(plan)).not.toContain("NO_LEGAL_DRIVER");
  });

  it("the most valuable job is staffed first when short-handed", () => {
    const state = baseState({
      crew: [person("c", ["climbing"]), person("g", ["ground_work"])],
      jobs: [
        job("small", { serviceType: "Plant Health Care", value: 400, ...far(0.3, 0) }),
        job("big", { serviceType: "Plant Health Care", value: 4000, ...far(-0.3, 0) }),
      ],
    });
    state.settings.planner = { maxCrews: 2, overrunToleranceMin: 0, dayEnd: "09:30" };
    const { plan } = run(state);
    // The day is too short for both: the big job keeps its crew.
    expect(crewOf(plan, "big")?.memberIds).toEqual(["c", "g"]);
    expect(plan.notPlaced.map((n) => n.jobId)).toEqual(["small"]);
    expect(codes(plan)).toContain("DOES_NOT_FIT_DAY");
  });
});

describe("people", () => {
  const john = (over: Partial<CrewMember> = {}) =>
    person("john", ["climbing", "ground_work"], { lastResort: true, ...over });

  it("the last-resort person stays home when everyone needed is there, even with room under the cap", () => {
    const { plan } = run(
      baseState({
        crew: [person("c", ["climbing"]), person("g", ["ground_work"]), john()],
        jobs: [job("j", { serviceType: "Plant Health Care", expectedCrew: 4 })],
      }),
    );
    expect(plan.crews[0].memberIds).toEqual(["c", "g"]);
    expect(plan.spare.map((s) => s.crewId)).toEqual(["john"]);
    expect(codes(plan)).not.toContain("LAST_RESORT_USED");
  });

  it("the last-resort person comes in only to fill a need nobody else can, and the flag names it", () => {
    const { plan } = run(
      baseState({
        crew: [person("g", ["ground_work"]), person("g2", ["ground_work"]), john()],
        jobs: [job("j", { serviceType: "Plant Health Care" })],
      }),
    );
    expect(plan.crews[0].memberIds).toContain("john");
    const f = flagsFor(plan, "LAST_RESORT_USED");
    expect(f.length).toBe(1);
    expect(f[0].personId).toBe("john");
    expect(f[0].text).toContain("a climber");
    expect(codes(plan)).not.toContain("SHORT_HANDED");
  });

  it("the expected-crew cap is never exceeded", () => {
    const state = baseState({
      crew: [
        person("c1", ["climbing"]),
        person("c2", ["climbing"]),
        person("g1", ["ground_work"]),
        person("g2", ["ground_work"]),
        person("g3", ["ground_work"]),
      ],
      jobs: [job("j", { serviceType: "Plant Health Care", expectedCrew: 2 })],
    });
    state.settings.crewRules = [{ ...BASIC_RULES[0], climbers: 2, groundsmen: 2 }];
    const { plan } = run(state);
    expect(plan.crews[0].memberIds.length).toBe(2);
    expect(codes(plan)).toContain("CAPPED_BY_EXPECTED_CREW");
    expect(codes(plan)).toContain("SHORT_HANDED");
    expect(plan.spare.length).toBe(3);
  });

  it("extras fill the most valuable crew up to its cap; the rest are not needed today", () => {
    const crew = ["a", "b", "c", "d", "e", "f"].map((id, i) =>
      person(id, i < 2 ? ["climbing"] : ["ground_work"]),
    );
    const { plan } = run(
      baseState({ crew, jobs: [job("j", { serviceType: "Plant Health Care", expectedCrew: 4 })] }),
    );
    expect(plan.crews[0].memberIds.length).toBe(4);
    expect(plan.spare.length).toBe(2);
    expect(flagsFor(plan, "NOT_NEEDED_TODAY").length).toBe(2);
  });

  it("people on time off are off, and skills fall back to the job role (flagged)", () => {
    const state = baseState({
      crew: [
        person("c", [], { role: "Climber" }),
        person("g", [], { role: "Groundsman" }),
        person("away", ["climbing"]),
      ],
      jobs: [job("j", { serviceType: "Plant Health Care" })],
      timeOff: [
        { id: "t1", crewId: "away", startDate: DATE, endDate: DATE, reason: "", status: "approved", requestedAt: DATE, decidedBy: null, decidedAt: null },
      ],
    });
    const { plan } = run(state);
    expect(plan.crews[0].memberIds).toEqual(["c", "g"]);
    expect(plan.off.map((o) => o.crewId)).toEqual(["away"]);
    expect(flagsFor(plan, "SKILLS_FROM_ROLE").length).toBe(2);
  });
});

describe("equipment and drivers", () => {
  const climberDriver = () => driver("d", ["climbing", "chipper"]);
  const ground = () => person("g", ["ground_work"]);

  it("down equipment is never used", () => {
    const state = baseState({
      crew: [climberDriver(), ground()],
      jobs: [job("j", { serviceType: "Trimming" })],
      equipment: [equip("truck-a", "Truck"), equip("chipper-1", "Chipper", { down: true }), equip("chipper-2", "Chipper")],
    });
    const { plan } = run(state);
    expect(plan.crews[0].rigs[0].haulId).toBe("chipper-2");

    state.equipment = [equip("truck-a", "Truck"), equip("chipper-1", "Chipper", { down: true })];
    const { plan: none } = run(state);
    expect(none.crews[0].rigs).toEqual([]);
    expect(flagsFor(none, "NO_RIG").map((f) => f.jobId)).toEqual(["j"]);

    // A down chipper locked on the job by hand is flagged and still not used.
    state.jobs = [job("j", { serviceType: "Trimming", equipmentIds: ["truck-a", "chipper-1"] })];
    const { plan: locked } = run(state, { mode: "keep" });
    expect(codes(locked)).toContain("LOCKED_ITEM_DOWN");
    expect(locked.crews[0].rigs.flatMap((r) => [r.truckId, r.haulId])).not.toContain("chipper-1");
  });

  it("a truck never goes out without its haul unit", () => {
    const state = baseState({
      crew: [driver("d", ["climbing"]), ground()],
      jobs: [job("j", { serviceType: "Plant Health Care", equipmentIds: ["truck-a"] })],
      equipment: [equip("truck-a", "Truck"), equip("trailer", "Equipment trailer")],
    });
    const { plan } = run(state, { mode: "replan" });
    expect(plan.crews[0].rigs).toEqual([{ truckId: "truck-a", haulId: "trailer", carriedIds: [] }]);

    state.equipment = [equip("truck-a", "Truck")];
    const { plan: alone } = run(state, { mode: "replan" });
    expect(alone.crews[0].rigs).toEqual([]);
    expect(codes(alone)).toContain("NO_RIG");
  });

  it("a mini skid rides on a dump trailer or an equipment trailer", () => {
    const state = baseState({
      crew: [driver("d", ["climbing", "mini_skid"]), ground()],
      jobs: [job("j", { serviceType: "Plant Health Care", equipmentIds: ["skid"] })],
      equipment: [equip("truck-a", "Truck"), equip("skid", "Mini skid"), equip("chipper", "Chipper"), equip("eqtrailer", "Equipment trailer")],
    });
    const { plan } = run(state, { mode: "replan" });
    expect(plan.crews[0].rigs).toEqual([{ truckId: "truck-a", haulId: "eqtrailer", carriedIds: ["skid"] }]);
  });

  it("chipper + dump trailer → two trucks and two different legal drivers", () => {
    const state = baseState({
      crew: [driver("d1", ["climbing", "chipper"]), driver("d2", ["ground_work"]), person("g", ["ground_work"])],
      jobs: [job("j", { serviceType: "Removal" })],
      equipment: fleet(),
    });
    const { plan } = run(state);
    const c = plan.crews[0];
    expect(c.rigs.map((r) => r.haulId).sort()).toEqual(["chipper", "dump"]);
    expect(new Set(c.rigs.map((r) => r.truckId)).size).toBe(2);
    expect(new Set(Object.values(c.drivers))).toEqual(new Set(["d1", "d2"]));
    expect(codes(plan)).not.toContain("NO_LEGAL_DRIVER");

    // With only one legal driver, one unit stays home and is flagged.
    state.crew = [driver("d1", ["climbing", "chipper"]), person("d2", ["ground_work"]), person("g", ["ground_work"])];
    const { plan: one } = run(state);
    expect(one.crews[0].rigs.length).toBe(1);
    expect(flagsFor(one, "NO_LEGAL_DRIVER").length).toBe(1);
  });

  describe("weekly vehicle limit (Big Truck = 1)", () => {
    const fleetWithBigTruck = (): Equipment[] => [
      equip("bigtruck", "Truck", { weeklyDriverLimit: 1, tows: ["chipper"] }),
      equip("truck-b", "Truck", { tows: ["dump"] }),
      equip("chipper", "Chipper"),
      equip("dump", "Dump trailer"),
    ];
    const droveBigTruck = (who: string, date: string): Job =>
      job(`bigtruck-${date}`, { date, status: "done", crewIds: [who], equipmentIds: ["bigtruck", "chipper"], equipmentDrivers: { bigtruck: who } });

    it("a second drive in the week is allowed only when nobody else can, and flagged", () => {
      const state = baseState({
        crew: [driver("d1", ["climbing", "chipper"]), person("g", ["ground_work"])],
        jobs: [job("j", { serviceType: "Trimming" }), droveBigTruck("d1", MONDAY)],
        equipment: fleetWithBigTruck(),
      });
      const { plan } = run(state);
      expect(plan.crews[0].drivers.bigtruck).toBe("d1");
      const f = flagsFor(plan, "VEHICLE_EXTRA_DRIVE");
      expect(f.map((x) => [x.personId, x.equipmentId])).toEqual([["d1", "bigtruck"]]);

      // Someone fresh drives it instead, with no flag.
      state.crew = [...state.crew, driver("d2", ["ground_work"])];
      const { plan: fresh } = run(state);
      expect(fresh.crews[0].drivers.bigtruck).toBe("d2");
      expect(codes(fresh)).not.toContain("VEHICLE_EXTRA_DRIVE");
    });

    it("a third drive is refused", () => {
      const state = baseState({
        crew: [driver("d1", ["climbing", "chipper"]), person("g", ["ground_work"])],
        jobs: [job("j", { serviceType: "Trimming" }), droveBigTruck("d1", MONDAY), droveBigTruck("d1", TUESDAY)],
        equipment: fleetWithBigTruck(),
      });
      const { plan } = run(state);
      expect(plan.crews[0].rigs).toEqual([]);
      expect(flagsFor(plan, "NO_LEGAL_DRIVER").map((f) => f.jobId)).toEqual(["j"]);
    });
  });

  it("illegal drivers never drive (licence and insurance both needed; the can-drive list is respected)", () => {
    const state = baseState({
      crew: [
        person("lic", ["climbing", "chipper"], { driverLicensed: true }),
        person("ins", ["ground_work"], { companyInsured: true }),
      ],
      jobs: [job("j", { serviceType: "Trimming" })],
      equipment: [equip("truck-a", "Truck"), equip("chipper", "Chipper")],
    });
    const { plan } = run(state);
    expect(plan.crews[0].rigs).toEqual([]);
    expect(codes(plan)).toContain("NO_LEGAL_DRIVER");

    state.crew = [driver("d", ["climbing", "chipper"], { canDriveEquipment: ["truck-b"] }), person("g", ["ground_work"])];
    const { plan: listed } = run(state);
    expect(listed.crews[0].rigs).toEqual([]);
  });

  it("a combination over 26,001 lb needs a CDL Class A driver", () => {
    const heavy = [equip("truck-a", "Truck", { weightLbs: 15000 }), equip("chipper", "Chipper", { weightLbs: 12000 })];
    const state = baseState({
      crew: [driver("d", ["climbing", "chipper"]), person("g", ["ground_work"])],
      jobs: [job("j", { serviceType: "Trimming" })],
      equipment: heavy,
    });
    const { plan } = run(state);
    expect(plan.crews[0].rigs).toEqual([]);
    expect(codes(plan)).toContain("NO_LEGAL_DRIVER");

    // A lighter truck works without a CDL.
    state.equipment = [...heavy, equip("truck-light", "Truck", { weightLbs: 9000 })];
    const { plan: light } = run(state);
    expect(light.crews[0].rigs[0].truckId).toBe("truck-light");

    // A Class A driver may take the heavy one.
    state.equipment = heavy;
    state.crew = [driver("d", ["climbing", "chipper"], { cdlClass: "A" }), person("g", ["ground_work"])];
    const { plan: cdl } = run(state);
    expect(cdl.crews[0].rigs[0].truckId).toBe("truck-a");
  });
});

describe("plan integrity", () => {
  it("every gap has a flag", () => {
    const state = baseState({
      crew: [person("c", ["climbing"]), driver("d", ["ground_work"])],
      jobs: [
        job("removal", { serviceType: "Removal", value: 5000, pruneClass: "2", estimatedHours: null }),
        job("stumps", { serviceType: "Stump Grinding", value: 800, ...far(0.2, 0.2) }),
        job("nowhere", { serviceType: "Plant Health Care", value: 300, lat: null, lng: null }),
      ],
      equipment: [equip("truck-a", "Truck"), equip("chipper", "Chipper")],
    });
    state.settings.crewRules = [{ ...BASIC_RULES[0], climbers: 1, groundsmen: 2 }];
    const { plan } = run(state); // run() asserts validatePlan finds nothing unflagged
    const c = new Set(codes(plan));
    for (const code of ["UNFILLED_SKILL", "SHORT_HANDED", "NO_RIG", "ASSUMED_HOURS", "NEEDS_GUESSED", "NO_LOCATION", "ESTIMATED_DRIVE"]) {
      expect(c.has(code), code).toBe(true);
    }
    for (const f of plan.flags) expect(["red", "amber", "info"]).toContain(f.severity);
  });

  it("the same input gives the same output, whatever order the data comes in", () => {
    const make = () =>
      baseState({
        crew: [
          driver("d1", ["climbing", "chipper"]),
          driver("d2", ["ground_work"]),
          person("c2", ["climbing", "pruning"]),
          person("g1", ["ground_work"]),
          person("g2", ["ground_work"]),
        ],
        jobs: [
          job("a", { serviceType: "Trimming", value: 1200 }),
          job("b", { serviceType: "Removal", value: 2500, ...far(0.05, 0.02) }),
          job("c", { serviceType: "Plant Health Care", value: 1200, pruneClass: "2", ...far(-0.2, 0.1) }),
        ],
        equipment: fleet(),
      });
    const first = run(make()).plan;
    const again = run(make()).plan;
    expect(again).toEqual(first);
    const shuffled = make();
    shuffled.crew.reverse();
    shuffled.jobs.reverse();
    shuffled.equipment.reverse();
    expect(run(shuffled).plan).toEqual(first);
    // The input is plain data: a JSON round trip plans the same.
    const input = buildPlannerInput(make(), DATE, { yard: YARD });
    expect(planDay(JSON.parse(JSON.stringify(input)))).toEqual(first);
  });

  it("keep mode keeps people, equipment and drivers already on the job; replan mode ignores them", () => {
    const state = baseState({
      crew: [
        driver("d1", ["climbing", "chipper"]),
        driver("d2", ["ground_work"]),
        person("g2", ["ground_work"], { availableWeekdays: [1] }),
        person("c3", ["climbing", "chipper"]),
      ],
      jobs: [
        job("j", {
          serviceType: "Trimming",
          crewIds: ["g2", "c3"],
          equipmentIds: ["truck-b", "chipper"],
          equipmentDrivers: { "truck-b": "d2" },
        }),
      ],
      equipment: fleet(),
    });
    const { plan } = run(state, { mode: "keep" });
    const c = plan.crews[0];
    expect(c.memberIds).toEqual(expect.arrayContaining(["g2", "c3", "d2"]));
    expect(c.rigs).toEqual([{ truckId: "truck-b", haulId: "chipper", carriedIds: [] }]);
    expect(c.drivers["truck-b"]).toBe("d2");
    expect(codes(plan)).toContain("OFF_USUAL_DAY"); // g2 kept although Wednesday is not their usual day

    const { plan: re } = run(state, { mode: "replan" });
    expect(re.crews[0].memberIds).not.toContain("g2");
  });

  it("two far-apart clusters get two crews, each driving less than one crew doing both", () => {
    const crew = [
      person("c1", ["climbing"]),
      person("c2", ["climbing"]),
      person("g1", ["ground_work"]),
      person("g2", ["ground_work"]),
    ];
    const jobs = [
      job("w1", { serviceType: "Plant Health Care", ...far(0, -0.25) }),
      job("w2", { serviceType: "Plant Health Care", ...far(0.01, -0.26) }),
      job("e1", { serviceType: "Plant Health Care", ...far(0, 0.25) }),
      job("e2", { serviceType: "Plant Health Care", ...far(0.01, 0.26) }),
    ];
    const { plan } = run(baseState({ crew, jobs }));
    expect(plan.crews.length).toBe(2);
    expect(crewOf(plan, "w1")?.key).toBe(crewOf(plan, "w2")?.key);
    expect(crewOf(plan, "e1")?.key).toBe(crewOf(plan, "e2")?.key);
    expect(crewOf(plan, "w1")?.key).not.toBe(crewOf(plan, "e1")?.key);

    const oneState = baseState({ crew, jobs });
    oneState.settings.planner = { maxCrews: 1 };
    const { plan: one } = run(oneState);
    expect(one.crews.length).toBe(1);
    for (const c of plan.crews) expect(c.driveMin).toBeLessThan(one.crews[0].driveMin);
    expect(codes(one)).toContain("OVER_CLUSTER_CAP");
    expect(codes(plan)).not.toContain("OVER_CLUSTER_CAP");
  });

  it("suggests start times from drive times and respects a typed time", () => {
    const { plan } = run(
      baseState({
        crew: [person("c", ["climbing"]), person("g", ["ground_work"])],
        jobs: [
          job("first", { serviceType: "Plant Health Care", value: 2000, estimatedHours: 1 }),
          job("set", { serviceType: "Plant Health Care", value: 1000, startTime: "13:00", estimatedHours: 1, ...far(0.02, 0.01) }),
        ],
      }),
    );
    const stops = plan.crews[0].stops;
    expect(stops.length).toBe(2);
    const set = stops.find((s) => s.jobId === "set")!;
    const other = stops.find((s) => s.jobId === "first")!;
    expect(set.startMin).toBe(13 * 60);
    expect(other.startMin % 15).toBe(0);
    // No waiting around for the set time: the crew does the other job after it.
    expect(plan.crews[0].idleMin).toBeLessThan(60);
  });

  it("planToJobPatches gives each job its crew, equipment, drivers and suggested time", () => {
    const state = baseState({
      crew: [driver("d1", ["climbing", "chipper"]), driver("d2", ["ground_work"])],
      jobs: [job("j", { serviceType: "Removal" })],
      equipment: fleet(),
    });
    const { plan } = run(state);
    const p = planToJobPatches(plan, state).j;
    expect(p.crewIds).toEqual(["d1", "d2"]);
    expect(p.equipmentIds.length).toBe(4);
    expect(Object.keys(p.equipmentDrivers).sort()).toEqual([...p.equipmentIds].sort());
    expect(p.suggestedStartTime).toMatch(/^\d\d:\d\d$/);
    expect(p.changed).toBe(true);
  });

  it("a closed day returns an empty plan", () => {
    const state = baseState({
      crew: [person("c", ["climbing"])],
      jobs: [job("j")],
      closedDays: [{ date: DATE, reason: "Holiday", createdBy: null }],
    });
    const plan = planDay(buildPlannerInput(state, DATE, { yard: YARD }));
    expect(plan.crews).toEqual([]);
    expect(codes(plan)).toEqual(["CLOSED_DAY", "CLOSED_DAY"]);
    expect(plan.notPlaced.map((n) => n.jobId)).toEqual(["j"]);
  });
});

describe("budget", () => {
  it("10 jobs × 13 people × 6 vehicles plans within the evaluation budget", () => {
    const crew: CrewMember[] = [
      driver("p01", ["climbing", "pruning", "chipper"]),
      driver("p02", ["climbing", "removals"]),
      person("p03", ["climbing", "pruning"]),
      person("p04", ["climbing"]),
      driver("p05", ["ground_work", "chipper"]),
      driver("p06", ["ground_work", "stump_grinding"]),
      person("p07", ["ground_work"]),
      person("p08", ["ground_work", "chipper"]),
      person("p09", ["ground_work"]),
      driver("p10", ["ground_work", "mini_skid"]),
      person("p11", ["ground_work", "fertilization"]),
      person("p12", ["climbing", "ground_work"], { availableWeekdays: [1, 2] }),
      person("p13", ["climbing", "ground_work"], { lastResort: true }),
    ];
    const services: Job["serviceType"][] = ["Removal", "Trimming", "Stump Grinding", "Plant Health Care", "Fertilization"];
    const jobs: Job[] = Array.from({ length: 10 }, (_, i) =>
      job(`j${String(i).padStart(2, "0")}`, {
        serviceType: services[i % services.length],
        value: 300 + ((i * 737) % 4000),
        estimatedHours: 1 + (i % 3),
        pruneClass: i % 4 === 1 ? "2" : null,
        ...far(((i * 37) % 11) / 40 - 0.12, ((i * 53) % 13) / 40 - 0.15),
      }),
    );
    const equipment: Equipment[] = [
      equip("t1", "Truck", { weeklyDriverLimit: 1, tows: ["chip"] }),
      equip("t2", "Truck"),
      equip("t3", "Truck", { seats: 3 }),
      equip("chip", "Chipper"),
      equip("dump", "Dump trailer"),
      equip("eqt", "Equipment trailer"),
    ];
    const state = baseState({ crew, jobs, equipment });
    const t0 = performance.now();
    const { input, plan } = run(state);
    const ms = performance.now() - t0;
    expect(input.jobs.length).toBe(10);
    expect(plan.stats.exact).toBe(false);
    expect(plan.stats.evaluations).toBeGreaterThan(0);
    expect(plan.stats.evaluations).toBeLessThanOrEqual(plan.stats.budget + 1);
    expect(plan.stats.repairs).toBeLessThanOrEqual(input.settings.repairBudget * input.settings.repairTop);
    expect(ms).toBeLessThan(2000);
    const placed = plan.crews.reduce((n, c) => n + c.stops.length, 0) + plan.notPlaced.length;
    expect(placed).toBe(10);
    console.log(
      `budget test: ${plan.stats.evaluations} evaluations, ${plan.stats.repairs} repair swaps, ${Math.round(ms)} ms, ${plan.crews.length} crews`,
    );
  });

  it("8 jobs are searched exactly", () => {
    const crew = ["a", "b", "c", "d", "e", "f"].map((id, i) => person(id, i % 2 === 0 ? ["climbing"] : ["ground_work"]));
    const jobs = Array.from({ length: 8 }, (_, i) =>
      job(`k${i}`, { serviceType: "Plant Health Care", value: 100 * (i + 1), estimatedHours: 1, ...far((i % 3) * 0.1, (i % 4) * 0.1) }),
    );
    const t0 = performance.now();
    const { plan } = run(baseState({ crew, jobs }));
    const ms = performance.now() - t0;
    expect(plan.stats.exact).toBe(true);
    expect(plan.stats.evaluations).toBeLessThanOrEqual(plan.stats.budget);
    expect(ms).toBeLessThan(2000);
    console.log(`exact test: ${plan.stats.evaluations} evaluations, ${plan.stats.repairs} repair swaps, ${Math.round(ms)} ms`);
  });
});
