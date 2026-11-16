import { describe, expect, it } from "vitest";
import { suggestDrivers } from "../driverSuggest";
import { baseState, driver, equip, job, person, DATE } from "../planner/__tests__/fixtures";

describe("suggest who drives what", () => {
  it("never suggests someone without a licence and insurance", () => {
    const state = baseState({
      crew: [person("a", ["climbing"]), person("b", ["ground_work"], { driverLicensed: true })],
      equipment: [equip("t", "Truck"), equip("ch", "Chipper")],
      jobs: [job("j", { crewIds: ["a", "b"], equipmentIds: ["t", "ch"] })],
    });
    const s = suggestDrivers(state, state.jobs[0]);
    expect(s.drivers).toEqual({});
    expect(s.notes.join(" ")).toMatch(/licence and company insurance/);
  });

  it("one driver per truck, and the towed item goes with its truck's driver", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), driver("b", ["ground_work"])],
      equipment: [equip("t1", "Truck"), equip("t2", "Truck"), equip("ch", "Chipper"), equip("dt", "Dump trailer")],
      jobs: [job("j", { serviceType: "Removal", crewIds: ["a", "b"] })],
    });
    const s = suggestDrivers(state, state.jobs[0]);
    const byPerson = (id: string) => Object.entries(s.drivers).filter(([, p]) => p === id).map(([e]) => e).sort();
    expect(byPerson("a").length).toBe(2);
    expect(byPerson("b").length).toBe(2);
    expect(s.equipmentIds.sort()).toEqual(["ch", "dt", "t1", "t2"]);
    // each person has exactly one truck
    for (const p of ["a", "b"]) expect(byPerson(p).filter((e) => e.startsWith("t")).length).toBe(1);
  });

  it("skips equipment that is down or booked on another job that day", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"])],
      equipment: [equip("t1", "Truck"), equip("chDown", "Chipper", { down: true }), equip("chBusy", "Chipper"), equip("chFree", "Chipper")],
      jobs: [job("j", { serviceType: "Trimming", crewIds: ["a"] }), job("other", { equipmentIds: ["chBusy"], crewIds: [] })],
    });
    const s = suggestDrivers(state, state.jobs[0]);
    expect(s.equipmentIds).toContain("chFree");
    expect(s.equipmentIds).not.toContain("chDown");
    expect(s.equipmentIds).not.toContain("chBusy");
    expect(s.drivers.chFree).toBe("a");
  });

  it("prefers the person whose own truck it is, and respects what a truck can tow", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), driver("b", ["ground_work"], { prefersOwnTruck: true, ownTruckId: "bigtruck" })],
      equipment: [equip("bigtruck", "Truck", { tows: ["ch"] }), equip("ch", "Chipper")],
      jobs: [job("j", { crewIds: ["a", "b"], equipmentIds: ["bigtruck", "ch"] })],
    });
    const s = suggestDrivers(state, state.jobs[0]);
    expect(s.drivers).toEqual({ bigtruck: "b", ch: "b" });
  });

  it("does not exceed a weekly limit twice (Big Truck once a week, a second time only if no one else)", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), driver("b", ["ground_work"])],
      equipment: [equip("bigtruck", "Truck", { weeklyDriverLimit: 1 }), equip("ch", "Chipper")],
      jobs: [
        job("mon", { date: "2026-11-16", crewIds: ["a"], equipmentIds: ["bigtruck"], equipmentDrivers: { bigtruck: "a" } }),
        job("j", { date: DATE, crewIds: ["a", "b"], equipmentIds: ["bigtruck", "ch"] }),
      ],
    });
    const s = suggestDrivers(state, state.jobs[1]);
    expect(s.drivers.bigtruck).toBe("b");
  });
});

describe("dragging equipment onto people", () => {
  const eq = [equip("t1", "Truck"), equip("t2", "Truck"), equip("ch", "Chipper"), equip("dt", "Dump trailer"), equip("sk", "Mini skid")];
  it("a truck and a towed item sit together; a new truck replaces the old one", async () => {
    const { assignDrive } = await import("../driverSuggest");
    let r = assignDrive(eq, [], {}, "a", "t1");
    r = assignDrive(eq, r.equipmentIds, r.drivers, "a", "ch");
    expect(r.drivers).toEqual({ t1: "a", ch: "a" });
    r = assignDrive(eq, r.equipmentIds, r.drivers, "a", "t2");
    expect(r.drivers).toEqual({ t2: "a", ch: "a" });
    expect(r.equipmentIds.sort()).toEqual(["ch", "t2"]);
    r = assignDrive(eq, r.equipmentIds, r.drivers, "a", "dt");
    expect(r.drivers).toEqual({ t2: "a", dt: "a" });
    r = assignDrive(eq, r.equipmentIds, r.drivers, "a", "sk");
    expect(r.drivers).toEqual({ t2: "a", dt: "a", sk: "a" });
  });
  it("dragging someone else's equipment moves it over", async () => {
    const { assignDrive, removeDrive } = await import("../driverSuggest");
    let r = assignDrive(eq, [], {}, "a", "t1");
    r = assignDrive(eq, r.equipmentIds, r.drivers, "b", "t1");
    expect(r.drivers).toEqual({ t1: "b" });
    r = removeDrive(r.equipmentIds, r.drivers, "t1");
    expect(r).toEqual({ equipmentIds: [], drivers: {} });
  });
});

describe("only takes what someone can drive", () => {
  it("one driver, Removal: takes one truck + one towed item and leaves the rest free", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), person("b", ["ground_work"])],
      equipment: [equip("t1", "Truck"), equip("t2", "Truck"), equip("ch", "Chipper"), equip("dt", "Dump trailer")],
      jobs: [job("j", { serviceType: "Removal", crewIds: ["a", "b"] })],
    });
    const s = suggestDrivers(state, state.jobs[0]);
    expect(s.equipmentIds.length).toBe(2);
    expect(Object.values(s.drivers)).toEqual(["a", "a"]);
    expect(s.notes.join(" ")).toMatch(/stays at the shop/);
  });
});
