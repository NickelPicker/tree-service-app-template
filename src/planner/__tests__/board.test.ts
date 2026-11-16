import { describe, expect, it } from "vitest";
import {
  autoFillInput,
  autoPlanDay,
  isFieldCrew,
  boardMeetInput,
  boardPatchJob,
  buildDayPatches,
  dayNeedsPlan,
  equipmentGroups,
  fillEquipment,
  placeEquipment,
  remainingWork,
  replanFromNow,
  savedRoutes,
  todayChanges,
  weekDaysMonSat,
} from "../board";
import { autoFill, simulate, type MeetInput } from "../meetup";
import { baseState, driver, equip, job, person, DATE } from "./fixtures";
import type { TimesheetEntry } from "../../types";

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, legalDriver: true, skills: ["ground_work"] }));
const mj = (id: string, work: number, node: number) => ({ id, title: id, work, node, fixedStartMin: null, climbers: 0, skills: [] });
const meetOf = (over: Partial<MeetInput>): MeetInput => ({
  jobs: [],
  people: people(4),
  drive: [
    [0, 20, 25],
    [20, 0, 15],
    [25, 15, 0],
  ],
  dayStartMin: 7 * 60,
  dayEndMin: 17 * 60,
  dollarsPerHour: 400,
  fullSpeedCrew: 3,
  minTeam: 2,
  ...over,
});
const sheet = (crewId: string, jobId: string | null, clockIn: string, clockOut: string | null = null): TimesheetEntry => ({
  id: `t-${crewId}-${clockIn}`,
  crewId,
  jobId,
  date: DATE,
  clockIn,
  clockOut,
  hours: null,
  notes: "",
  location: "",
});

describe("simulate from now (re-plan the rest of today)", () => {
  it("without startMin/startAt nothing changes", () => {
    const m = meetOf({ jobs: [mj("a", 800, 1)], people: people(3) });
    const s = simulate(m, { p0: ["a"], p1: ["a"], p2: ["a"] });
    expect(s.jobs.a.startMin).toBe(7 * 60 + 20);
    expect(s.jobs.a.endMin).toBe(7 * 60 + 20 + 120);
  });

  it("people already on a job keep working there from now; everyone else leaves the shop now", () => {
    const m = meetOf({
      jobs: [mj("a", 400, 1), mj("b", 800, 2)],
      people: people(4),
      startMin: 12 * 60,
      startAt: { p0: { jobId: "a" }, p1: { jobId: "a" }, p2: { jobId: "a" } },
    });
    const s = simulate(m, { p0: ["a"], p1: ["a"], p2: ["a"], p3: ["b"] });
    // a: $400 with 3 people = 1 hour from noon, no drive.
    expect(s.jobs.a.arrivals.p0).toBe(12 * 60);
    expect(s.jobs.a.endMin).toBe(13 * 60);
    // p3 leaves the shop at noon: 25 min to b.
    expect(s.jobs.b.arrivals.p3).toBe(12 * 60 + 25);
    expect(s.routes.p0).toEqual(["a"]);
  });

  it("auto-fill keeps clocked-in people on their job and only splits up the rest", () => {
    const m = meetOf({
      jobs: [mj("a", 400, 1), mj("b", 2000, 2)],
      people: people(5),
      startMin: 11 * 60,
      startAt: { p0: { jobId: "a" }, p1: { jobId: "a" } },
    });
    const f = autoFill(m)!;
    expect(f.routes.p0[0]).toBe("a");
    expect(f.routes.p1[0]).toBe("a");
    for (const p of m.people) expect(f.routes[p.id]?.length ?? 0).toBeGreaterThan(0);
    // Nobody starts before now.
    for (const tl of Object.values(f.sim.jobs)) if (tl.startMin != null) expect(tl.startMin).toBeGreaterThanOrEqual(11 * 60);
  });

  it("work left = work minus elapsed minutes × the crew's rate, never below 10%", () => {
    const m = meetOf({});
    // 3 people for 60 min at $400/h = $400 done.
    expect(remainingWork(m, 1000, 60, 3)).toBe(600);
    expect(remainingWork(m, 1000, 600, 3)).toBe(100);
    expect(remainingWork(m, 1000, -5, 3)).toBe(1000);
  });

  it("replanFromNow reads open timesheets: in-progress work shrinks, the crew are pinned, arrivals kept", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), driver("b", ["ground_work"]), driver("c", ["ground_work"])],
      jobs: [job("j1", { value: 1200, crewIds: ["a", "b"], crewArrivals: { a: "07:30" } }), job("j2", { value: 800 })],
      timesheets: [sheet("a", "j1", "08:00"), sheet("b", "j1", "08:30"), sheet("c", "j1", "07:00", "07:45")],
    });
    const { meet } = boardMeetInput(state, DATE, {});
    const r = replanFromNow(state, DATE, meet, 9 * 60);
    expect(r.pinned).toEqual({ a: "j1", b: "j1" });
    expect(r.inProgress).toEqual(["j1"]);
    // 60 min since the first clock-in, 2 people at $400/h → $400 done of $1,200.
    expect(r.meet.jobs.find((j) => j.id === "j1")!.work).toBe(800);
    expect(r.meet.jobs.find((j) => j.id === "j2")!.work).toBe(800);
    expect(r.meet.startMin).toBe(9 * 60);
    expect(r.keepArrivals.j1).toEqual({ a: "07:30", b: "08:30" });
    // Saving keeps their real arrival and the job's start time.
    const f = autoFill(r.meet)!;
    const patches = buildDayPatches(DATE, state.jobs, r.meet, f.routes, f.sim, {}, {
      keepArrivals: r.keepArrivals,
      keepStart: new Set(r.inProgress),
    });
    expect(patches.j1.crewArrivals?.a).toBe("07:30");
    expect(patches.j1.startTime).toBeUndefined();
    expect(patches.j1.crewIds).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

describe("trucks on the board", () => {
  const fleetState = () =>
    baseState({
      crew: [driver("a", ["ground_work"]), driver("b", ["ground_work"]), driver("c", ["ground_work"]), driver("d", ["ground_work"])],
      equipment: [equip("t1", "Truck"), equip("t2", "Truck"), equip("t3", "Truck"), equip("ch", "Chipper")],
      jobs: [job("small", { value: 400 }), job("big", { value: 2000 })],
    });

  it("never puts the same vehicle on two jobs of the day", () => {
    const state = fleetState();
    const meet = meetOf({ jobs: [mj("small", 400, 1), mj("big", 2000, 2)] });
    const routes = { a: ["small"], b: ["small"], c: ["big"], d: ["big"] };
    const m2 = { ...meet, people: ["a", "b", "c", "d"].map((id) => ({ id, name: id, legalDriver: true, skills: [] })) };
    const sim = simulate(m2, routes);
    const eq = fillEquipment(state, DATE, state.jobs, m2, routes, sim, {});
    const all = [...eq.small.equipmentIds, ...eq.big.equipmentIds];
    expect(new Set(all).size).toBe(all.length);
    // The only chipper goes to the bigger job; each team has a truck with a driver from that team.
    expect(eq.big.equipmentIds).toContain("ch");
    expect(eq.small.equipmentIds).not.toContain("ch");
    for (const [jobId, team] of [["small", ["a", "b"]], ["big", ["c", "d"]]] as const) {
      const truck = eq[jobId].equipmentIds.find((id) => id.startsWith("t"))!;
      expect(team).toContain(eq[jobId].drivers[truck]);
    }
  });

  it("a team joining later keeps its own truck (no new truck on the second job for them)", () => {
    const state = fleetState();
    const m2 = {
      ...meetOf({ jobs: [mj("small", 400, 1), mj("big", 4000, 2)] }),
      people: ["a", "b", "c", "d"].map((id) => ({ id, name: id, legalDriver: true, skills: [] })),
    };
    const routes = { a: ["small", "big"], b: ["small", "big"], c: ["big"], d: ["big"] };
    const sim = simulate(m2, routes);
    const eq = fillEquipment(state, DATE, state.jobs, m2, routes, sim, {});
    const bigDrivers = Object.values(eq.big.drivers);
    expect(bigDrivers).not.toContain("a");
    expect(bigDrivers).not.toContain("b");
    expect(Object.values(eq.small.drivers).some((x) => x === "a" || x === "b")).toBe(true);
  });

  it("auto-planning a day writes equipment with no double booking", () => {
    const state = fleetState();
    const { meet } = boardMeetInput(state, DATE, {});
    const plan = autoPlanDay(state, DATE, state.jobs, meet)!;
    const all = Object.values(plan.patches).flatMap((p) => p.equipmentIds ?? []);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });

  it("placing a piece on a person moves it off any other job and replaces their truck", () => {
    const state = fleetState();
    const draft = {
      small: { equipmentIds: ["t1"], drivers: { t1: "a" } },
      big: { equipmentIds: ["t2", "ch"], drivers: { t2: "c", ch: "c" } },
    };
    const next = placeEquipment(state.equipment, draft, "small", "a", "t2");
    expect(next.big.equipmentIds).toEqual(["ch"]);
    expect(next.small.equipmentIds).toEqual(["t2"]);
    expect(next.small.drivers).toEqual({ t2: "a" });
  });

  it("groups a job's equipment by driver, truck first", () => {
    const state = fleetState();
    const g = equipmentGroups(state.equipment, { equipmentIds: ["ch", "t1", "t2"], drivers: { t1: "a", ch: "a", t2: "b" } }, ["a", "b"]);
    expect(g.map((x) => [x.driverId, x.items.map((i) => i.id)])).toEqual([
      ["a", ["t1", "ch"]],
      ["b", ["t2"]],
    ]);
  });
});

describe("today changed", () => {
  it("flags someone on the plan now off, a job with nobody, and a free person", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), driver("b", ["ground_work"]), person("c", ["ground_work"])],
      jobs: [job("j1", { crewIds: ["a", "b"] }), job("j2", { title: "Oak trim" })],
      timeOff: [{ id: "x", crewId: "b", startDate: DATE, endDate: DATE, status: "approved" } as never],
    });
    const { p, meet } = boardMeetInput(state, DATE, {});
    const why = todayChanges(state, state.jobs, meet, p.off);
    expect(why.some((w) => w.startsWith("B is off today"))).toBe(true);
    expect(why).toContain("Nobody is on Oak trim");
    expect(why).toContain("C is free but not on a job");
  });
  it("says nothing when nothing is planned yet", () => {
    const state = baseState({ crew: [driver("a", ["climbing"])], jobs: [job("j1")] });
    const { p, meet } = boardMeetInput(state, DATE, {});
    expect(todayChanges(state, state.jobs, meet, p.off)).toEqual([]);
  });
});

describe("fill this week", () => {
  it("Monday to Saturday of the week", () => {
    expect(weekDaysMonSat(DATE)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(weekDaysMonSat("2026-11-22")[0]).toBe("2026-11-16");
  });
  it("a day with arrival times is already planned; an empty day needs nothing", () => {
    const state = baseState({
      jobs: [job("j1", { crewIds: ["a"], crewArrivals: { a: "08:00" } }), job("j2", { date: "2026-11-19" })],
    });
    expect(dayNeedsPlan(state, DATE)).toBe(false);
    expect(dayNeedsPlan(state, "2026-11-19")).toBe(true);
    expect(dayNeedsPlan(state, "2026-11-20")).toBe(false);
  });
});

describe("next working days", () => {
  it("skips Sundays and starts on the board's day", async () => {
    const { nextWorkDays } = await import("../board");
    expect(nextWorkDays("2026-11-14")).toEqual(["2026-11-14", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
  });
});

describe("promised start times", () => {
  it("only a job ticked 'Customer was promised this time' keeps its time fixed", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"]), driver("b", ["ground_work"])],
      jobs: [
        job("free", { crewIds: [], startTime: "10:30" }),
        job("promised", { crewIds: [], startTime: "13:00", timePromised: true }),
      ],
    });
    const { meet } = boardMeetInput(state, DATE, {});
    expect(meet.jobs.find((j) => j.id === "free")?.fixedStartMin).toBeNull();
    expect(meet.jobs.find((j) => j.id === "promised")?.fixedStartMin).toBe(13 * 60);
  });
});

describe("Auto-fill places field crew only (business rule)", () => {
  const state = baseState({
    crew: [
      driver("a", ["climbing"]),
      driver("b", ["ground_work"]),
      person("helper", []), // field crew with no skills ticked: still a helper
      driver("own", ["climbing"], { appRole: "owner" }),
      driver("mgr", ["ground_work"], { appRole: "manager" }),
      person("off", [], { appRole: "office" }),
      person("sal", ["ground_work"], { role: "Sales" }),
    ],
    jobs: [job("j1", { value: 6000 }), job("j2", { value: 800, title: "Small trim" })],
  });

  it("leaves owner, manager, office and sales logins off the auto-filled day", () => {
    const { meet } = boardMeetInput(state, DATE, {});
    // Everyone stays on the board so they can be dragged on by hand…
    expect(meet.people.map((p) => p.id).sort()).toEqual(["a", "b", "helper", "mgr", "off", "own", "sal"]);
    // …but Auto-fill only gets the field crew.
    const input = autoFillInput(state, meet);
    expect(input.people.map((p) => p.id).sort()).toEqual(["a", "b", "helper"]);
    const fill = autoFill(input)!;
    const placed = Object.keys(fill.routes).filter((pid) => (fill.routes[pid] ?? []).length > 0);
    expect(placed).not.toContain("own");
    expect(placed).not.toContain("mgr");
    expect(placed).not.toContain("off");
    expect(placed).not.toContain("sal");
    expect(placed).toContain("helper");
  });

  it("keeps an office login who is already pinned to a job (clocked in there)", () => {
    const { meet } = boardMeetInput(state, DATE, {});
    const input = autoFillInput(state, { ...meet, startAt: { mgr: { jobId: "j1" } } });
    expect(input.people.map((p) => p.id)).toContain("mgr");
  });

  it("the whole-week fill skips office logins too", () => {
    const { meet } = boardMeetInput(state, DATE, {});
    const day = autoPlanDay(state, DATE, state.jobs, meet)!;
    const placed = Object.keys(day.fill.routes).filter((pid) => (day.fill.routes[pid] ?? []).length > 0);
    expect(placed.some((pid) => ["own", "mgr", "off", "sal"].includes(pid))).toBe(false);
  });

  it("doesn't call an unplaced office login 'free but not on a job'", () => {
    const planned = { ...state, jobs: [job("j1", { value: 6000, crewIds: ["a", "b", "helper"] })] };
    const { p, meet } = boardMeetInput(planned, DATE, {});
    expect(todayChanges(planned, planned.jobs, meet, p.off)).toEqual([]);
    expect(isFieldCrew(planned.crew.find((c) => c.id === "own"))).toBe(false);
  });
});

describe("usually off today (business rule): never auto-filled, can be added by hand", () => {
  // DATE is a Wednesday; "mt" works Mon, Tue, Thu, Fri.
  const crewState = (over: Partial<ReturnType<typeof baseState>> = {}) =>
    baseState({
      crew: [
        driver("a", ["climbing"]),
        driver("b", ["ground_work"]),
        driver("c", ["ground_work"]),
        driver("mt", ["climbing"], { availableWeekdays: [1, 2, 4, 5] }),
        driver("vac", ["ground_work"]),
        driver("sick", ["ground_work"]),
      ],
      timeOff: [{ id: "t", crewId: "vac", startDate: DATE, endDate: DATE, status: "approved" } as never],
      unavailability: [{ id: "u", crewId: "sick", startDate: DATE, endDate: DATE }],
      jobs: [job("j1", { value: 6000 }), job("j2", { value: 800, title: "Small trim" })],
      ...over,
    });

  it("stays on the board flagged 'usually off Wednesdays', not under Not available", () => {
    const state = crewState();
    const { p, meet } = boardMeetInput(state, DATE, {});
    expect(meet.people.find((x) => x.id === "mt")?.usuallyOff).toBe("usually off Wednesdays");
    expect(meet.people.find((x) => x.id === "a")?.usuallyOff).toBeUndefined();
    expect(p.off.map((o) => o.crewId).sort()).toEqual(["sick", "vac"]);
    expect(meet.people.map((x) => x.id)).not.toContain("vac");
    expect(meet.people.map((x) => x.id)).not.toContain("sick");
  });

  it("Auto-fill and the week fill never place them", () => {
    const state = crewState();
    const { meet } = boardMeetInput(state, DATE, {});
    expect(autoFillInput(state, meet).people.map((x) => x.id)).not.toContain("mt");
    const fill = autoFill(autoFillInput(state, meet))!;
    expect(fill.routes.mt).toBeUndefined();
    const day = autoPlanDay(state, DATE, state.jobs, meet)!;
    for (const pt of Object.values(day.patches)) expect(pt.crewIds).not.toContain("mt");
  });

  it("placed by hand, Auto-fill keeps them where they were put", () => {
    const state = crewState();
    const { meet } = boardMeetInput(state, DATE, {});
    const byHand = { mt: ["j2"] };
    const input = autoFillInput(state, meet, byHand);
    expect(input.people.map((x) => x.id)).toContain("mt");
    const fill = autoFill(input)!;
    expect(fill.routes.mt?.[0]).toBe("j2");
    // Re-running Auto-fill on its own result keeps them again.
    const again = autoFill(autoFillInput(state, meet, fill.routes))!;
    expect(again.routes.mt?.[0]).toBe("j2");
    // The rest of the crew is still planned around them.
    expect(Object.keys(again.routes)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("dragged on and saved, they stay on the job; Auto-fill for that day keeps them", () => {
    const state = crewState();
    const { meet } = boardMeetInput(state, DATE, {});
    const routes = { a: ["j1"], b: ["j1"], mt: ["j2"], c: ["j2"] };
    const sim = simulate(meet, routes);
    const patches = buildDayPatches(DATE, state.jobs, meet, routes, sim, {});
    const saved = { ...state, jobs: state.jobs.map((j) => boardPatchJob(state, j, patches[j.id], DATE) ?? j) };
    expect(saved.jobs.find((j) => j.id === "j2")?.crewIds).toContain("mt");
    const { meet: m2 } = boardMeetInput(saved, DATE, {});
    const fill = autoFill(autoFillInput(saved, m2, savedRoutes(saved, saved.jobs)))!;
    expect(fill.routes.mt?.[0]).toBe("j2");
    const day = autoPlanDay(saved, DATE, saved.jobs, m2)!;
    expect(day.patches.j2.crewIds).toContain("mt");
  });

  it("time off and marked unavailable are still refused on save", () => {
    const state = crewState();
    const j = state.jobs[0];
    const next = boardPatchJob(state, j, { crewIds: ["a", "vac", "sick", "mt"] }, DATE)!;
    expect(next.crewIds).toEqual(["a", "mt"]);
  });

  it("isn't called 'free but not on a job' when left off", () => {
    const planned = crewState({ jobs: [job("j1", { value: 6000, crewIds: ["a", "b", "c"] })] });
    const { p, meet } = boardMeetInput(planned, DATE, {});
    expect(todayChanges(planned, planned.jobs, meet, p.off)).toEqual([]);
  });
});
