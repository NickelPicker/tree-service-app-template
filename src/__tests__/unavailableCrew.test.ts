import { describe, expect, it } from "vitest";
import {
  blockedReason,
  blockedLine,
  handAddedNote,
  onlyAvailableAdded,
  suggestCrew,
  suggestDayCrews,
  unavailableReason,
  usuallyOffReason,
} from "../crewSuggest";
import { BASIC_RULES, MONDAY, baseState, job, person } from "../planner/__tests__/fixtures";

// Owner rules, 2026-11-16: unavailable crew are never suggested. Time off and
// "marked unavailable" can't be assigned at all; "usually off" is soft: never
// suggested, but can be added by hand.
const team = () => [
  person("ok", ["climbing"], { name: "Avail Climber", role: "Climber" }),
  person("weekdays", ["climbing"], { name: "Tue-Fri Climber", role: "Climber", availableWeekdays: [2, 3, 4, 5] }),
  person("vac", ["ground_work"], { name: "On Vacation", role: "Groundsman" }),
  person("sick", ["ground_work"], { name: "Out Sick", role: "Groundsman" }),
  person("g", ["ground_work"], { name: "Avail Ground", role: "Groundsman" }),
];
const state = () =>
  baseState({
    crew: team(),
    timeOff: [{ id: "t1", crewId: "vac", startDate: MONDAY, endDate: MONDAY, reason: "", status: "approved", requestedAt: MONDAY, decidedBy: "Alex", decidedAt: MONDAY }],
    unavailability: [{ id: "u1", crewId: "sick", startDate: MONDAY, endDate: MONDAY }],
    settings: { ...baseState().settings, crewRules: BASIC_RULES },
    jobs: [job("j", { date: MONDAY, crewIds: [] })],
  });

describe("unavailable crew", () => {
  it("says why someone is unavailable, with the full weekday", () => {
    const s = state();
    expect(unavailableReason(s, "ok", MONDAY)).toBeNull();
    expect(unavailableReason(s, "weekdays", MONDAY)).toBe("usually off Mondays");
    expect(unavailableReason(s, "vac", MONDAY)).toBe("on approved time off");
    expect(unavailableReason(s, "sick", MONDAY)).toBe("marked unavailable that day");
  });
  it("only time off and marked unavailable are hard blocks; usually off is a note", () => {
    const s = state();
    expect(blockedReason(s, "weekdays", MONDAY)).toBeNull();
    expect(usuallyOffReason(s, "weekdays", MONDAY)).toBe("usually off Mondays");
    expect(usuallyOffReason(s, "weekdays", "2026-11-17")).toBeNull();
    expect(blockedReason(s, "vac", MONDAY)).toBe("on approved time off");
    expect(blockedReason(s, "sick", MONDAY)).toBe("marked unavailable that day");
    expect(handAddedNote("usually off Mondays")).toBe("usually off Mondays — added by hand");
  });
  it("never adds someone on time off or marked unavailable; a usually-off person added by hand stays", () => {
    const s = state();
    const r = onlyAvailableAdded(s, ["vac"], ["vac", "ok", "weekdays", "sick", "g"], MONDAY);
    expect(r.ids).toEqual(["vac", "ok", "weekdays", "g"]);
    expect(r.blocked.map((b) => b.id)).toEqual(["sick"]);
    expect(blockedLine(r.blocked)).toBe("Out Sick can't be put on this job: marked unavailable that day.");
    const v = onlyAvailableAdded(s, [], ["vac"], MONDAY);
    expect(v.ids).toEqual([]);
    expect(v.blocked[0].reason).toBe("on approved time off");
  });
  it("a usually-off person ticked by hand survives the save", () => {
    const s = state();
    // saveJob / setJobCrew keep exactly onlyAvailableAdded(...).ids.
    const saved = onlyAvailableAdded(s, [], ["ok", "weekdays"], MONDAY).ids;
    expect(saved).toEqual(["ok", "weekdays"]);
    // Saved again later (already on the job): still there.
    expect(onlyAvailableAdded(s, saved, saved, MONDAY).ids).toEqual(["ok", "weekdays"]);
  });
  it("Suggest crew never picks someone unavailable, even when short", () => {
    const s = state();
    const sug = suggestCrew(s, s.jobs[0], MONDAY);
    for (const id of ["weekdays", "vac", "sick"]) expect(sug.crewIds).not.toContain(id);
  });
  it("Suggest crew skips a usually-off climber even when they are the only climber", () => {
    const s = { ...state(), crew: state().crew.filter((c) => c.id !== "ok") };
    const sug = suggestCrew(s, s.jobs[0], MONDAY);
    expect(sug.crewIds).not.toContain("weekdays");
    expect(sug.warnings.some((w) => w.startsWith("Short 1 climber"))).toBe(true);
  });
  it("day-crew suggestions never include anyone usually off, on time off or unavailable", () => {
    const s = state();
    const crews = suggestDayCrews(s, MONDAY);
    const ids = crews.flatMap((c) => c.memberIds);
    for (const id of ["weekdays", "vac", "sick"]) expect(ids).not.toContain(id);
  });
});

describe("Schedule work order (business rule)", () => {
  it("lists the job done first on top: earliest arrival, then start time; never by value", async () => {
    const { compareByWorkOrder } = await import("../scheduling");
    const jobs: Array<{ id: string; title: string; startTime: string; crewArrivals: Record<string, string> | null; value: number }> = [
      { id: "big", title: "Big oak", startTime: "08:00", crewArrivals: { a: "08:12", b: "07:00" }, value: 6500 },
      { id: "small", title: "Elm trim", startTime: "08:00", crewArrivals: { c: "07:20" }, value: 400 },
      { id: "nine", title: "Nine", startTime: "9:00", crewArrivals: null, value: 99999 },
      { id: "ten", title: "Ten", startTime: "10:00", crewArrivals: null, value: 1 },
      { id: "none", title: "No time", startTime: "", crewArrivals: null, value: 5 },
    ];
    expect([...jobs].sort(compareByWorkOrder).map((j) => j.id)).toEqual(["big", "small", "nine", "ten", "none"]);
  });
});
