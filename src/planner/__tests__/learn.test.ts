import { describe, expect, it } from "vitest";
import type { AuditEntry, TimesheetEntry } from "../../types";
import {
  learnRates,
  median,
  planDays,
  planSuggestions,
  rateSamples,
  rateSuggestions,
  skillSuggestions,
  pairSuggestions,
  lastResortSuggestions,
  workDollars,
} from "../learn";
import { resolvePlannerSettings } from "../settings";
import { baseState, equip, job, person } from "./fixtures";

const TODAY = "2026-11-14";

let n = 0;
const ts = (crewId: string, jobId: string, date: string, clockIn: string, clockOut: string): TimesheetEntry => ({
  id: `t${++n}`,
  crewId,
  jobId,
  date,
  clockIn,
  clockOut,
  hours: null,
  notes: "",
  location: "",
});

const audit = (over: Partial<AuditEntry>): AuditEntry => ({
  id: `a${++n}`,
  timestamp: "2026-11-01T15:00:00.000Z",
  actor: "Owner",
  entity: "Job",
  entityId: "",
  entityLabel: "",
  field: "crew",
  oldValue: "",
  newValue: "",
  customerId: null,
  ...over,
});

const planEntry = (date: string, suggested: Record<string, string[]> | null, saved: Record<string, string[]>, at?: string) =>
  audit({
    timestamp: at ?? `${date}T14:00:00.000Z`,
    entity: "Day plan",
    entityId: date,
    field: "plan applied",
    newValue: JSON.stringify({ v: 2, board: true, suggested, saved, rate: [400, 3, 2] }),
  });

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("rate check", () => {
  const S = resolvePlannerSettings(null); // $400, full speed 3
  // Three trimming jobs: 2 people 8:00-12:00 on $2,000 = $500/h each.
  // One stump job: 1 person 2 h on $800 = $400/h... plus two more stump jobs.
  const jobs = [
    job("t1", { status: "done", date: "2026-10-01", value: 2000 }),
    job("t2", { status: "done", date: "2026-10-02", value: 2000 }),
    job("t3", { status: "done", date: "2026-10-03", value: 2000 }),
    job("s1", { status: "done", date: "2026-10-04", value: 1600, serviceType: "Stump Grinding" }),
    job("s2", { status: "done", date: "2026-10-05", value: 1600, serviceType: "Stump Grinding" }),
    job("s3", { status: "done", date: "2026-10-06", value: 1600, serviceType: "Stump Grinding" }),
    // Not counted: not done, too old, no value, no clock times.
    job("open", { status: "scheduled", date: "2026-10-07", value: 2000 }),
    job("old", { status: "done", date: "2026-06-01", value: 2000 }),
    job("free", { status: "done", date: "2026-10-08", value: 0 }),
    job("manual", { status: "done", date: "2026-10-09", value: 2000 }),
  ];
  const timesheets = [
    ...["t1", "t2", "t3"].flatMap((id, i) => [
      ts("a", id, `2026-10-0${i + 1}`, "08:00", "12:00"),
      ts("b", id, `2026-10-0${i + 1}`, "08:30", "11:00"),
    ]),
    // Stump: 2 h each = $800/h.
    ...["s1", "s2", "s3"].map((id, i) => ts("a", id, `2026-10-0${i + 4}`, "13:00", "15:00")),
    ts("a", "open", "2026-10-07", "08:00", "12:00"),
    ts("a", "old", "2026-06-01", "08:00", "12:00"),
    ts("a", "free", "2026-10-08", "08:00", "12:00"),
    { ...ts("a", "manual", "2026-10-09", "", ""), clockIn: null, clockOut: null, hours: 4 },
  ];
  const state = baseState({ jobs, timesheets });

  it("uses first clock-in to last clock-out and only finished, valued, recent jobs", () => {
    const samples = rateSamples(state, S, TODAY);
    expect(samples.map((s) => s.jobId).sort()).toEqual(["s1", "s2", "s3", "t1", "t2", "t3"]);
    expect(samples.find((s) => s.jobId === "t1")!.rate).toBe(500);
    expect(samples.find((s) => s.jobId === "s1")!.rate).toBe(800);
  });

  it("weights extra people by n / fullSpeedCrew", () => {
    const six = baseState({
      jobs: [job("big", { status: "done", date: "2026-10-01", value: 4800 })],
      timesheets: ["a", "b", "c", "d", "e", "f"].map((p) => ts(p, "big", "2026-10-01", "08:00", "14:00")),
    });
    // 6 h × (6 / 3) = 12 crew-hours → $400/h.
    expect(rateSamples(six, S, TODAY)[0].rate).toBe(400);
  });

  it("adds up the days of a multi-day job", () => {
    const multi = baseState({
      jobs: [job("m", { status: "done", date: "2026-10-01", endDate: "2026-10-02", value: 3000 })],
      timesheets: [ts("a", "m", "2026-10-01", "08:00", "13:00"), ts("a", "m", "2026-10-02", "08:00", "13:00")],
    });
    expect(rateSamples(multi, S, TODAY)[0].rate).toBe(300);
  });

  it("medians overall and per service (15%+ apart, 3+ jobs), then suggests", () => {
    const learned = learnRates(rateSamples(state, S, TODAY));
    // Rates 500,500,500,800,800,800 → median 650.
    expect(learned.overall).toEqual({ rate: 650, jobs: 6 });
    expect(learned.byService.map((x) => [x.serviceType, x.rate, x.jobs])).toEqual([
      ["Stump Grinding", 800, 3],
      ["Trimming", 500, 3],
    ]);
    const sug = rateSuggestions(learned, S, null);
    expect(sug[0].text).toBe(
      "Your crews actually average about $650 an hour (from 6 jobs) — the board uses $400. Use $650?",
    );
    expect(sug[0].apply).toEqual({ type: "planner", patch: { dollarsPerHour: 650 } });
    expect(sug.find((s) => s.key === "rate:Stump Grinding:400")!.apply).toEqual({
      type: "planner",
      patch: { dollarsPerHourByService: { "Stump Grinding": 800 } },
    });
  });

  it("needs at least 3 jobs and stays quiet when the board is close", () => {
    expect(learnRates(rateSamples(state, S, TODAY).slice(0, 2)).overall).toBeNull();
    const close = resolvePlannerSettings({ dollarsPerHour: 620, dollarsPerHourByService: { "Stump Grinding": 790, Trimming: 520 } });
    expect(rateSuggestions(learnRates(rateSamples(state, close, TODAY)), close, null)).toEqual([]);
  });

  it("dismissed suggestions are not shown again", () => {
    const st = baseState({
      jobs,
      timesheets,
      settings: { ...baseState().settings, planner: { dismissedPlanSuggestions: ["rate:all:400"] } },
    });
    const keys = planSuggestions(st, resolvePlannerSettings(st.settings.planner), TODAY, { canEditCrew: true }).map((s) => s.key);
    expect(keys).not.toContain("rate:all:400");
    expect(keys).toContain("rate:Trimming:400");
  });
});

describe("workDollars", () => {
  it("converts a job's value to base-rate dollars", () => {
    const s = resolvePlannerSettings({ dollarsPerHour: 400, dollarsPerHourByService: { "Stump Grinding": 800 } });
    expect(workDollars(1600, "Stump Grinding", s)).toBe(800); // 2 h at $800 = 2 h at $400
    expect(workDollars(1600, "Trimming", s)).toBe(1600);
  });
  it("ignores bad per-service values", () => {
    const s = resolvePlannerSettings({ dollarsPerHourByService: { Trimming: -5, Removal: Number.NaN } });
    expect(s.dollarsPerHourByService).toEqual({});
  });
});

describe("learning from plan changes", () => {
  const S = resolvePlannerSettings(null);
  const crew = [
    person("ann", ["climbing"], { name: "Ann" }),
    person("bob", ["ground_work"], { name: "Bob" }),
    person("cat", ["ground_work"], { name: "Cat" }),
    person("dan", ["ground_work"], { name: "Dan" }),
  ];
  const dates = ["2026-10-20", "2026-10-21", "2026-10-22"];
  const jobs = dates.flatMap((d) => [
    job(`stump-${d}`, { date: d, serviceType: "Stump Grinding" }),
    job(`trim-${d}`, { date: d }),
  ]);

  it("replays crew edits made after the save", () => {
    const d = dates[0];
    const st = baseState({
      crew,
      jobs,
      auditLog: [
        planEntry(d, null, { ann: [`trim-${d}`], bob: [`trim-${d}`] }),
        audit({ entityId: `trim-${d}`, timestamp: `${d}T15:00:00.000Z`, oldValue: "Bob", newValue: "removed" }),
        audit({ entityId: `trim-${d}`, timestamp: `${d}T15:01:00.000Z`, newValue: "added Cat" }),
        // Before the save, and a different job: ignored.
        audit({ entityId: `trim-${d}`, timestamp: `${d}T13:00:00.000Z`, newValue: "added Dan" }),
      ],
    });
    const days = planDays(st, TODAY);
    expect(days).toHaveLength(1);
    expect([...days[0].final.get(`trim-${d}`)!].sort()).toEqual(["ann", "cat"]);
  });

  it("(a) suggests ticking a skill the owner keeps relying on", () => {
    const st = baseState({
      crew,
      jobs,
      auditLog: dates.map((d) => planEntry(d, { bob: [`trim-${d}`] }, { bob: [`stump-${d}`] })),
    });
    const sug = skillSuggestions(st, planDays(st, TODAY), S);
    expect(sug).toHaveLength(1);
    expect(sug[0].key).toBe("skill:bob:stump_grinding");
    expect(sug[0].text).toContain('"Stump grinding" isn\'t ticked');
    expect(sug[0].apply).toEqual({
      type: "crew",
      updates: [{ ...crew[1], skills: ["ground_work", "stump_grinding"] }],
    });
  });

  it("(a) counts equipment skills, but not jobs auto-fill placed them on", () => {
    const st = baseState({
      crew,
      equipment: [equip("chip", "Chipper")],
      jobs: jobs.map((j) => ({ ...j, equipmentIds: ["chip"] })),
      auditLog: dates.map((d) => planEntry(d, { cat: [`trim-${d}`] }, { cat: [`trim-${d}`], dan: [`trim-${d}`] })),
    });
    const keys = skillSuggestions(st, planDays(st, TODAY), S).map((s) => s.key);
    expect(keys).toEqual(["skill:dan:chipper"]);
  });

  it("(b) suggests 'works well with' for a pair auto-fill keeps splitting", () => {
    const st = baseState({
      crew,
      jobs,
      auditLog: dates.map((d) =>
        planEntry(d, { ann: [`trim-${d}`], bob: [`stump-${d}`] }, { ann: [`trim-${d}`], bob: [`trim-${d}`] }),
      ),
    });
    const sug = pairSuggestions(st, planDays(st, TODAY));
    expect(sug.map((s) => s.key)).toEqual(["pair:ann:bob"]);
    expect(sug[0].apply).toEqual({
      type: "crew",
      updates: [
        { ...crew[0], worksWellWith: ["bob"] },
        { ...crew[1], worksWellWith: ["ann"] },
      ],
    });
    // Only twice: not yet a pattern.
    const two = baseState({ ...st, auditLog: st.auditLog.slice(0, 2) });
    expect(pairSuggestions(two, planDays(two, TODAY))).toEqual([]);
    // Already marked: nothing to suggest.
    const marked = baseState({ ...st, crew: [{ ...crew[0], worksWellWith: ["bob"] }, ...crew.slice(1)] });
    expect(pairSuggestions(marked, planDays(marked, TODAY))).toEqual([]);
  });

  it("(c) suggests 'only when needed' for someone the owner keeps taking off", () => {
    const st = baseState({
      crew,
      jobs,
      auditLog: dates.map((d) => planEntry(d, { ann: [`trim-${d}`], dan: [`stump-${d}`] }, { ann: [`trim-${d}`] })),
    });
    const sug = lastResortSuggestions(st, planDays(st, TODAY));
    expect(sug.map((s) => s.key)).toEqual(["lastResort:dan"]);
    expect(sug[0].text).toContain("3 of 3 days");
    expect(sug[0].apply).toEqual({ type: "crew", updates: [{ ...crew[3], lastResort: true }] });
  });

  it("(c) needs the removals to be at least half the days auto-fill placed them", () => {
    const more = ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];
    const st = baseState({
      crew,
      jobs,
      auditLog: [
        ...dates.map((d) => planEntry(d, { dan: [`stump-${d}`] }, {})),
        ...more.map((d) => planEntry(d, { dan: [`x-${d}`] }, { dan: [`x-${d}`] })),
      ],
    });
    expect(lastResortSuggestions(st, planDays(st, TODAY))).toEqual([]);
  });

  it("ignores plans older than 60 days and the old v1 snapshots", () => {
    const st = baseState({
      crew,
      jobs,
      auditLog: [
        ...dates.map((d) => planEntry(d, { dan: ["x"] }, {}, "2026-08-01T10:00:00.000Z")),
        audit({ entity: "Day plan", entityId: "2026-11-01", field: "plan applied", newValue: JSON.stringify({ v: 1, crews: [] }) }),
      ],
    });
    expect(planDays(st, TODAY)).toEqual([]);
  });

  it("crew suggestions only for people who may edit crew", () => {
    const st = baseState({
      crew,
      jobs,
      auditLog: dates.map((d) => planEntry(d, { ann: [`trim-${d}`], dan: [`stump-${d}`] }, { ann: [`trim-${d}`] })),
    });
    const s = resolvePlannerSettings(null);
    expect(planSuggestions(st, s, TODAY, { canEditCrew: false })).toEqual([]);
    expect(planSuggestions(st, s, TODAY, { canEditCrew: true }).map((x) => x.key)).toEqual(["lastResort:dan"]);
  });
});
