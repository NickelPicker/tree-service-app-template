/**
 * Plan board learning: suggestions worked out from what really happened.
 *
 * 1. Rate check. The board's rule is "every dollarsPerHour of job value
 *    is 1 hour for a crew of up to fullSpeedCrew". Finished jobs with
 *    clock-in/out times say how fast crews really go: per job per day,
 *    first clock-in to last clock-out is the wall time, and n people on
 *    it count as max(1, n / fullSpeedCrew) crews. The median over jobs
 *    (overall, and per service type) becomes "Use $X?".
 *
 * 2. Plan changes. Every Save day writes a "plan applied" audit entry
 *    (v2, board) with what ✨ Auto-fill suggested and what was saved;
 *    later crew edits on those jobs are replayed on top. Patterns seen
 *    3+ times in 60 days become one-tap suggestions: tick a skill, mark
 *    two people as working well together, or "only when needed".
 *
 * Everything here is pure: the panel (src/components/PlanInsights.tsx)
 * shows the list and applies the patch the owner taps.
 */
import { jobValue } from "../jobValue";
import { personSkills, EQUIPMENT_SKILL } from "./input";
import { parseHHMM, type ResolvedPlannerSettings } from "./settings";
import type { Routes } from "./meetup";
import { skillCatalog } from "../skills";
import { addDaysISO } from "../utils";
import type { AppState, AuditEntry, CrewMember, Job, PlannerSettings, ServiceType } from "../types";

export const RATE_WINDOW_DAYS = 120;
export const PLAN_WINDOW_DAYS = 60;
/** Fewest jobs (rates) or occurrences (plan patterns) before anything is suggested. */
export const MIN_SAMPLES = 3;
/** The overall rate is suggested when it is this far from the board's (10%). */
export const RATE_CHANGE_PCT = 0.1;
/** A service type gets its own rate when it is this far from the overall (15%). */
export const SERVICE_DIFF_PCT = 0.15;

// ---------------------------------------------------------------- rates

/**
 * Board dollars for a job: its value converted to the base rate, so a
 * service with its own (faster or slower) rate takes the right time
 * when the board simulates at settings.dollarsPerHour.
 */
export function workDollars(
  value: number,
  serviceType: ServiceType | string,
  s: Pick<ResolvedPlannerSettings, "dollarsPerHour" | "dollarsPerHourByService">,
): number {
  const own = s.dollarsPerHourByService[serviceType as ServiceType];
  if (!own || own <= 0 || !Number.isFinite(value)) return value;
  return (value * s.dollarsPerHour) / own;
}

export interface RateSample {
  jobId: string;
  serviceType: ServiceType;
  value: number;
  /** Wall hours, each day weighted by max(1, people / fullSpeedCrew). */
  crewHours: number;
  /** Dollars per hour for a crew of up to fullSpeedCrew. */
  rate: number;
}

/** One sample per finished job (last 120 days) with a value and clocked times. */
export function rateSamples(
  state: Pick<AppState, "jobs" | "timesheets" | "invoices" | "estimates">,
  settings: Pick<ResolvedPlannerSettings, "fullSpeedCrew">,
  today: string,
): RateSample[] {
  const from = addDaysISO(today, -RATE_WINDOW_DAYS);
  const byJob = new Map<string, AppState["timesheets"]>();
  for (const t of state.timesheets) {
    if (!t.jobId) continue;
    if (!byJob.has(t.jobId)) byJob.set(t.jobId, []);
    byJob.get(t.jobId)!.push(t);
  }
  const out: RateSample[] = [];
  for (const j of state.jobs) {
    if (j.status !== "done") continue;
    const last = j.endDate && j.endDate > j.date ? j.endDate : j.date;
    if (last < from || j.date > today) continue;
    const value = jobValue(state as AppState, j) ?? 0;
    if (!(value > 0)) continue;
    const days = new Map<string, { first: number; last: number; people: Set<string> }>();
    // Any entry without real clock times (typed-in hours, still clocked in)
    // makes the job's hours unreliable: leave the whole job out.
    let unclocked = false;
    for (const t of byJob.get(j.id) ?? []) {
      const a = parseHHMM(t.clockIn);
      const b = parseHHMM(t.clockOut);
      if (a == null || b == null || b <= a) {
        unclocked = true;
        break;
      }
      const d = days.get(t.date) ?? { first: a, last: b, people: new Set<string>() };
      d.first = Math.min(d.first, a);
      d.last = Math.max(d.last, b);
      d.people.add(t.crewId);
      days.set(t.date, d);
    }
    if (unclocked) continue;
    let crewHours = 0;
    for (const d of days.values()) {
      crewHours += ((d.last - d.first) / 60) * Math.max(1, d.people.size / settings.fullSpeedCrew);
    }
    // Under 15 minutes is a mis-tap, not a job.
    if (crewHours < 0.25) continue;
    out.push({ jobId: j.id, serviceType: j.serviceType, value, crewHours, rate: value / crewHours });
  }
  return out;
}

/** Median (the middle value; the mean of the two middle ones for an even count). */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round10 = (x: number) => Math.max(50, Math.round(x / 10) * 10);

export interface LearnedRates {
  overall: { rate: number; jobs: number } | null;
  /** Service types that differ from the overall by 15%+ (3+ jobs each). */
  byService: Array<{ serviceType: ServiceType; rate: number; jobs: number }>;
}

export function learnRates(samples: RateSample[]): LearnedRates {
  if (samples.length < MIN_SAMPLES) return { overall: null, byService: [] };
  const overall = median(samples.map((s) => s.rate))!;
  const groups = new Map<ServiceType, number[]>();
  for (const s of samples) {
    if (!groups.has(s.serviceType)) groups.set(s.serviceType, []);
    groups.get(s.serviceType)!.push(s.rate);
  }
  const byService: LearnedRates["byService"] = [];
  for (const [serviceType, rates] of groups) {
    if (rates.length < MIN_SAMPLES) continue;
    const r = median(rates)!;
    if (Math.abs(r - overall) / overall < SERVICE_DIFF_PCT) continue;
    byService.push({ serviceType, rate: round10(r), jobs: rates.length });
  }
  byService.sort((a, b) => b.jobs - a.jobs || a.serviceType.localeCompare(b.serviceType));
  return { overall: { rate: round10(overall), jobs: samples.length }, byService };
}

// ---------------------------------------------------------- suggestions

export type SuggestionApply =
  | { type: "planner"; patch: Partial<PlannerSettings> }
  | { type: "crew"; updates: CrewMember[] };

export interface PlanSuggestion {
  /** Stable id; dismissing stores it in settings.planner.dismissedPlanSuggestions. */
  key: string;
  kind: "rate" | "serviceRate" | "skill" | "worksWellWith" | "lastResort";
  /** The question, in plain words. */
  text: string;
  /** Where the number came from (small print). */
  why: string;
  apply: SuggestionApply;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function rateSuggestions(
  learned: LearnedRates,
  settings: Pick<ResolvedPlannerSettings, "dollarsPerHour" | "dollarsPerHourByService">,
  saved: PlannerSettings | null | undefined,
): PlanSuggestion[] {
  const out: PlanSuggestion[] = [];
  const o = learned.overall;
  if (!o) return out;
  const board = settings.dollarsPerHour;
  // The board accepts $50–$10,000 an hour; a learned rate outside that is bad data.
  const usable = (r: number) => r >= 50 && r <= 10000;
  if (usable(o.rate) && Math.abs(o.rate - board) / board >= RATE_CHANGE_PCT) {
    out.push({
      key: `rate:all:${board}`,
      kind: "rate",
      text: `Your crews actually average about ${money(o.rate)} an hour (from ${plural(o.jobs, "job")}) — the board uses ${money(board)}. Use ${money(o.rate)}?`,
      why: `From clock-in to clock-out on finished jobs in the last ${RATE_WINDOW_DAYS} days.`,
      apply: { type: "planner", patch: { dollarsPerHour: o.rate } },
    });
  }
  for (const s of learned.byService) {
    const current = settings.dollarsPerHourByService[s.serviceType] ?? board;
    if (!usable(s.rate) || Math.abs(s.rate - current) / current < RATE_CHANGE_PCT) continue;
    out.push({
      key: `rate:${s.serviceType}:${current}`,
      kind: "serviceRate",
      text: `${s.serviceType} jobs go at about ${money(s.rate)} an hour (from ${plural(s.jobs, "job")}) — the board uses ${money(current)}. Use ${money(s.rate)} for ${s.serviceType}?`,
      why: `${s.serviceType} is ${s.rate > o.rate ? "faster" : "slower"} than your other work (${money(o.rate)} an hour overall).`,
      apply: {
        type: "planner",
        patch: { dollarsPerHourByService: { ...(saved?.dollarsPerHourByService ?? {}), [s.serviceType]: s.rate } },
      },
    });
  }
  return out;
}

/** One saved day: what auto-fill suggested (if it ran) and who really went where. */
export interface PlanDay {
  date: string;
  suggested: Routes | null;
  /** job id -> people on it after the save and any later crew edits. */
  final: Map<string, Set<string>>;
}

interface BoardSnapshot {
  v: number;
  board?: boolean;
  suggested?: Routes | null;
  saved?: Routes;
}

function parseSnapshot(s: string): BoardSnapshot | null {
  try {
    const x = JSON.parse(s) as BoardSnapshot;
    // The audit log is data anyone on staff can write: check every part.
    const isRoutes = (r: unknown): r is Routes =>
      !!r &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      Object.values(r as Record<string, unknown>).every(
        (l) => l == null || (Array.isArray(l) && l.every((j) => typeof j === "string")),
      );
    return x && x.v === 2 && x.board === true && isRoutes(x.saved) && (x.suggested == null || isRoutes(x.suggested))
      ? x
      : null;
  } catch {
    return null;
  }
}

function jobsOf(routes: Routes): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [pid, list] of Object.entries(routes)) {
    for (const jid of list ?? []) {
      if (!out.has(jid)) out.set(jid, new Set());
      out.get(jid)!.add(pid);
    }
  }
  return out;
}

/**
 * The saved days from the last 60 days (by when they were saved), one per
 * date: the last save wins, the last auto-fill that ran is "suggested",
 * and crew edits on those jobs after the save (up to the day after) are
 * replayed on top.
 */
export function planDays(
  state: Pick<AppState, "auditLog" | "crew">,
  today: string,
): PlanDay[] {
  const from = addDaysISO(today, -PLAN_WINDOW_DAYS);
  const byDate = new Map<string, { at: string; suggested: Routes | null; saved: Routes }>();
  const sorted = [...state.auditLog].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const e of sorted) {
    if (e.field !== "plan applied" || e.timestamp.slice(0, 10) < from) continue;
    const snap = parseSnapshot(e.newValue);
    if (!snap) continue;
    const prev = byDate.get(e.entityId);
    byDate.set(e.entityId, {
      at: e.timestamp,
      suggested: snap.suggested ?? prev?.suggested ?? null,
      saved: snap.saved!,
    });
  }
  // Names in crew audit entries -> ids (only names that are unique).
  const nameCount = new Map<string, number>();
  for (const c of state.crew) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
  const idByName = new Map(state.crew.filter((c) => nameCount.get(c.name) === 1).map((c) => [c.name, c.id]));
  const crewEdits = sorted.filter((e: AuditEntry) => e.entity === "Job" && e.field === "crew");

  const out: PlanDay[] = [];
  for (const [date, d] of byDate) {
    const final = jobsOf(d.saved);
    const until = addDaysISO(date, 1);
    for (const e of crewEdits) {
      if (e.timestamp <= d.at || e.timestamp.slice(0, 10) > until || !final.has(e.entityId)) continue;
      const set = final.get(e.entityId)!;
      if (e.newValue === "removed") {
        const id = idByName.get(e.oldValue);
        if (id) set.delete(id);
      } else if (e.newValue.startsWith("added ")) {
        const id = idByName.get(e.newValue.slice(6));
        if (id) set.add(id);
      }
    }
    out.push({ date, suggested: d.suggested, final });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Skill ids a job needs (service type, prune class II, equipment), as the planner reads them. */
export function jobNeededSkills(
  job: Job,
  equipmentKind: (id: string) => string | undefined,
  settings: Pick<ResolvedPlannerSettings, "defaultSkillsByService">,
): string[] {
  const s = new Set<string>(settings.defaultSkillsByService[job.serviceType] ?? []);
  if (job.pruneClass === "2") s.add("pruning");
  for (const id of job.equipmentIds ?? []) {
    const k = equipmentKind(id);
    const sk = k ? EQUIPMENT_SKILL[k as keyof typeof EQUIPMENT_SKILL] : undefined;
    if (sk) s.add(sk);
  }
  s.delete("climbing");
  s.delete("ground_work");
  return [...s].sort();
}

const activeCrew = (state: Pick<AppState, "crew">) =>
  new Map(
    state.crew
      .filter((c) => (c.status ?? "active") === "active" && !c.permissions?.hideFromSchedule)
      .map((c) => [c.id, c]),
  );

/** (a) The owner keeps putting someone on jobs that need a skill they don't have ticked. */
export function skillSuggestions(
  state: Pick<AppState, "crew" | "jobs" | "equipment" | "settings">,
  days: PlanDay[],
  settings: Pick<ResolvedPlannerSettings, "defaultSkillsByService">,
): PlanSuggestion[] {
  const crew = activeCrew(state);
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  const kinds = new Map((state.equipment ?? []).map((e) => [e.id, e.kind as string]));
  const labels = new Map(skillCatalog(state as AppState).map((s) => [s.id, s.label]));
  const seen = new Map<string, { crewId: string; skill: string; jobs: Set<string>; services: Set<string> }>();
  for (const d of days) {
    const suggestedOn = d.suggested ? jobsOf(d.suggested) : null;
    for (const [jid, people] of d.final) {
      const j = jobs.get(jid);
      if (!j) continue;
      const needs = jobNeededSkills(j, (id) => kinds.get(id), settings);
      if (needs.length === 0) continue;
      for (const pid of people) {
        if (suggestedOn?.get(jid)?.has(pid)) continue; // auto-fill put them there, not the owner
        const m = crew.get(pid);
        if (!m) continue;
        const has = new Set(personSkills(m).skills);
        for (const sk of needs) {
          if (has.has(sk) || !labels.has(sk)) continue;
          const key = `${pid}:${sk}`;
          const x = seen.get(key) ?? { crewId: pid, skill: sk, jobs: new Set(), services: new Set() };
          x.jobs.add(jid);
          x.services.add(j.serviceType);
          seen.set(key, x);
        }
      }
    }
  }
  const out: PlanSuggestion[] = [];
  for (const x of seen.values()) {
    if (x.jobs.size < MIN_SAMPLES) continue;
    const m = crew.get(x.crewId)!;
    const label = labels.get(x.skill)!;
    // Keep any skills read from the job role so ticking one loses nothing.
    const skills = [...new Set([...personSkills(m).skills, x.skill])].sort();
    out.push({
      key: `skill:${x.crewId}:${x.skill}`,
      kind: "skill",
      text: `You've put ${m.name} on ${x.jobs.size} ${[...x.services].sort().join(" / ")} jobs, but "${label}" isn't ticked for them. Tick it?`,
      why: `From your saved plans in the last ${PLAN_WINDOW_DAYS} days.`,
      apply: { type: "crew", updates: [{ ...m, skills }] },
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** (b) The owner keeps putting two people together that auto-fill split up. */
export function pairSuggestions(state: Pick<AppState, "crew">, days: PlanDay[]): PlanSuggestion[] {
  const crew = activeCrew(state);
  const count = new Map<string, Set<string>>();
  for (const d of days) {
    if (!d.suggested) continue;
    const sug = d.suggested;
    for (const people of d.final.values()) {
      const ids = [...people].sort();
      for (let i = 0; i < ids.length; i++) {
        for (let k = i + 1; k < ids.length; k++) {
          const a = sug[ids[i]] ?? [];
          const b = sug[ids[k]] ?? [];
          if (a.length === 0 || b.length === 0 || a.some((jid) => b.includes(jid))) continue;
          const key = `${ids[i]}:${ids[k]}`;
          if (!count.has(key)) count.set(key, new Set());
          count.get(key)!.add(d.date);
        }
      }
    }
  }
  const out: PlanSuggestion[] = [];
  for (const [key, dates] of count) {
    if (dates.size < MIN_SAMPLES) continue;
    const [ia, ib] = key.split(":");
    const a = crew.get(ia);
    const b = crew.get(ib);
    if (!a || !b) continue;
    if ((a.worksWellWith ?? []).includes(ib) || (b.worksWellWith ?? []).includes(ia)) continue;
    out.push({
      key: `pair:${key}`,
      kind: "worksWellWith",
      text: `You keep putting ${a.name} and ${b.name} on the same job (${plural(dates.size, "day")}) when ✨ Auto-fill split them up. Mark them as working well together?`,
      why: `From your saved plans in the last ${PLAN_WINDOW_DAYS} days.`,
      apply: {
        type: "crew",
        updates: [
          { ...a, worksWellWith: [...new Set([...(a.worksWellWith ?? []), ib])] },
          { ...b, worksWellWith: [...new Set([...(b.worksWellWith ?? []), ia])] },
        ],
      },
    });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/**
 * (c) Auto-fill keeps placing someone and the owner keeps taking them off
 * the day: 3+ days, and at least half the days auto-fill placed them.
 */
export function lastResortSuggestions(state: Pick<AppState, "crew">, days: PlanDay[]): PlanSuggestion[] {
  const crew = activeCrew(state);
  const placed = new Map<string, number>();
  const removed = new Map<string, number>();
  for (const d of days) {
    if (!d.suggested) continue;
    const onDay = new Set<string>();
    for (const people of d.final.values()) for (const p of people) onDay.add(p);
    for (const [pid, list] of Object.entries(d.suggested)) {
      if (!list || list.length === 0) continue;
      placed.set(pid, (placed.get(pid) ?? 0) + 1);
      if (!onDay.has(pid)) removed.set(pid, (removed.get(pid) ?? 0) + 1);
    }
  }
  const out: PlanSuggestion[] = [];
  for (const [pid, n] of removed) {
    const total = placed.get(pid) ?? n;
    const m = crew.get(pid);
    if (!m || m.lastResort || n < MIN_SAMPLES || n * 2 < total) continue;
    out.push({
      key: `lastResort:${pid}`,
      kind: "lastResort",
      text: `✨ Auto-fill keeps putting ${m.name} on jobs and you keep taking them off (${n} of ${plural(total, "day")}). Only use ${m.name} when needed?`,
      why: `"Only when needed" means auto-fill uses them only when a job would otherwise go short.`,
      apply: { type: "crew", updates: [{ ...m, lastResort: true }] },
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Every suggestion that has not been dismissed, most useful first: the
 * rate check, then per-service rates, then crew suggestions (only for
 * people who may change crew profiles: owners and managers).
 */
export function planSuggestions(
  state: AppState,
  settings: ResolvedPlannerSettings,
  today: string,
  opts: { canEditCrew: boolean },
): PlanSuggestion[] {
  const saved = state.settings.planner;
  const dismissed = new Set(saved?.dismissedPlanSuggestions ?? []);
  const list = rateSuggestions(learnRates(rateSamples(state, settings, today)), settings, saved);
  if (opts.canEditCrew) {
    const days = planDays(state, today);
    list.push(
      ...skillSuggestions(state, days, settings),
      ...pairSuggestions(state, days),
      ...lastResortSuggestions(state, days),
    );
  }
  return list.filter((s) => !dismissed.has(s.key));
}
