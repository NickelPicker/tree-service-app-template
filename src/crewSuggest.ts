/**
 * Automatic crew buildout: suggested crew for a job on a day.
 *
 * The owner writes the rules (Crew Rules page): each rule names the
 * crew a job needs when its condition matches — prune class, number
 * of trees, service type, a keyword in the job's title/notes
 * ("wires", "backyard"), or the number of jobs on that day
 * ("exactly 1 job that day"). A rule can also say "assign all
 * available crew" instead of fixed numbers — the one-job-day
 * built-in does exactly that. The suggestion takes the most crew
 * any matching rule asks for, then:
 * - caps the total at the estimator's expected crew for the job (set while
 *   quoting; never more than the estimator said, never shown to the customer);
 * - splits the team across the day's jobs by value (the most
 *   valuable job gets first pick — see suggestCrewForDay);
 * - prefers people who are generally available that weekday, and
 *   never suggests someone on approved time off that day or already
 *   on another job that day;
 * - prefers keeping people who work well together on the same crew;
 * - assigns a driver for each piece of equipment on the job, from
 *   the people marked as able to drive it.
 *
 * The suggestion is computed on demand, never stored: it always
 * reflects the current roster, rules and availability.
 */
import { jobValue } from "./jobValue";
import { isUnavailableOn } from "./unavailability";
import { isTimeOffOn } from "./utils";
import type { AppState, CrewMember, CrewRule, Estimate, Job } from "./types";

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday (0 = Sunday … 6 = Saturday) of a YYYY-MM-DD date, local. */
export function weekdayOf(date: string): number {
  return new Date(
    parseInt(date.slice(0, 4), 10),
    parseInt(date.slice(5, 7), 10) - 1,
    parseInt(date.slice(8, 10), 10),
  ).getDay();
}

/** Built-in rules, used when the owner has not saved their own. */
export function defaultCrewRules(): CrewRule[] {
  return [
    {
      id: "rule-default",
      name: "Default — every job",
      condition: { kind: "always" },
      climbers: 1,
      groundsmen: 1,
      enabled: true,
    },
    {
      id: "rule-one-job",
      name: "One job — everyone on it",
      condition: { kind: "dayJobs", operator: "exactly", count: 1 },
      climbers: 0,
      groundsmen: 0,
      allAvailable: true,
      enabled: true,
    },
    {
      id: "rule-big-job",
      name: "Big job ($5,000+) — everyone on it",
      condition: { kind: "minValue", value: 5000 },
      climbers: 0,
      groundsmen: 0,
      allAvailable: true,
      enabled: true,
    },
    {
      id: "rule-class2",
      name: "Class II prune",
      condition: { kind: "pruneClass", value: "2" },
      climbers: 1,
      groundsmen: 1,
      enabled: true,
    },
    {
      id: "rule-wires",
      name: "Over wires / backyard",
      condition: { kind: "keyword", value: "wires" },
      climbers: 1,
      groundsmen: 1,
      enabled: true,
    },
    {
      id: "rule-multi-tree",
      name: "Multiple trees (2+)",
      condition: { kind: "minTrees", value: 2 },
      climbers: 2,
      groundsmen: 2,
      enabled: true,
    },
  ];
}

/** The rules in force: the owner's saved rules, else the built-ins. */
export function crewRulesInForce(state: AppState): CrewRule[] {
  const saved = state.settings.crewRules;
  return saved && saved.length > 0 ? saved : defaultCrewRules();
}

/** Full weekday names, for reasons and notes ("usually off Mondays"). */
export const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Why this person can't be put on a job on this date at all, or null
 * (business rule): approved time off, or marked unavailable for
 * the day. These are hard blocks everywhere.
 */
export function blockedReason(
  state: Pick<AppState, "crew" | "timeOff" | "unavailability">,
  crewId: string,
  date: string,
): string | null {
  const m = state.crew.find((c) => c.id === crewId);
  if (!m || !date) return null;
  if (isTimeOffOn(state.timeOff, crewId, date)) return "on approved time off";
  if (isUnavailableOn(state.unavailability, crewId, date)) return "marked unavailable that day";
  return null;
}

/**
 * "usually off Mondays" when this date is not one of the person's usual
 * weekdays, else null. Soft (business rule): Suggest crew, Auto-fill,
 * Fill and day-crew suggestions never pick them, but the office can still
 * add them by hand when they are free that week.
 */
export function usuallyOffReason(
  state: Pick<AppState, "crew">,
  crewId: string,
  date: string,
): string | null {
  const m = state.crew.find((c) => c.id === crewId);
  if (!m || !date) return null;
  const wd = weekdayOf(date);
  return isGenerallyAvailable(m, wd) ? null : `usually off ${WEEKDAY_FULL[wd]}s`;
}

/** The small note shown on someone usually off who was put on a job by hand. */
export function handAddedNote(reason: string): string {
  return `${reason} — added by hand`;
}

/**
 * Why this person is never suggested or auto-filled on this date, or null:
 * a hard block (time off, marked unavailable) or usually off that weekday.
 * Only `blockedReason` stops someone being added by hand.
 */
export function unavailableReason(
  state: Pick<AppState, "crew" | "timeOff" | "unavailability">,
  crewId: string,
  date: string,
): string | null {
  return blockedReason(state, crewId, date) ?? usuallyOffReason(state, crewId, date);
}

/**
 * The crew list a job may get: anyone newly added who is on time off or
 * marked unavailable on the job's date is left off (usually-off people
 * added by hand stay: that is a soft rule) (people already on the job stay, so the
 * office can still see and remove them). `blocked` names who was left off.
 */
export function onlyAvailableAdded(
  state: Pick<AppState, "crew" | "timeOff" | "unavailability">,
  before: string[],
  after: string[],
  date: string,
): { ids: string[]; blocked: Array<{ id: string; name: string; reason: string }> } {
  const blocked: Array<{ id: string; name: string; reason: string }> = [];
  const ids = after.filter((id) => {
    if (before.includes(id)) return true;
    const reason = blockedReason(state, id, date);
    if (!reason) return true;
    blocked.push({ id, name: state.crew.find((c) => c.id === id)?.name ?? "Someone", reason });
    return false;
  });
  return { ids, blocked };
}

/** One plain line for a flash: "Gus can't go: on approved time off." */
export function blockedLine(blocked: Array<{ name: string; reason: string }>): string {
  return blocked.map((b) => `${b.name} can't be put on this job: ${b.reason}.`).join(" ");
}

/**
 * Is this person on the schedulable roster: active (not pending or
 * revoked) and not hidden from the schedule on their profile?
 */
export function isSchedulable(m: CrewMember): boolean {
  return (m.status ?? "active") === "active" && m.permissions?.hideFromSchedule !== true;
}

/** Everyone who can be put on a job: the active roster. */
export function schedulableCrew(state: AppState): CrewMember[] {
  return state.crew.filter(isSchedulable);
}

/**
 * Is this person generally available on this weekday (0=Sun..6=Sat)?
 * No availability set = available every day; an empty list = no days.
 */
export function isGenerallyAvailable(m: CrewMember, weekday: number): boolean {
  const days = m.availableWeekdays;
  if (days == null) return true;
  return days.includes(weekday);
}

/**
 * What kind of field crew this person is, from their job role.
 * "Contractor" is flexible labour (Jordan climbs): they are not a
 * climber or a groundsman by role, but the picker uses them as a
 * backup for either when the roster is short.
 */
export type CrewKind = "climber" | "groundsman" | "other";
export function crewKind(m: CrewMember): CrewKind {
  const r = (m.role || "").toLowerCase();
  if (r.includes("climb")) return "climber";
  if (r.includes("ground")) return "groundsman";
  return "other";
}
function isContractor(m: CrewMember): boolean {
  return (m.role || "").toLowerCase().includes("contract");
}

/**
 * Does this rule's condition match this job on this day? Old saved
 * rules may be missing the newer fields — dayJobs defaults to
 * "exactly 1", allAvailable defaults to off.
 */
function ruleMatches(
  rule: CrewRule,
  job: Job,
  state: AppState,
  date: string,
): boolean {
  const c = rule.condition;
  switch (c.kind) {
    case "always":
      return true;
    case "pruneClass":
      return job.pruneClass === c.value;
    case "minTrees":
      return (job.treeIds?.length ?? 0) >= c.value;
    case "serviceType":
      return job.serviceType === c.value;
    case "keyword": {
      const hay = `${job.title} ${job.notes} ${job.teamNotes}`.toLowerCase();
      return hay.includes(c.value.toLowerCase());
    }
    case "dayJobs": {
      // The day's job count, same set suggestCrewForDay splits.
      const n = state.jobs.filter((j) => j.date === date).length;
      const count = c.count ?? 1;
      const op = c.operator ?? "exactly";
      return op === "exactly" ? n === count : op === "at most" ? n <= count : n >= count;
    }
    case "minValue": {
      // The job's value under the shared jobValue rule (invoice →
      // estimate → manual value). A job with no value never matches.
      const v = jobValue(state, job);
      return v != null && v >= c.value;
    }
    case "equipment": {
      // The job uses this piece of equipment. A rule pointing at an
      // equipment item that no longer exists never matches.
      return (
        state.equipment.some((e) => e.id === c.value) &&
        (job.equipmentIds ?? []).includes(c.value)
      );
    }
  }
}

const wholeCount = (n: number | null | undefined): number =>
  n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

/**
 * The estimate's climbers/groundsmen as the job's crew requirement
 * (used by requiredCrew in place of the crew rules). Null when the
 * estimator did not set counts.
 */
export function estimateCrewNeed(
  est: Pick<Estimate, "expectedClimbers" | "expectedGroundsmen"> | null | undefined,
): { climbers: number; groundsmen: number } | null {
  if (!est) return null;
  if (est.expectedClimbers == null && est.expectedGroundsmen == null) return null;
  const climbers = wholeCount(est.expectedClimbers);
  const groundsmen = wholeCount(est.expectedGroundsmen);
  if (climbers + groundsmen === 0) return null;
  return { climbers, groundsmen };
}

/**
 * The crew a job needs: the most any matching rule asks for.
 * allAvailable is true when any matching rule says "everyone
 * available that day" — then the fixed numbers are a floor, not
 * the answer (see suggestCrew).
 */
export function requiredCrew(
  state: AppState,
  job: Job,
  date: string,
): {
  climbers: number;
  groundsmen: number;
  matchedRuleNames: string[];
  allAvailable: boolean;
  /** True when the counts are the estimator's, from the job's estimate. */
  fromEstimate?: boolean;
} {
  // The estimator's own count on the job's estimate ("1 climber + 2
  // groundsmen") is the requirement when it is set; the rules are not
  // asked. The expectedCrew cap still applies in suggestCrew.
  const est = job.estimateId ? state.estimates.find((e) => e.id === job.estimateId) : undefined;
  const fromEstimate = estimateCrewNeed(est);
  if (fromEstimate) {
    return { ...fromEstimate, matchedRuleNames: [], allAvailable: false, fromEstimate: true };
  }
  const rules = crewRulesInForce(state).filter((r) => r.enabled !== false);
  let climbers = 0;
  let groundsmen = 0;
  let allAvailable = false;
  const matched: string[] = [];
  for (const rule of rules) {
    if (ruleMatches(rule, job, state, date)) {
      if (rule.allAvailable) allAvailable = true;
      climbers = Math.max(climbers, rule.climbers);
      groundsmen = Math.max(groundsmen, rule.groundsmen);
      matched.push(rule.name);
    }
  }
  if (matched.length === 0) {
    climbers = 1;
    groundsmen = 1;
  }
  return { climbers, groundsmen, matchedRuleNames: matched, allAvailable };
}

export interface SuggestedCrew {
  crewIds: string[];
  climbers: string[];
  groundsmen: string[];
  /** equipment id -> crew id who drives it. */
  drivers: Record<string, string>;
  /** Human-readable reasons ("Class II prune rule: 1 climber + 1 groundsman"). */
  reasons: string[];
  /** Warnings ("No one available can drive the chipper", "The estimator capped the crew at 3"). */
  warnings: string[];
  /** True when the estimator's cap cut the crew below what the rules asked for. */
  capped: boolean;
  required: { climbers: number; groundsmen: number };
}

/**
 * Suggest a crew for one job on a date. `taken` is crew already
 * committed to a higher-value job that day (see suggestCrewForDay) —
 * they are not suggested twice.
 */
export function suggestCrew(
  state: AppState,
  job: Job,
  date: string,
  taken?: Set<string>,
): SuggestedCrew {
  const weekday = weekdayOf(date);

  // Candidate pool first: active roster, not on time off that day,
  // not marked unavailable that day, not on another job that day,
  // not already committed to a higher-value job.
  // The "assign all available" outcome needs the pool to know its size.
  const busyIds = new Set<string>();
  for (const j of state.jobs) {
    if (j.id === job.id || j.date !== date) continue;
    for (const id of j.crewIds) busyIds.add(id);
  }
  if (taken) for (const id of taken) busyIds.add(id);
  const pool = schedulableCrew(state).filter(
    (m) =>
      !busyIds.has(m.id) &&
      !isTimeOffOn(state.timeOff, m.id, date) &&
      !isUnavailableOn(state.unavailability, m.id, date),
  );
  const available = pool.filter((m) => isGenerallyAvailable(m, weekday));
  const unavailable = pool.filter((m) => !isGenerallyAvailable(m, weekday));

  let {
    climbers: needClimbers,
    groundsmen: needGroundsmen,
    matchedRuleNames,
    allAvailable,
    fromEstimate,
  } = requiredCrew(state, job, date);
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (fromEstimate) {
    reasons.push(
      `From the estimate: ${needClimbers} climber${needClimbers === 1 ? "" : "s"} + ${needGroundsmen} grounds${needGroundsmen === 1 ? "man" : "men"}.`,
    );
  }
  if (allAvailable) {
    // "Everyone available" = every climber, groundsman and contractor
    // in the pool. Contractors count once, on the climber side (they
    // are the backup for either pool — see the pickers below).
    needClimbers = available.filter(
      (m) => crewKind(m) === "climber" || isContractor(m),
    ).length;
    needGroundsmen = available.filter((m) => crewKind(m) === "groundsman").length;
  }
  if (matchedRuleNames.length > 0) {
    reasons.push(
      allAvailable
        ? `Rules matched: ${matchedRuleNames.join(", ")} — everyone available that day.`
        : `Rules matched: ${matchedRuleNames.join(", ")} — ${needClimbers} climber${needClimbers === 1 ? "" : "s"} + ${needGroundsmen} grounds${needGroundsmen === 1 ? "man" : "men"}.`,
    );
  }
  if (allAvailable && available.length === 0) {
    warnings.push(
      `No crew is available on ${date} — everyone is on approved time off, marked unavailable, usually off that day, or already on another job.`,
    );
  }

  // The estimator's cap: never suggest more people than the estimator said the job takes.
  const cap = job.expectedCrew ?? null;
  let wantClimbers = needClimbers;
  let wantGroundsmen = needGroundsmen;
  let capped = false;
  if (cap != null && needClimbers + needGroundsmen > cap) {
    capped = true;
    // Climbers are the skilled constraint, so trim groundsmen first.
    wantGroundsmen = Math.max(0, cap - needClimbers);
    wantClimbers = Math.min(needClimbers, cap);
    warnings.push(
      `The estimator expected ${cap} ${cap === 1 ? "person" : "people"} for this job, but the rules ask for ${needClimbers + needGroundsmen} — suggesting ${cap} and flagging the job as short-handed.`,
    );
  }

  // Grouping score: how many already-picked people this person works
  // well with (either direction counts — if A lists B, they pair).
  const picked = new Set<string>();
  const groupingScore = (m: CrewMember): number => {
    let score = 0;
    for (const id of picked) {
      if ((m.worksWellWith ?? []).includes(id)) score += 1;
      const other = state.crew.find((c) => c.id === id);
      if ((other?.worksWellWith ?? []).includes(m.id)) score += 1;
    }
    return score;
  };
  // Pick from a list, best grouping first, then available first.
  const pickFrom = (list: CrewMember[], n: number, out: string[]) => {
    const sorted = [...list].sort(
      (a, b) => groupingScore(b) - groupingScore(a),
    );
    for (const m of sorted) {
      if (out.length >= n) break;
      if (picked.has(m.id)) continue;
      out.push(m.id);
      picked.add(m.id);
    }
  };

  const climbers: string[] = [];
  const groundsmen: string[] = [];
  // Only people available that day are ever suggested (business rule): nobody on time off, marked unavailable, or on a day
  // that is not one of their usual weekdays.
  const climberPool = [
    ...available.filter((m) => crewKind(m) === "climber"),
    ...available.filter(isContractor),
  ];
  const groundsmanPool = [
    ...available.filter((m) => crewKind(m) === "groundsman"),
    ...available.filter(isContractor),
  ];
  void unavailable;
  pickFrom(climberPool, wantClimbers, climbers);
  pickFrom(groundsmanPool, wantGroundsmen, groundsmen);

  // Shortfalls.
  if (climbers.length < wantClimbers) {
    warnings.push(
      `Short ${wantClimbers - climbers.length} climber${wantClimbers - climbers.length === 1 ? "" : "s"} — no more climbers are free on ${date}.`,
    );
  }
  if (groundsmen.length < wantGroundsmen) {
    warnings.push(
      `Short ${wantGroundsmen - groundsmen.length} grounds${wantGroundsmen - groundsmen.length === 1 ? "man" : "men"} — no more groundsmen are free on ${date}.`,
    );
  }
  const pickedUnavailable = [...climbers, ...groundsmen].filter((id) => {
    const m = state.crew.find((c) => c.id === id);
    return m && !isGenerallyAvailable(m, weekday);
  });
  if (pickedUnavailable.length > 0) {
    const names = pickedUnavailable
      .map((id) => state.crew.find((c) => c.id === id)?.name ?? id)
      .join(", ");
    warnings.push(
      allAvailable
        ? `${names} ${pickedUnavailable.length === 1 ? "is" : "are"} usually not available on ${WEEKDAY_FULL[weekday]}s — included because the rule assigns everyone available. You can override.`
        : `${names} ${pickedUnavailable.length === 1 ? "is" : "are"} usually not available on ${WEEKDAY_FULL[weekday]}s — suggested because nobody else was free. You can override.`,
    );
  }

  // Drivers: one suggested crew member per piece of equipment, from
  // the people marked as able to drive it. Prefer someone who can
  // drive several pieces, so one driver covers more.
  const drivers: Record<string, string> = {};
  const crewIds = [...climbers, ...groundsmen];
  const driveCount = (id: string) =>
    (state.crew.find((c) => c.id === id)?.canDriveEquipment ?? []).length;
  for (const eqId of job.equipmentIds ?? []) {
    const eq = state.equipment.find((e) => e.id === eqId);
    const candidates = crewIds.filter((id) =>
      (state.crew.find((c) => c.id === id)?.canDriveEquipment ?? []).includes(eqId),
    );
    if (candidates.length === 0) {
      const anyone = schedulableCrew(state).some((m) =>
        (m.canDriveEquipment ?? []).includes(eqId),
      );
      warnings.push(
        anyone
          ? `No one on the suggested crew can drive the ${eq?.name ?? "equipment"} — someone on the team can, but they are not on this crew.`
          : `No one on the team is marked as able to drive the ${eq?.name ?? "equipment"} — check it off on someone's profile.`,
      );
      continue;
    }
    candidates.sort((a, b) => driveCount(b) - driveCount(a));
    drivers[eqId] = candidates[0];
  }

  return {
    crewIds,
    climbers,
    groundsmen,
    drivers,
    reasons,
    warnings,
    capped,
    required: { climbers: needClimbers, groundsmen: needGroundsmen },
  };
}

/**
 * Suggest crews for every job on a day, splitting the team by value:
 * the most valuable job gets first pick of the crew, the next job
 * picks from whoever is left, and so on. Jobs that already have a
 * full crew are left alone.
 */
export function suggestCrewForDay(
  state: AppState,
  date: string,
): Record<string, SuggestedCrew> {
  const dayJobs = state.jobs
    .filter((j) => j.date === date)
    .sort((a, b) => (jobValue(state, b) ?? 0) - (jobValue(state, a) ?? 0));
  const taken = new Set<string>();
  const out: Record<string, SuggestedCrew> = {};
  for (const job of dayJobs) {
    const s = suggestCrew(state, job, date, taken);
    out[job.id] = s;
    for (const id of s.crewIds) taken.add(id);
  }
  return out;
}

/** Start time "HH:MM" as minutes after midnight. */
function startMinutes(startTime: string): number {
  const [h, m] = startTime.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * When a job ends, for chaining crews into routes: start + the estimator's
 * estimated hours when set, else a 2-hour default (most jobs run
 * 1–3 hours; the timetable buckets jobs by start hour the same way).
 */
export function jobEndMinutes(job: Job): number {
  return startMinutes(job.startTime) + (job.estimatedHours ?? 2) * 60;
}

/** One person's jobs on a date, earliest first. */
export function crewDayJobs(
  state: AppState,
  date: string,
  memberId: string,
): Job[] {
  return state.jobs
    .filter((j) => j.date === date && j.crewIds.includes(memberId))
    .sort(
      (a, b) =>
        a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id),
    );
}

/** The jobs on a date a day crew's members are on, earliest first. */
export function dayCrewJobs(
  state: AppState,
  date: string,
  memberIds: string[],
): Job[] {
  const set = new Set(memberIds);
  return state.jobs
    .filter((j) => j.date === date && j.crewIds.some((id) => set.has(id)))
    .sort(
      (a, b) =>
        a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id),
    );
}

export interface SuggestedDayCrew {
  name: string;
  memberIds: string[];
  jobIds: string[];
}

/**
 * Suggest up to two day crews for a date: the two chains the day's
 * jobs split into, so each crew has one drivable route instead of
 * everyone guessing where to go next.
 *
 * Chaining rule: jobs run earliest first. Chain A starts with the
 * earliest job; chain B starts with the first job that overlaps
 * chain A's first job. Each later job joins the chain whose last job
 * ends before it starts (back-to-back counts as free) — when both
 * chains are free, the one its crew works best with (worksWellWith
 * links, either direction), then the smaller crew; when both chains
 * are busy, the one whose last job ends earliest. A crew is the
 * union of its jobs' suggested crews, so the two crews are disjoint
 * (suggestCrewForDay never suggests the same person twice in a day)
 * — nobody is ever double-booked. When a job overlaps both chains
 * it still has to go somewhere, so it joins the earliest-ending one
 * and that crew splits across the overlap for a while; the people
 * are still distinct, just not all in the same place at once.
 * Chains with no members (nothing suggestable) are dropped; a day
 * with one job, or where everyone fits one crew, returns one crew.
 */
export function suggestDayCrews(
  state: AppState,
  date: string,
): SuggestedDayCrew[] {
  const dayJobs = state.jobs
    .filter((j) => j.date === date)
    .sort(
      (a, b) =>
        a.startTime.localeCompare(b.startTime) ||
        (jobValue(state, b) ?? 0) - (jobValue(state, a) ?? 0) ||
        a.id.localeCompare(b.id),
    );
  if (dayJobs.length === 0) return [];
  const perJob = suggestCrewForDay(state, date);

  const groupingLinks = (a: string[], b: string[]): number => {
    let n = 0;
    for (const id of a) {
      const m = state.crew.find((c) => c.id === id);
      for (const other of b) {
        if ((m?.worksWellWith ?? []).includes(other)) n += 1;
        const o = state.crew.find((c) => c.id === other);
        if ((o?.worksWellWith ?? []).includes(id)) n += 1;
      }
    }
    return n;
  };

  interface Chain {
    jobs: Job[];
    members: string[];
  }
  const chains: Chain[] = [];
  for (const job of dayJobs) {
    const crew = [...(perJob[job.id]?.crewIds ?? [])];
    const start = startMinutes(job.startTime);
    const freeChains = chains.filter((ch) => {
      const last = ch.jobs[ch.jobs.length - 1];
      return jobEndMinutes(last) <= start;
    });
    let target: Chain;
    if (chains.length === 0) {
      target = { jobs: [], members: [] };
      chains.push(target);
    } else if (freeChains.length > 0) {
      target = [...freeChains].sort(
        (a, b) =>
          groupingLinks(crew, b.members) - groupingLinks(crew, a.members) ||
          a.members.length - b.members.length,
      )[0];
    } else if (chains.length < 2) {
      target = { jobs: [], members: [] };
      chains.push(target);
    } else {
      target = [...chains].sort(
        (a, b) =>
          jobEndMinutes(a.jobs[a.jobs.length - 1]) -
          jobEndMinutes(b.jobs[b.jobs.length - 1]),
      )[0];
    }
    target.jobs.push(job);
    for (const id of crew) {
      if (!target.members.includes(id)) target.members.push(id);
    }
  }
  return chains
    .filter((ch) => ch.members.length > 0)
    .map((ch, i) => ({
      // Literal names so the crews read "Crew 1" / "Crew 2" in the UI.
      name: ["Crew 1", "Crew 2"][i] ?? `Crew ${i + 1}`,
      memberIds: ch.members,
      jobIds: ch.jobs.map((j) => j.id),
    }));
}
