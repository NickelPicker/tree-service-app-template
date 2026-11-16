import { describe, expect, it } from "vitest";
import { applyPatches, boardJobs, boardMeetInput, boardPatchJob } from "../board";
import {
  UNDO_MS,
  applyFill,
  checkFillApply,
  fillEmail,
  fillPreview,
  fillSkippedDays,
  fillUndoSnapshot,
  jobFields,
  planFillDay,
  planUndo,
  previewOutOfDate,
  sameFields,
  undoMinutesLeft,
  type FillDay,
} from "../fillPreview";
import type { DayBoardPatch } from "../../store";
import type { AppState } from "../../types";
import { baseState, driver, equip, job, person, DATE } from "./fixtures";

const THURSDAY = "2026-11-19";
const SATURDAY = "2026-11-21";

/** What the board's Fill does for each day (straight-line drive times). */
function planDays(state: AppState, days: string[], skipped: string[] = []): FillDay[] {
  let working = state;
  const out: FillDay[] = [];
  for (const d of days) {
    const { meet } = boardMeetInput(working, d, {});
    const plan = planFillDay(working, d, boardJobs(working, d), meet);
    if ("skip" in plan) {
      skipped.push(`${d}: ${plan.skip}`);
      continue;
    }
    out.push(plan);
    working = applyPatches(working, plan.patches);
  }
  return out;
}

/** Save the way saveDayBoard does. */
function save(state: AppState, day: string, patches: Record<string, DayBoardPatch>): AppState {
  return { ...state, jobs: state.jobs.map((j) => boardPatchJob(state, j, patches[j.id], day) ?? j) };
}

const crew = () => [
  driver("a", ["climbing"], { email: "a@example.com" }),
  driver("b", ["ground_work"], { email: "b@example.com" }),
  driver("c", ["ground_work"], { email: "c@example.com" }),
  driver("d", ["climbing"], { email: "d@example.com" }),
];

const twoDays = () =>
  baseState({
    crew: crew(),
    equipment: [equip("t1", "Truck"), equip("t2", "Truck"), equip("ch", "Chipper")],
    jobs: [
      job("j1", { title: "Oak trim", value: 3000, startTime: "09:00" }),
      job("j2", { title: "Elm removal", value: 1200, startTime: "10:00" }),
      job("j3", { title: "Maple prune", value: 1500, date: THURSDAY }),
    ],
  });

describe("Fill preview (nothing saved)", () => {
  it("shows each day's jobs with crew, trucks, start times and what changes", () => {
    const state = twoDays();
    const days = planDays(state, [DATE, THURSDAY]);
    const pv = fillPreview(state, days);
    expect(pv.days.map((d) => d.day)).toEqual([DATE, THURSDAY]);
    const oak = pv.days[0].jobs.find((j) => j.jobId === "j1")!;
    expect(oak.crew.length).toBeGreaterThanOrEqual(2);
    expect(oak.start).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(oak.changes[0]).toMatch(/^Crew: nobody → /);
    expect(oak.changes.some((c) => c.startsWith("Equipment: none → "))).toBe(true);
    expect(oak.equipment.some((e) => /^t\d \(/.test(e))).toBe(true);
    expect(pv.changedJobs).toBe(3);
    // The state itself is untouched: nothing saved.
    expect(state.jobs.every((j) => j.crewIds.length === 0)).toBe(true);
  });

  it("never places unavailable crew, and never leaves anyone alone on a job", () => {
    const state = {
      ...twoDays(),
      timeOff: [{ id: "x", crewId: "d", startDate: DATE, endDate: DATE, status: "approved" } as never],
    };
    const pv = fillPreview(state, planDays(state, [DATE]));
    for (const j of pv.days[0].jobs) {
      expect(j.crew).not.toContain("D");
      expect(j.crew.length === 0 || j.crew.length >= 2).toBe(true);
    }
  });

  it("says what is left unplanned and why", () => {
    const state = baseState({
      crew: [driver("a", ["climbing"])],
      jobs: [job("j1", { title: "Oak trim" })],
    });
    const skipped: string[] = [];
    expect(planDays(state, [DATE], skipped)).toEqual([]);
    expect(skipped).toEqual([`${DATE}: only 1 person available and nobody works alone (teams of 2 or more)`]);
  });

  it("lists a job left with nobody, and missing skills", () => {
    // 2 people, 2 jobs far apart in time: one team of 2, the other job may stay empty.
    const state = baseState({
      crew: [driver("a", ["ground_work"]), driver("b", ["ground_work"])],
      jobs: [
        job("j1", { title: "Oak trim", value: 4000, estimatedHours: 9, startTime: "07:00", timePromised: true }),
        job("j2", { title: "Elm removal", value: 4000, estimatedHours: 9, startTime: "07:00", timePromised: true }),
      ],
    });
    const pv = fillPreview(state, planDays(state, [DATE]));
    expect(pv.unplanned).toContain("Wed: Oak trim: needs 1 climber, has 0");
    expect(pv.unplanned).toContain("Wed: Elm removal: Not finished that day: it needs more time or more people");
    expect(pv.days[0].summary).toBe("2 jobs, 1 not finished that day");
  });

  it("a job the fill leaves with nobody says why", () => {
    const state = baseState({ crew: crew(), jobs: [job("j1", { title: "Oak trim" }), job("j2", { title: "Elm" })] });
    const day: FillDay = {
      day: DATE,
      patches: {
        j1: { crewIds: ["a", "b"], startTime: "08:00", crewArrivals: null, equipmentIds: [], equipmentDrivers: null },
        j2: { crewIds: [], crewArrivals: null, equipmentIds: [], equipmentDrivers: null },
      },
      snapshot: "{}",
      finishMin: 600,
      unfinished: ["j2"],
      problems: {},
      available: 2,
      minTeam: 2,
    };
    const pv = fillPreview(state, [day]);
    expect(pv.unplanned).toEqual(["Wed: Elm: Left unplanned: not enough crew left that day for another team of 2"]);
    const elm = pv.days[0].jobs.find((j) => j.jobId === "j2")!;
    expect(elm.changes).toEqual([]);
    expect(pv.changedJobs).toBe(1);
  });

  it("skips Sundays, days already planned and days with no jobs, and says so", () => {
    const state = baseState({
      crew: crew(),
      jobs: [
        job("sat", { date: SATURDAY }),
        job("mon", { date: "2026-11-23", crewIds: ["a", "b"], crewArrivals: { a: "08:00", b: "08:00" } }),
        job("tue", { date: "2026-11-24" }),
      ],
    });
    const r = fillSkippedDays(state, SATURDAY, { today: "2026-11-15", boardDirty: false });
    expect(r.plan).toEqual([SATURDAY, "2026-11-24"]);
    expect(r.skipped).toEqual([
      { day: "2026-11-22", why: "Sunday (no work on Sundays)" },
      { day: "2026-11-23", why: "already planned (Fill never replaces a plan)" },
      { day: "2026-11-25", why: "no jobs" },
      { day: "2026-11-26", why: "no jobs" },
      { day: "2026-11-27", why: "no jobs" },
    ]);
  });

  it("a multi-day job keeps its crew on its later days", () => {
    const state = baseState({
      crew: crew(),
      jobs: [job("big", { title: "Big removal", value: 9000, endDate: THURSDAY })],
    });
    const skipped: string[] = [];
    const days = planDays(state, [DATE, THURSDAY], skipped);
    expect(days.map((d) => d.day)).toEqual([DATE]);
    expect(applyFill(state, days).jobs[0].crewIds.length).toBeGreaterThanOrEqual(2);
    expect(skipped).toEqual([`${THURSDAY}: Big removal continues with the same crew (multi-day job)`]);
  });

  it("a later day with other jobs keeps the multi-day crew on the multi-day job", () => {
    const state = baseState({
      crew: [...crew(), driver("e", ["ground_work"]), driver("f", ["ground_work"])],
      jobs: [
        job("big", { title: "Big removal", value: 9000, endDate: THURSDAY }),
        job("small", { title: "Hedge", value: 500, date: THURSDAY }),
      ],
    });
    const days = planDays(state, [DATE, THURSDAY]);
    expect(days.map((d) => d.day)).toEqual([DATE, THURSDAY]);
    const firstCrew = applyFill(state, days.slice(0, 1)).jobs.find((j) => j.id === "big")!.crewIds;
    const after = applyFill(state, days).jobs.find((j) => j.id === "big")!.crewIds;
    expect([...after].sort()).toEqual([...firstCrew].sort());
    const later = fillPreview(state, days).days[1].jobs.find((j) => j.jobId === "big")!;
    expect(later.continues).toBe(true);
  });

  it("knows when the preview is out of date", () => {
    const state = twoDays();
    const days = planDays(state, [DATE]);
    expect(previewOutOfDate(state, state, days)).toBe(false);
    const changed = { ...state, jobs: state.jobs.map((j) => (j.id === "j1" ? { ...j, crewIds: ["a"] } : j)) };
    expect(previewOutOfDate(state, changed, days)).toBe(true);
  });
});

describe("Fill emails (business rule: more than 3 needs the double confirm)", () => {
  it("sends nothing at all when 'Email everyone their day' is off", () => {
    const state = twoDays();
    const e = fillEmail(state, planDays(state, [DATE, THURSDAY]));
    expect(e).toEqual({ on: false, perDay: {}, total: 0, needsConfirm: false });
  });

  it("asks twice when more than 3 people would be emailed", () => {
    const state = twoDays();
    const days = planDays(state, [DATE, THURSDAY]);
    const e = fillEmail(state, days, { emailCrewOnSave: true });
    expect(e.on).toBe(true);
    expect(e.total).toBe(Object.values(e.perDay).reduce((a, b) => a + b, 0));
    expect(e.total).toBeGreaterThan(3);
    expect(e.needsConfirm).toBe(true);
  });

  it("3 emails or fewer go without the double confirm; people without an email don't count", () => {
    const state = {
      ...twoDays(),
      crew: [
        driver("a", ["climbing"], { email: "a@example.com" }),
        driver("b", ["ground_work"], { email: "b@example.com" }),
        person("c", ["ground_work"], { email: "" }),
      ],
      jobs: [job("j1", { title: "Oak trim", value: 3000 })],
    };
    const e = fillEmail(state, planDays(state, [DATE]), { emailCrewOnSave: true });
    expect(e.total).toBeLessThanOrEqual(2);
    expect(e.needsConfirm).toBe(false);
  });
});

describe("Undo after Apply", () => {
  const withSaved = () => {
    const s = twoDays();
    // j2 already has equipment and a promised-looking time set by hand.
    return {
      ...s,
      jobs: s.jobs.map((j) =>
        j.id === "j2" ? { ...j, equipmentIds: ["ch"], equipmentDrivers: null, startTime: "10:00" } : j,
      ),
    };
  };

  it("snapshots every touched job before Apply and puts each back exactly", () => {
    const before = withSaved();
    const days = planDays(before, [DATE, THURSDAY]);
    const undo = fillUndoSnapshot(before, days, 1000);
    expect(undo.jobs.map((j) => j.jobId).sort()).toEqual(["j1", "j2", "j3"]);
    expect(undo.expiresAt - undo.appliedAt).toBe(UNDO_MS);

    let applied = before;
    for (const d of days) applied = save(applied, d.day, d.patches);
    // The snapshot's "after" is exactly what Save day wrote.
    for (const u of undo.jobs) expect(sameFields(jobFields(applied.jobs.find((j) => j.id === u.jobId)!), u.after)).toBe(true);

    const plan = planUndo(applied, undo, 2000)!;
    expect(plan.skipped).toEqual([]);
    expect(plan.restored.sort()).toEqual(["Elm removal", "Maple prune", "Oak trim"]);
    let restored = applied;
    for (const [day, patches] of Object.entries(plan.byDay)) restored = save(restored, day, patches);
    for (const j of before.jobs) {
      const r = restored.jobs.find((x) => x.id === j.id)!;
      expect(jobFields(r)).toEqual(jobFields(j));
    }
  });

  it("skips a job someone changed after Apply, and says so", () => {
    const before = withSaved();
    const days = planDays(before, [DATE, THURSDAY]);
    const undo = fillUndoSnapshot(before, days, 1000);
    let applied = before;
    for (const d of days) applied = save(applied, d.day, d.patches);
    // A teammate moves j1's start time after the fill.
    const edited = { ...applied, jobs: applied.jobs.map((j) => (j.id === "j1" ? { ...j, startTime: "13:30" } : j)) };
    const plan = planUndo(edited, undo, 2000)!;
    expect(plan.skipped).toEqual([{ title: "Oak trim", why: "it was changed after Fill, so that change is kept" }]);
    expect(Object.values(plan.byDay).some((p) => "j1" in p)).toBe(false);
    let restored = edited;
    for (const [day, patches] of Object.entries(plan.byDay)) restored = save(restored, day, patches);
    expect(restored.jobs.find((j) => j.id === "j1")!.startTime).toBe("13:30");
    expect(jobFields(restored.jobs.find((j) => j.id === "j3")!)).toEqual(jobFields(before.jobs.find((j) => j.id === "j3")!));
  });

  it("skips a deleted job, and is gone after 10 minutes", () => {
    const before = twoDays();
    const days = planDays(before, [DATE]);
    const undo = fillUndoSnapshot(before, days, 0);
    let applied = before;
    for (const d of days) applied = save(applied, d.day, d.patches);
    const deleted = { ...applied, jobs: applied.jobs.filter((j) => j.id !== "j2") };
    expect(planUndo(deleted, undo, 1)!.skipped).toEqual([{ title: "Elm removal", why: "it was deleted after Fill" }]);
    expect(undoMinutesLeft(undo, 60_000)).toBe(9);
    expect(planUndo(applied, undo, UNDO_MS + 1)).toBeNull();
    expect(undoMinutesLeft(undo, UNDO_MS + 1)).toBe(0);
  });

  it("a crew member who became unavailable is not put back, and Undo says so", () => {
    const before = baseState({
      crew: crew(),
      jobs: [job("j1", { title: "Oak trim", crewIds: ["a", "b"], date: THURSDAY }), job("j2", { title: "Elm", value: 2000 })],
    });
    // Fill only plans Wednesday; fake a snapshot where j1 lost a and b.
    const days: FillDay[] = [
      {
        day: THURSDAY,
        patches: { j1: { crewIds: ["c", "d"], startTime: "08:00", crewArrivals: null, equipmentIds: [], equipmentDrivers: null } },
        snapshot: "{}",
        finishMin: 600,
        unfinished: [],
        problems: {},
        available: 4,
        minTeam: 2,
      },
    ];
    const undo = fillUndoSnapshot(before, days, 0);
    const applied = save(before, THURSDAY, days[0].patches);
    const off = {
      ...applied,
      timeOff: [{ id: "x", crewId: "a", startDate: THURSDAY, endDate: THURSDAY, status: "approved" } as never],
    };
    const plan = planUndo(off, undo, 1)!;
    expect(plan.blocked).toEqual(["A could not be put back on Oak trim (not available that day)"]);
  });
});

describe("Fill Apply checks again after the email confirm", () => {
  const emailing = (s: AppState): AppState =>
    ({ ...s, settings: { ...s.settings, planner: { ...(s.settings.planner ?? {}), emailCrewOnSave: true } } }) as AppState;

  it("a teammate's change while the dialog is open stops the save", async () => {
    const state = emailing(twoDays());
    const days = planDays(state, [DATE, THURSDAY]);
    let current: AppState = state;
    const r = await checkFillApply(state, days, () => current, async () => {
      // A teammate saves a crew change on a filled job meanwhile.
      current = { ...current, jobs: current.jobs.map((j) => (j.id === "j1" ? { ...j, crewIds: ["a"] } : j)) };
      return true;
    });
    expect(r.ok).toBe(false);
  });

  it("with no change it goes ahead with the latest state and the answer given", async () => {
    const state = emailing(twoDays());
    const days = planDays(state, [DATE, THURSDAY]);
    let asked = 0;
    const r = await checkFillApply(state, days, () => state, async () => {
      asked++;
      return false;
    });
    expect(asked).toBe(1);
    expect(r).toMatchObject({ ok: true, state, sendEmails: false });
  });

  it("asks again when a teammate's change means more emails than agreed", async () => {
    const state = emailing(twoDays());
    const days = planDays(state, [DATE, THURSDAY]);
    // Meanwhile a teammate puts four more people on another job that day.
    const extra = ["e", "f", "g", "h"].map((id) => driver(id, ["ground_work"], { email: `${id}@example.com` }));
    const changed: AppState = {
      ...state,
      crew: [...state.crew, ...extra],
      jobs: [...state.jobs, job("jx", { title: "Other job", crewIds: ["e", "f", "g", "h"], startTime: "08:00" })],
    };
    const firstTotal = fillEmail(state, days).total;
    const newTotal = fillEmail(changed, days).total;
    expect(newTotal).toBeGreaterThan(Math.max(firstTotal, 3));
    let calls = 0;
    const asked: number[] = [];
    const r = await checkFillApply(state, days, () => (calls++ === 0 ? state : changed), async (total) => {
      asked.push(total);
      return asked.length === 1 && firstTotal > 3;
    });
    // The last question is about the new, bigger number, and "no" means no emails.
    expect(asked[asked.length - 1]).toBe(newTotal);
    expect(r).toMatchObject({ ok: true, state: changed, sendEmails: false });
    if (r.ok) expect(r.email.total).toBe(newTotal);
  });

  it("does not ask again when the count did not grow", async () => {
    const state = emailing(twoDays());
    const days = planDays(state, [DATE, THURSDAY]);
    const asked: number[] = [];
    const r = await checkFillApply(state, days, () => state, async (total) => {
      asked.push(total);
      return true;
    });
    const total = fillEmail(state, days).total;
    expect(asked).toEqual(total > 3 ? [total] : []);
    expect(r).toMatchObject({ ok: true, sendEmails: total > 0 });
  });

  it("an out-of-date preview stops before any question", async () => {
    const state = twoDays();
    const days = planDays(state, [DATE]);
    const changed = { ...state, jobs: state.jobs.map((j) => (j.id === "j1" ? { ...j, crewIds: ["a"] } : j)) };
    let asked = 0;
    const r = await checkFillApply(state, days, () => changed, async () => {
      asked++;
      return true;
    });
    expect(r.ok).toBe(false);
    expect(asked).toBe(0);
  });
});

describe("Fill the next 6 days: usually off (business rule)", () => {
  it("never places someone usually off that weekday, and counts only who can go", () => {
    // DATE is a Wednesday: "d" works Mon, Tue, Thu, Fri.
    const state = baseState({
      ...twoDays(),
      crew: [...crew().filter((c) => c.id !== "d"), driver("d", ["climbing"], { availableWeekdays: [1, 2, 4, 5] })],
    });
    const days = planDays(state, [DATE, THURSDAY]);
    const wed = days.find((d) => d.day === DATE)!;
    for (const pt of Object.values(wed.patches)) expect(pt.crewIds).not.toContain("d");
    expect(wed.available).toBe(3);
    // Thursday is one of their days: they can be filled.
    const thu = days.find((d) => d.day === THURSDAY)!;
    expect(thu.available).toBe(4);
  });

  it("a usually-off person put on a multi-day job by hand stays on it on a later day", () => {
    const state = baseState({
      crew: [...crew().filter((c) => c.id !== "d"), driver("d", ["climbing"], { availableWeekdays: [2] })],
      equipment: [equip("t1", "Truck"), equip("t2", "Truck")],
      jobs: [
        job("big", { title: "Big removal", value: 9000, date: "2026-11-17", endDate: THURSDAY, crewIds: ["a", "d"] }),
        job("new", { title: "Elm trim", value: 900 }),
      ],
    });
    const [wed] = planDays(state, [DATE]);
    expect(wed.day).toBe(DATE);
    expect(wed.patches.big.crewIds).toEqual(expect.arrayContaining(["a", "d"]));
    expect(wed.patches.new.crewIds).not.toContain("d");
  });
});
