/**
 * "✨ Fill the next 6 days" on the plan board, in three steps
 * (agreed rule):
 *
 * 1. Preview: the days are planned in memory only. fillPreview() says,
 *    day by day, who goes to which job with which trucks, the start
 *    times, what changes compared with now, and what is left unplanned
 *    and why. fillEmail() says whether Apply would email the crew (only
 *    when the owner's "Email everyone their day" setting is on) and
 *    whether the two-step confirm is needed (more than 3 emails).
 * 2. Apply: before saving, fillUndoSnapshot() keeps each touched job's
 *    crew, start time, arrival times, equipment and drivers.
 * 3. Undo (10 minutes): planUndo() puts each job back through the normal
 *    "Save day" path (so the audit log and history are written), but
 *    skips any job that changed after Apply, so nobody's later change
 *    is overwritten.
 *
 * Pure code (no saving here), unit tested in __tests__/fillPreview.test.ts.
 */
import { useSyncExternalStore } from "react";
import type { DayBoardPatch } from "../store";
import type { AppState, Job, PlannerSettings } from "../types";
import { dayPlanEmailCount, emailCrewOnSave } from "../dayPlanEmail";
import { needsDoubleConfirm } from "../doubleConfirm";
import { addDaysISO } from "../utils";
import {
  autoFillInput,
  autoPlanDay,
  boardJobs,
  boardPatchJob,
  boardSnapshot,
  dayNeedsPlan,
  nextWorkDays,
  savedRoutes,
  time12,
  weekdayShort,
} from "./board";
import { coverageProblems, driverProblems, type MeetInput } from "./meetup";
import { parseHHMM } from "./settings";

/** How long Undo is offered after Apply. */
export const UNDO_MS = 10 * 60 * 1000;

/** One day the fill would save. */
export interface FillDay {
  day: string;
  patches: Record<string, DayBoardPatch>;
  /** The "plan applied" audit snapshot for this day. */
  snapshot: string;
  finishMin: number;
  /** Jobs not finished that day. */
  unfinished: string[];
  /** job id -> plain problems ("needs 1 climber, has 0", "no legal driver"). */
  problems: Record<string, string[]>;
  /** Field crew Fill may place that day. */
  available: number;
  /** Smallest team (nobody works alone). */
  minTeam: number;
}

/** A day in the range that Fill leaves alone, and why. */
export interface FillSkip {
  day: string;
  why: string;
}

/** The parts of a job Fill (and Undo) touch. */
export interface JobFields {
  date: string;
  crewIds: string[];
  startTime: string;
  crewArrivals: Record<string, string> | null;
  equipmentIds: string[];
  equipmentDrivers: Record<string, string> | null;
}

export function jobFields(j: Job): JobFields {
  const rec = (r: Record<string, string> | null | undefined) => (r && Object.keys(r).length > 0 ? { ...r } : null);
  return {
    date: j.date,
    crewIds: [...j.crewIds],
    startTime: j.startTime,
    crewArrivals: rec(j.crewArrivals),
    equipmentIds: [...(j.equipmentIds ?? [])],
    equipmentDrivers: rec(j.equipmentDrivers),
  };
}

/** Same crew, time, arrivals, equipment and drivers (order of lists and keys ignored). */
export function sameFields(a: JobFields, b: JobFields): boolean {
  const key = (f: JobFields) =>
    JSON.stringify([
      f.date,
      [...f.crewIds].sort(),
      f.startTime,
      Object.entries(f.crewArrivals ?? {}).sort((x, y) => x[0].localeCompare(y[0])),
      [...f.equipmentIds].sort(),
      Object.entries(f.equipmentDrivers ?? {}).sort((x, y) => x[0].localeCompare(y[0])),
    ]);
  return key(a) === key(b);
}

/**
 * Why Fill leaves a day of the range alone, or null when it plans it.
 * `boardDirty`: the board's own day has unsaved changes.
 */
export function fillSkipReason(
  state: AppState,
  day: string,
  opts: { today: string; boardDate: string; boardDirty: boolean },
): string | null {
  if (day < opts.today) return "in the past";
  if (day === opts.boardDate && opts.boardDirty) return "this day has unsaved changes on the board";
  if (boardJobs(state, day).length === 0) return "no jobs";
  if (!dayNeedsPlan(state, day)) return "already planned (Fill never replaces a plan)";
  return null;
}

/** The days of the range Fill skips: Sundays, past days, days with no jobs, days already planned. */
export function fillSkippedDays(
  state: AppState,
  boardDate: string,
  opts: { today: string; boardDirty: boolean },
): { plan: string[]; skipped: FillSkip[] } {
  const work = nextWorkDays(boardDate);
  const skipped: FillSkip[] = [];
  const plan: string[] = [];
  const last = work[work.length - 1];
  for (let d = boardDate; d <= last; d = addDaysISO(d, 1)) {
    if (!work.includes(d)) {
      skipped.push({ day: d, why: "Sunday (no work on Sundays)" });
      continue;
    }
    const why = fillSkipReason(state, d, { ...opts, boardDate });
    if (why) skipped.push({ day: d, why });
    else plan.push(d);
  }
  return { plan, skipped };
}

/**
 * Plan one day of the fill in memory (✨ Auto-fill with trucks), or say
 * why the day is skipped. A multi-day job that started earlier keeps its
 * crew (autoPlanDay); unavailable people are never in `meet`; with fewer
 * people than the smallest team the day is skipped, so nobody is sent
 * out alone.
 */
export function planFillDay(state: AppState, day: string, dayJobs: Job[], meet: MeetInput): FillDay | { skip: string } {
  if (!dayNeedsPlan(state, day)) {
    const cont = dayJobs.filter((j) => j.date < day && j.crewIds.length > 0).map((j) => j.title);
    return {
      skip:
        cont.length > 0
          ? `${cont.join(", ")} continue${cont.length === 1 ? "s" : ""} with the same crew (multi-day job)`
          : "already planned",
    };
  }
  const available = autoFillInput(state, meet).people.length;
  if (available === 0) return { skip: "nobody is available that day" };
  const continuing = dayJobs.some((j) => j.date < day && j.crewIds.length > 0);
  if (available < meet.minTeam && !continuing) {
    return { skip: `only ${available} person available and nobody works alone (teams of ${meet.minTeam} or more)` };
  }
  const plan = autoPlanDay(state, day, dayJobs, meet);
  if (!plan) return { skip: "nobody is available that day" };
  const problems: Record<string, string[]> = {};
  for (const c of coverageProblems(meet, plan.fill.sim)) (problems[c.jobId] ??= []).push(c.text);
  for (const id of driverProblems(meet, plan.fill.routes)) (problems[id] ??= []).push("the team has no legal driver");
  return {
    day,
    patches: plan.patches,
    snapshot: boardSnapshot(meet, plan.fill.routes, plan.fill.routes, { week: true }),
    finishMin: plan.finishMin,
    unfinished: plan.fill.sim.unfinished,
    problems,
    available,
    minTeam: meet.minTeam,
  };
}

/** The state after the fill is saved, day by day, by exactly the "Save day" rules. */
export function applyFill(state: AppState, days: FillDay[]): AppState {
  let s = state;
  for (const d of days) {
    s = { ...s, jobs: s.jobs.map((j) => boardPatchJob(s, j, d.patches[j.id], d.day) ?? j) };
  }
  return s;
}

// ---------------------------------------------------------------- preview

export interface PreviewJob {
  jobId: string;
  title: string;
  /** "7:20 AM" (the first arrival). */
  start: string;
  startMin: number;
  /** "Ann", or "Bo (from 9:40 AM)" for someone who joins later. */
  crew: string[];
  /** "Truck A (Ann)", "Chipper" */
  equipment: string[];
  /** What changes on the job compared with now; empty = nothing. */
  changes: string[];
  /** A multi-day job already shown on an earlier day of this fill. */
  continues: boolean;
  /** Left unplanned or not finished, and why. */
  warnings: string[];
}

export interface PreviewDay {
  day: string;
  /** "Mon Nov 16" */
  label: string;
  summary: string;
  jobs: PreviewJob[];
}

export interface FillPreview {
  days: PreviewDay[];
  skipped: Array<FillSkip & { label: string }>;
  /** Everything left unplanned or not finished: "Tue: Oak trim: nobody is available that day". */
  unplanned: string[];
  /** Jobs whose crew, time or equipment would change. */
  changedJobs: number;
}

export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${weekdayShort(day)} ${mon} ${d.getDate()}`;
}

const list = (xs: string[]) => (xs.length > 0 ? xs.join(", ") : "nobody");

/** Plain lines for what changes on one job, before -> after. */
export function jobChanges(state: AppState, before: JobFields, after: JobFields): string[] {
  const name = (id: string) => state.crew.find((c) => c.id === id)?.name ?? "(someone)";
  const eqName = (id: string) => state.equipment.find((e) => e.id === id)?.name ?? "(equipment)";
  const out: string[] = [];
  const added = after.crewIds.filter((id) => !before.crewIds.includes(id));
  const removed = before.crewIds.filter((id) => !after.crewIds.includes(id));
  if (added.length > 0 || removed.length > 0) {
    out.push(`Crew: ${list(before.crewIds.map(name))} → ${list(after.crewIds.map(name))}`);
  }
  if (before.startTime !== after.startTime) {
    const t = (hhmm: string) => {
      const m = parseHHMM(hhmm);
      return m == null ? hhmm || "no time" : time12(m);
    };
    out.push(`Start: ${t(before.startTime)} → ${t(after.startTime)}`);
  }
  const eqBefore = [...before.equipmentIds].sort();
  const eqAfter = [...after.equipmentIds].sort();
  if (JSON.stringify(eqBefore) !== JSON.stringify(eqAfter)) {
    const l = (ids: string[]) => (ids.length > 0 ? ids.map(eqName).join(", ") : "none");
    out.push(`Equipment: ${l(before.equipmentIds)} → ${l(after.equipmentIds)}`);
  }
  const drv = (r: Record<string, string> | null) =>
    Object.entries(r ?? {})
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([eq, pid]) => `${eqName(eq)}: ${name(pid)}`);
  if (JSON.stringify(drv(before.equipmentDrivers)) !== JSON.stringify(drv(after.equipmentDrivers))) {
    const d = drv(after.equipmentDrivers);
    out.push(`Drivers: ${d.length > 0 ? d.join(", ") : "none"}`);
  }
  const arr = (r: Record<string, string> | null) => JSON.stringify(Object.entries(r ?? {}).sort((a, b) => a[0].localeCompare(b[0])));
  if (arr(before.crewArrivals) !== arr(after.crewArrivals)) {
    out.push(after.crewArrivals ? "Arrival times set for each person" : "Arrival times cleared");
  }
  return out;
}

/** Why a job is left with nobody, in plain words. */
function unplannedWhy(d: FillDay): string {
  if (d.available === 0) return "nobody is available that day";
  if (d.available < d.minTeam)
    return `only ${d.available} person available and nobody works alone (teams of ${d.minTeam} or more)`;
  return `not enough crew left that day for another team of ${d.minTeam}`;
}

/** The preview: day by day, what Apply would save. Nothing is saved. */
export function fillPreview(state: AppState, days: FillDay[], skipped: FillSkip[] = []): FillPreview {
  const after = applyFill(state, days);
  const name = (id: string) => state.crew.find((c) => c.id === id)?.name ?? "(someone)";
  const eqName = (id: string) => state.equipment.find((e) => e.id === id)?.name ?? "(equipment)";
  const seen = new Set<string>();
  const unplanned: string[] = [];
  const changed = new Set<string>();
  const out: PreviewDay[] = [];
  for (const d of days) {
    const jobs: PreviewJob[] = [];
    for (const jobId of Object.keys(d.patches)) {
      const b = state.jobs.find((j) => j.id === jobId);
      const a = after.jobs.find((j) => j.id === jobId);
      if (!b || !a) continue;
      const fa = jobFields(a);
      const changes = jobChanges(state, jobFields(b), fa);
      if (changes.length > 0) changed.add(jobId);
      const warnings: string[] = [];
      if (fa.crewIds.length === 0) warnings.push(`Left unplanned: ${unplannedWhy(d)}`);
      else if (fa.crewIds.length === 1 && d.minTeam > 1) warnings.push("Only 1 person on it");
      if (fa.crewIds.length > 0 && d.unfinished.includes(jobId)) warnings.push("Not finished that day: it needs more time or more people");
      for (const p of d.problems[jobId] ?? []) warnings.push(p);
      for (const w of warnings) unplanned.push(`${weekdayShort(d.day)}: ${a.title}: ${w}`);
      const eqDrivers = fa.equipmentDrivers ?? {};
      const at = Object.values(fa.crewArrivals ?? {}).sort()[0] ?? fa.startTime;
      const startMin = parseHHMM(at);
      jobs.push({
        jobId,
        title: a.title,
        start: startMin == null ? at : time12(startMin),
        startMin: startMin ?? 24 * 60,
        // People who join later show when they get there.
        crew: fa.crewIds.map((id) => {
          const m = parseHHMM(fa.crewArrivals?.[id]);
          return m != null && startMin != null && m > startMin ? `${name(id)} (from ${time12(m)})` : name(id);
        }),
        equipment: fa.equipmentIds.map((id) => (eqDrivers[id] ? `${eqName(id)} (${name(eqDrivers[id])})` : eqName(id))),
        changes: seen.has(jobId) ? [] : changes,
        continues: seen.has(jobId),
        warnings,
      });
      seen.add(jobId);
    }
    jobs.sort((x, y) => x.startMin - y.startMin || x.title.localeCompare(y.title));
    const n = jobs.length;
    const jobsText = `${n} job${n === 1 ? "" : "s"}`;
    out.push({
      day: d.day,
      label: dayLabel(d.day),
      summary:
        d.unfinished.length > 0
          ? `${jobsText}, ${d.unfinished.length} not finished that day`
          : `${jobsText}, done about ${time12(d.finishMin)}`,
      jobs,
    });
  }
  return {
    days: out,
    skipped: skipped.map((s) => ({ ...s, label: dayLabel(s.day) })),
    unplanned,
    changedJobs: changed.size,
  };
}

// ---------------------------------------------------------------- emails

export interface FillEmail {
  /** The owner's "Email everyone their day" setting. Off = Fill emails nobody. */
  on: boolean;
  /** day -> people emailed that day (0 for a day where nothing changes). */
  perDay: Record<string, number>;
  total: number;
  /** More than 3 emails: Apply goes through the two "are you sure" steps. */
  needsConfirm: boolean;
}

/** Who Apply would email. Nothing at all unless the setting is on. */
export function fillEmail(
  state: AppState,
  days: FillDay[],
  planner: PlannerSettings | null | undefined = state.settings.planner,
): FillEmail {
  const on = emailCrewOnSave(planner);
  const perDay: Record<string, number> = {};
  if (!on) return { on, perDay, total: 0, needsConfirm: false };
  let s = state;
  for (const d of days) {
    const next = { ...s, jobs: s.jobs.map((j) => boardPatchJob(s, j, d.patches[j.id], d.day) ?? j) };
    // "Save day" only emails when the save changed something.
    const changes = s.jobs.some((j) => boardPatchJob(s, j, d.patches[j.id], d.day) !== null);
    perDay[d.day] = changes ? dayPlanEmailCount(d.day, next.jobs, next.crew) : 0;
    s = next;
  }
  const total = Object.values(perDay).reduce((a, b) => a + b, 0);
  return { on, perDay, total, needsConfirm: needsDoubleConfirm(total) };
}

/**
 * True when a job in the fill changed between the preview and Apply
 * (someone saved it meanwhile): the preview is out of date.
 */
export function previewOutOfDate(previewState: AppState, current: AppState, days: FillDay[]): boolean {
  const ids = new Set(days.flatMap((d) => Object.keys(d.patches)));
  for (const id of ids) {
    const a = previewState.jobs.find((j) => j.id === id);
    const b = current.jobs.find((j) => j.id === id);
    if (!a || !b || !sameFields(jobFields(a), jobFields(b)) || a.status !== b.status) return true;
  }
  return false;
}

export type FillApplyCheck =
  | { ok: false }
  | { ok: true; state: AppState; email: FillEmail; sendEmails: boolean };

/**
 * The checks "Apply" makes before saving a Fill: the preview is still
 * current, then (for more than 3 emails) the two "are you sure" steps,
 * then the preview is checked AGAIN against the latest state, because a
 * teammate may have saved one of the jobs while the dialog was open.
 * The email count is also worked out again from the latest state; if it
 * grew past what was agreed (and past 3), the office is asked again.
 * The returned state and email count are the latest ones.
 */
export async function checkFillApply(
  base: AppState,
  days: FillDay[],
  getState: () => AppState | null,
  confirmEmails: (total: number) => Promise<boolean>,
): Promise<FillApplyCheck> {
  const before = getState();
  if (!before || previewOutOfDate(base, before, days)) return { ok: false };
  const first = fillEmail(before, days);
  let sendEmails = first.on && first.total > 0;
  if (sendEmails && first.needsConfirm) sendEmails = await confirmEmails(first.total);
  // The most emails the office has agreed to (3 or fewer need no question).
  let agreed = sendEmails ? first.total : 0;
  // A teammate may have added people to another job on a filled day
  // meanwhile, so the email count is worked out again from the latest
  // state. More than agreed (and more than 3): ask again.
  for (let round = 0; round < 5; round++) {
    const latest = getState();
    if (!latest || previewOutOfDate(base, latest, days)) return { ok: false };
    const email = fillEmail(latest, days);
    if (!sendEmails || email.total === 0) {
      return { ok: true, state: latest, email, sendEmails: false };
    }
    if (!email.needsConfirm || email.total <= agreed) {
      return { ok: true, state: latest, email, sendEmails: true };
    }
    sendEmails = await confirmEmails(email.total);
    agreed = sendEmails ? email.total : 0;
  }
  return { ok: false };
}

// ---------------------------------------------------------------- undo

export interface FillUndo {
  appliedAt: number;
  expiresAt: number;
  days: string[];
  /** The crew were emailed the filled plan (Undo sends no emails). */
  emailed: boolean;
  jobs: Array<{ jobId: string; title: string; day: string; before: JobFields; after: JobFields }>;
}

/** Taken just before Apply: each job the fill changes, as it is now and as it will be. */
export function fillUndoSnapshot(state: AppState, days: FillDay[], now: number, emailed = false): FillUndo {
  const jobs: FillUndo["jobs"] = [];
  const after = applyFill(state, days);
  for (const j of state.jobs) {
    const a = after.jobs.find((x) => x.id === j.id);
    if (!a) continue;
    const before = jobFields(j);
    const af = jobFields(a);
    if (sameFields(before, af)) continue;
    // The first day of the fill that touches the job: Undo saves it on that day.
    const day = days.find((d) => d.patches[j.id])?.day ?? j.date;
    jobs.push({ jobId: j.id, title: j.title, day, before, after: af });
  }
  return { appliedAt: now, expiresAt: now + UNDO_MS, days: days.map((d) => d.day), emailed, jobs };
}

export interface UndoPlan {
  /** day -> patches for saveDayBoard. */
  byDay: Record<string, Record<string, DayBoardPatch>>;
  restored: string[];
  /** Jobs left as they are now, and why. */
  skipped: Array<{ title: string; why: string }>;
  /** People who could not be put back (unavailable now). */
  blocked: string[];
}

/** What Undo saves. Null when the 10 minutes are over. */
export function planUndo(current: AppState, undo: FillUndo, now: number): UndoPlan | null {
  if (now > undo.expiresAt) return null;
  const plan: UndoPlan = { byDay: {}, restored: [], skipped: [], blocked: [] };
  for (const u of undo.jobs) {
    const cur = current.jobs.find((j) => j.id === u.jobId);
    if (!cur) {
      plan.skipped.push({ title: u.title, why: "it was deleted after Fill" });
      continue;
    }
    if (!sameFields(jobFields(cur), u.after)) {
      plan.skipped.push({ title: u.title, why: "it was changed after Fill, so that change is kept" });
      continue;
    }
    const patch: DayBoardPatch = {
      crewIds: [...u.before.crewIds],
      startTime: u.before.startTime,
      crewArrivals: u.before.crewArrivals,
      equipmentIds: [...u.before.equipmentIds],
      equipmentDrivers: u.before.equipmentDrivers,
    };
    const res = boardPatchJob(current, cur, patch, u.day);
    const missing = u.before.crewIds.filter((id) => !(res ?? cur).crewIds.includes(id));
    for (const id of missing) {
      const n = current.crew.find((c) => c.id === id)?.name ?? "Someone";
      plan.blocked.push(`${n} could not be put back on ${u.title} (not available that day)`);
    }
    (plan.byDay[u.day] ??= {})[u.jobId] = patch;
    plan.restored.push(u.title);
  }
  return plan;
}

/** The "plan applied" audit snapshot for an Undo: what the day holds after it. */
export function undoSnapshot(stateAfter: AppState, day: string): string {
  return JSON.stringify({
    v: 2,
    board: true,
    suggested: null,
    saved: savedRoutes(stateAfter, boardJobs(stateAfter, day)),
    undo: "fill",
  });
}

/** Whole minutes left to undo (rounded up), 0 when over. */
export function undoMinutesLeft(undo: FillUndo, now: number): number {
  return Math.max(0, Math.ceil((undo.expiresAt - now) / 60000));
}

// ---------------------------------------------------------------- the open Undo

/** The last fill's Undo, kept while the app is open (survives switching days or screens). */
let openUndo: FillUndo | null = null;
const listeners = new Set<() => void>();

export function setFillUndo(u: FillUndo | null): void {
  openUndo = u;
  for (const l of listeners) l();
}

export function getFillUndo(): FillUndo | null {
  return openUndo;
}

export function useFillUndo(): FillUndo | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getFillUndo,
    getFillUndo,
  );
}
