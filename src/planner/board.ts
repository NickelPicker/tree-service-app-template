/**
 * The plan board's logic, kept out of the component so it can be tested:
 * building the day's input, trucks and drivers in the draft, the patches
 * "Save day" writes, re-planning the rest of today from now, the "today
 * changed" check, and filling a whole week.
 */
import type { DayBoardPatch } from "../store";
import type { LatLng } from "../routing";
import type { AppState, CrewMember, Equipment, Job } from "../types";
import { assignDrive, driveProblem, isTruck, removeDrive, suggestDrivers, usable } from "../driverSuggest";
import { isLegalDriver } from "../skills";
import { addDaysISO } from "../utils";
import { buildPlannerInput, jobActiveOn, jobDays, personSkills } from "./input";
import { formatHHMM, parseHHMM } from "./settings";
import { autoFill, meetInputFrom, ratePerMin, type AutoFill, type MeetInput, type MeetPerson, type Routes, type SimResult } from "./meetup";
import type { PlannerInput } from "./types";
import { blockedReason, onlyAvailableAdded, usuallyOffReason } from "../crewSuggest";
import { workDollars } from "./learn";

/** 7:05 AM */
export const time12 = (min: number) => {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** job id -> what it takes and who drives what. */
export type EquipDraft = Record<string, { equipmentIds: string[]; drivers: Record<string, string> }>;

/** The day's jobs (not done) active on the date. */
export function boardJobs(state: AppState, date: string): Job[] {
  return state.jobs.filter((j) => j.status !== "done" && jobActiveOn(j, date));
}

/** Each person's jobs on the date, in the order they go (saved arrival time, else start time). */
export function savedRoutes(state: AppState, jobs: Job[]): Routes {
  const out: Routes = {};
  const at = (j: Job, pid: string) => j.crewArrivals?.[pid] ?? j.startTime ?? "";
  for (const c of state.crew) {
    const mine = jobs.filter((j) => j.crewIds.includes(c.id));
    if (mine.length === 0) continue;
    out[c.id] = [...mine]
      .sort((a, b) => at(a, c.id).localeCompare(at(b, c.id)) || a.id.localeCompare(b.id))
      .map((j) => j.id);
  }
  return out;
}

/** The equipment saved on each job. */
export function savedEquipment(jobs: Job[]): EquipDraft {
  return Object.fromEntries(
    jobs.map((j) => [j.id, { equipmentIds: [...(j.equipmentIds ?? [])], drivers: { ...(j.equipmentDrivers ?? {}) } }]),
  );
}

/** The board's day input: the planner's input turned into dollars of work. */
export function boardMeetInput(
  state: AppState,
  date: string,
  coords: Record<string, LatLng | null>,
  driveMinutes?: (a: LatLng, b: LatLng) => number,
): { p: PlannerInput; meet: MeetInput } {
  // Business rule: people usually off that weekday stay on the
  // board (flagged `usuallyOff`) so they can be dragged on by hand, but
  // Auto-fill and Fill never place them (`autoFillInput`).
  const p = buildPlannerInput(state, date, { mode: "replan", coords, driveMinutes, fixedTimes: "all" });
  const offNote = (id: string) => {
    const why = usuallyOffReason(state, id, date);
    return why ? { usuallyOff: why } : {};
  };
  const R = p.settings.dollarsPerHour;
  const base0 = meetInputFrom(p, (jobId, value, durationMin) => {
    const j = state.jobs.find((x) => x.id === jobId);
    const days = j ? jobDays(j) : 1;
    // Per-service rates (from the rate check) turn value into base-rate work.
    return value > 0 && j ? workDollars(value / days, j.serviceType, p.settings) : value > 0 ? value / days : (durationMin / 60) * R;
  });
  const base: MeetInput = { ...base0, people: base0.people.map((x) => ({ ...x, ...offNote(x.id) })) };
  // Only a time the customer was promised (ticked on the job) is fixed;
  // the plan may move every other start time.
  const meet: MeetInput = {
    ...base,
    jobs: base.jobs.map((mj) => {
      const j = state.jobs.find((x) => x.id === mj.id);
      return j?.timePromised === true ? mj : { ...mj, fixedStartMin: null };
    }),
    // Everyone available goes out (owner's rule): people with no field
    // skills ticked go as general helpers. Owner/manager/office/sales
    // logins are listed too so they can be dragged on by hand, but
    // Auto-fill leaves them out (`autoFillInput`).
    people: [
      ...base.people,
      ...p.off
        .filter((o) => o.reason === "No field skills recorded" && !blockedReason(state, o.crewId, date))
        .map((o) => {
          const c = state.crew.find((x) => x.id === o.crewId);
          return {
            id: o.crewId,
            name: o.name,
            legalDriver: c?.driverLicensed === true && c?.companyInsured === true,
            skills: [] as string[],
            ...offNote(o.crewId),
          };
        }),
    ],
  };
  return { p, meet };
}

/**
 * Field crew: the only people ✨ Auto-fill places (business rule). Owner, manager and office logins, and anyone whose job
 * title is Sales, stay on the board and can still be dragged onto a
 * job by hand, but Auto-fill never sends them out.
 */
export function isFieldCrew(c: CrewMember | undefined): boolean {
  if (!c) return false;
  return c.appRole === "crew" && !/\bsales\b/i.test(c.role ?? "");
}

/**
 * The board's input with only the people Auto-fill may place: field
 * crew who work that weekday, plus anyone already pinned to a job
 * (clocked in there, or on an earlier day of a multi-day job) — keeping
 * a placement is not auto-placing. Someone usually off that weekday is
 * never placed by Auto-fill or Fill (business rule); when the office
 * put them on a job by hand (`current`), they keep that route.
 */
export function autoFillInput(state: AppState, meet: MeetInput, current?: Routes): MeetInput {
  const keep = meet.startAt ?? {};
  const byHand: Routes = { ...(meet.fixedRoutes ?? {}) };
  for (const p of meet.people) {
    const r = current?.[p.id] ?? [];
    if (p.usuallyOff && r.length > 0 && keep[p.id] === undefined) byHand[p.id] = [...r];
  }
  return {
    ...meet,
    people: meet.people.filter(
      (p) =>
        keep[p.id] !== undefined ||
        byHand[p.id] !== undefined ||
        (!p.usuallyOff && isFieldCrew(state.crew.find((c) => c.id === p.id))),
    ),
    ...(Object.keys(byHand).length > 0 ? { fixedRoutes: byHand } : {}),
  };
}

/**
 * What the board's unsaved draft means for each job: who goes and
 * when the first person gets there. The Schedule's pinned route panel
 * shows this, so it matches the board right after ✨ Auto-fill instead
 * of the last saved crew.
 */
export function draftByJob(
  jobs: Job[],
  routes: Routes,
  sim: SimResult,
): Record<string, { crewIds: string[]; startTime: string | null }> {
  const out: Record<string, { crewIds: string[]; startTime: string | null }> = {};
  for (const j of jobs) {
    const start = sim.jobs[j.id]?.startMin;
    out[j.id] = {
      crewIds: peopleOn(routes, sim, j.id),
      startTime: start != null && Number.isFinite(start) ? formatHHMM(start) : null,
    };
  }
  return out;
}

/** People who go to this job (not counting those who'd arrive after it is done). */
export function peopleOn(routes: Routes, sim: SimResult, jobId: string): string[] {
  const tl = sim.jobs[jobId];
  const anyArrival = tl != null && Object.keys(tl.arrivals).length > 0;
  return Object.keys(routes).filter(
    (pid) => routes[pid].includes(jobId) && (!anyArrival || tl.arrivals[pid] != null),
  );
}

const workOf = (meet: MeetInput, id: string) => meet.jobs.find((x) => x.id === id)?.work ?? 0;

/** A free truck one of these people can drive (their own truck first). */
function pickTruck(
  state: AppState,
  people: CrewMember[],
  taken: Set<string>,
): { truckId: string; driverId: string } | null {
  const trucks = state.equipment.filter((e) => isTruck(e) && usable(e) && !taken.has(e.id));
  const drivers = people.filter((c) => isLegalDriver(c));
  const own = drivers.find((d) => d.prefersOwnTruck && d.ownTruckId && trucks.some((t) => t.id === d.ownTruckId));
  if (own && !driveProblem(state, own, trucks.find((t) => t.id === own.ownTruckId)!, null)) {
    return { truckId: own.ownTruckId!, driverId: own.id };
  }
  for (const t of trucks) {
    const d = drivers.find((x) => !driveProblem(state, x, t, null));
    if (d) return { truckId: t.id, driverId: d.id };
  }
  return null;
}

/**
 * Trucks, equipment and drivers for each team leaving the shop.
 * Biggest job first; a piece is never on two jobs of the day. A team
 * that joins a job later keeps the truck it came in (it stays on the
 * first job's list). People already working on a job (`pinned`, from a
 * re-plan) keep what that job has; a team leaving the shop to help them
 * gets one free truck.
 */
export function fillEquipment(
  state: AppState,
  date: string,
  dayJobs: Job[],
  meet: MeetInput,
  routes: Routes,
  sim: SimResult,
  current: EquipDraft,
  pinned: Record<string, string> = {},
): EquipDraft {
  const out: EquipDraft = {};
  const taken = new Set<string>();
  const dayIds = new Set(dayJobs.map((j) => j.id));
  const crewById = new Map(state.crew.map((c) => [c.id, c]));
  // Jobs people are already working on keep their equipment first, so a
  // team leaving the shop never takes the truck parked at a running job.
  const pinnedJobs = new Set(Object.values(pinned));
  const ordered = [...dayJobs].sort(
    (a, b) =>
      Number(pinnedJobs.has(b.id)) - Number(pinnedJobs.has(a.id)) ||
      workOf(meet, b.id) - workOf(meet, a.id) ||
      a.id.localeCompare(b.id),
  );
  for (const j of ordered) {
    const people = peopleOn(routes, sim, j.id);
    const leavers = people.filter((pid) => routes[pid]?.[0] === j.id && !pinned[pid]);
    const hasPinned = people.some((pid) => pinned[pid] === j.id);
    const cur = current[j.id] ?? { equipmentIds: [...(j.equipmentIds ?? [])], drivers: { ...(j.equipmentDrivers ?? {}) } };
    let ids: string[];
    let drivers: Record<string, string>;
    if (leavers.length > 0 && !hasPinned) {
      // What the job needs: the kinds already listed on it (trucks are re-picked
      // for this team), else the service type's usual equipment.
      const eqById = new Map(state.equipment.map((e) => [e.id, e]));
      const own = cur.equipmentIds.filter((id) => !taken.has(id) && eqById.get(id) && !isTruck(eqById.get(id)!));
      const working: AppState = {
        ...state,
        // Other jobs of the day are being re-planned here: only `taken` counts as booked.
        jobs: state.jobs.map((x) => (dayIds.has(x.id) ? { ...x, equipmentIds: [] } : x)),
        equipment: state.equipment.map((e) => (taken.has(e.id) ? { ...e, status: "retired" as const } : e)),
      };
      const s = suggestDrivers(working, { ...j, date, crewIds: leavers, equipmentIds: own, equipmentDrivers: null });
      ids = s.equipmentIds.filter((id) => !taken.has(id));
      drivers = Object.fromEntries(Object.entries(s.drivers).filter(([id]) => ids.includes(id)));
      const hasTruck = ids.some((id) => eqById.get(id)?.kind === "Truck" && drivers[id]);
      if (!hasTruck) {
        const free = new Set([...taken, ...ids]);
        const t = pickTruck(state, leavers.map((id) => crewById.get(id)).filter((c): c is CrewMember => !!c), free);
        if (t) {
          ids = [t.truckId, ...ids];
          drivers = { ...drivers, [t.truckId]: t.driverId };
        }
      }
    } else {
      ids = cur.equipmentIds.filter((id) => !taken.has(id));
      drivers = Object.fromEntries(Object.entries(cur.drivers).filter(([id, c]) => ids.includes(id) && people.includes(c)));
      const fresh = leavers.filter((pid) => !Object.values(drivers).includes(pid));
      if (hasPinned && fresh.length === leavers.length && leavers.length > 0) {
        const t = pickTruck(state, leavers.map((id) => crewById.get(id)).filter((c): c is CrewMember => !!c), new Set([...taken, ...ids]));
        if (t) {
          ids = [...ids, t.truckId];
          drivers = { ...drivers, [t.truckId]: t.driverId };
        }
      }
    }
    for (const id of ids) taken.add(id);
    out[j.id] = { equipmentIds: ids, drivers };
  }
  return out;
}

/**
 * Put a piece of equipment on a person on one job (replace-in-slot
 * rules). It comes off every other job of the day first.
 */
export function placeEquipment(
  equipment: Equipment[],
  draft: EquipDraft,
  jobId: string,
  crewId: string,
  eqId: string,
): EquipDraft {
  const next: EquipDraft = {};
  for (const [id, e] of Object.entries(draft)) {
    next[id] = id === jobId || !e.equipmentIds.includes(eqId) ? e : removeDrive(e.equipmentIds, e.drivers, eqId);
  }
  const cur = next[jobId] ?? { equipmentIds: [], drivers: {} };
  next[jobId] = assignDrive(equipment, cur.equipmentIds, cur.drivers, crewId, eqId);
  return next;
}

/** Take a piece off a job. */
export function unplaceEquipment(draft: EquipDraft, jobId: string, eqId: string): EquipDraft {
  const cur = draft[jobId];
  if (!cur) return draft;
  return { ...draft, [jobId]: removeDrive(cur.equipmentIds, cur.drivers, eqId) };
}

/** A job's equipment grouped by driver, truck first: "🛻 Big Truck (Cal) + Chipper". */
export function equipmentGroups(
  equipment: Equipment[],
  e: { equipmentIds: string[]; drivers: Record<string, string> } | undefined,
  people: string[],
): Array<{ driverId: string | null; items: Equipment[] }> {
  if (!e) return [];
  const byId = new Map(equipment.map((x) => [x.id, x]));
  const groups = new Map<string | null, Equipment[]>();
  for (const id of e.equipmentIds) {
    const x = byId.get(id);
    if (!x) continue;
    const d = e.drivers[id] && people.includes(e.drivers[id]) ? e.drivers[id] : null;
    groups.set(d, [...(groups.get(d) ?? []), x]);
  }
  return [...groups.entries()]
    .map(([driverId, items]) => ({ driverId, items: [...items].sort((a, b) => Number(isTruck(b)) - Number(isTruck(a))) }))
    .sort((a, b) => (a.driverId === null ? 1 : 0) - (b.driverId === null ? 1 : 0));
}

/** Patches "Save day" writes for every job of the day. */
export function buildDayPatches(
  date: string,
  dayJobs: Job[],
  meet: MeetInput,
  routes: Routes,
  sim: SimResult,
  equipment: EquipDraft,
  opts: {
    /** job id -> person -> arrival to keep (people already working there). */
    keepArrivals?: Record<string, Record<string, string>>;
    /** Jobs whose start time stays (already started). */
    keepStart?: Set<string>;
  } = {},
): Record<string, DayBoardPatch> {
  const out: Record<string, DayBoardPatch> = {};
  for (const j of dayJobs) {
    const tl = sim.jobs[j.id];
    const people = peopleOn(routes, sim, j.id);
    const arrivals: Record<string, string> = {};
    for (const pid of people) {
      const kept = opts.keepArrivals?.[j.id]?.[pid];
      const t = tl?.arrivals[pid];
      if (kept) arrivals[pid] = kept;
      else if (t != null) arrivals[pid] = formatHHMM(t);
    }
    people.sort((a, b) => (arrivals[a] ?? "99").localeCompare(arrivals[b] ?? "99") || a.localeCompare(b));
    // A multi-day job has one crew list and one start time for all its days:
    // only its first day sets the start and arrival times.
    const firstDay = !j.endDate || j.endDate <= j.date || date === j.date;
    const promised = meet.jobs.find((x) => x.id === j.id)?.fixedStartMin != null;
    const keepStart = opts.keepStart?.has(j.id) ?? false;
    const patch: DayBoardPatch = {
      crewIds: people,
      ...(firstDay ? { crewArrivals: Object.keys(arrivals).length > 0 ? arrivals : null } : {}),
      ...(firstDay && !promised && !keepStart && tl?.startMin != null ? { startTime: formatHHMM(tl.startMin) } : {}),
    };
    const e = equipment[j.id] ?? { equipmentIds: [...(j.equipmentIds ?? [])], drivers: { ...(j.equipmentDrivers ?? {}) } };
    // Drivers who are no longer on the job come off.
    const drivers = Object.fromEntries(Object.entries(e.drivers).filter(([id, c]) => people.includes(c) && e.equipmentIds.includes(id)));
    patch.equipmentIds = [...e.equipmentIds];
    patch.equipmentDrivers = Object.keys(drivers).length > 0 ? drivers : null;
    out[j.id] = patch;
  }
  return out;
}

/** What "Save day" writes to the audit log. */
export function boardSnapshot(meet: MeetInput, suggested: Routes | null, routes: Routes, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    board: true,
    suggested,
    saved: routes,
    rate: [meet.dollarsPerHour, meet.fullSpeedCrew, meet.minTeam],
    ...extra,
  });
}

// ---------------------------------------------------------------- re-plan from now

/** Dollars of work left on a job a crew of n has been on for `elapsedMin`; never below 10% of the job. */
export function remainingWork(
  meet: Pick<MeetInput, "dollarsPerHour" | "fullSpeedCrew">,
  work: number,
  elapsedMin: number,
  n: number,
): number {
  const done = Math.max(0, elapsedMin) * ratePerMin(meet, n);
  return Math.max(work * 0.1, work - done);
}

export interface Replan {
  meet: MeetInput;
  /** person id -> job they are clocked in on. */
  pinned: Record<string, string>;
  /** Jobs someone is clocked in on. */
  inProgress: string[];
  keepArrivals: Record<string, Record<string, string>>;
  nowMin: number;
}

/**
 * The rest of today from `nowMin`: done jobs are already off the board;
 * people clocked in on a job stay there and its work is what is left
 * (minutes since they started × the rate for that many people, never
 * below 10% of the job); everyone else leaves the shop now.
 */
export function replanFromNow(state: AppState, date: string, meet: MeetInput, nowMin: number): Replan {
  const jobIds = new Set(meet.jobs.map((j) => j.id));
  const open = state.timesheets
    .filter((t) => t.date === date && t.clockOut == null && t.jobId && jobIds.has(t.jobId) && parseHHMM(t.clockIn) != null)
    .sort((a, b) => (a.clockIn ?? "").localeCompare(b.clockIn ?? ""));
  const pinned: Record<string, string> = {};
  const clockIn: Record<string, string> = {};
  for (const t of open) {
    // The latest clock-in wins when someone has two open entries.
    pinned[t.crewId] = t.jobId!;
    clockIn[t.crewId] = t.clockIn!;
  }
  // People clocked in who the day's list left out still count.
  const people: MeetPerson[] = [...meet.people];
  for (const pid of Object.keys(pinned)) {
    if (people.some((p) => p.id === pid)) continue;
    const c = state.crew.find((x) => x.id === pid);
    if (!c) {
      delete pinned[pid];
      continue;
    }
    people.push({ id: c.id, name: c.name, legalDriver: isLegalDriver(c), skills: personSkills(c).skills });
  }
  const startMin = Math.max(nowMin, meet.dayStartMin);
  const keepArrivals: Record<string, Record<string, string>> = {};
  const inProgress: string[] = [];
  const jobs = meet.jobs.map((mj) => {
    const here = Object.keys(pinned).filter((pid) => pinned[pid] === mj.id);
    if (here.length === 0) return mj;
    inProgress.push(mj.id);
    const job = state.jobs.find((x) => x.id === mj.id);
    keepArrivals[mj.id] = Object.fromEntries(here.map((pid) => [pid, job?.crewArrivals?.[pid] ?? clockIn[pid]]));
    const started = Math.min(...here.map((pid) => parseHHMM(clockIn[pid])!));
    return { ...mj, work: remainingWork(meet, mj.work, startMin - started, here.length), fixedStartMin: null };
  });
  return {
    meet: {
      ...meet,
      jobs,
      people,
      startMin,
      startAt: Object.fromEntries(Object.entries(pinned).map(([pid, jobId]) => [pid, { jobId }])),
    },
    pinned,
    inProgress,
    keepArrivals,
    nowMin: startMin,
  };
}

/**
 * Why today's saved plan no longer fits (empty = it still fits, or
 * nothing is planned yet).
 */
export function todayChanges(state: AppState, dayJobs: Job[], meet: MeetInput, off: PlannerInput["off"]): string[] {
  if (!dayJobs.some((j) => j.crewIds.length > 0)) return [];
  const name = (id: string) => state.crew.find((c) => c.id === id)?.name ?? "Someone";
  const onPlan = new Set(dayJobs.flatMap((j) => j.crewIds));
  const out: string[] = [];
  for (const o of off) {
    if (o.reason === "No field skills recorded" || !onPlan.has(o.crewId)) continue;
    out.push(`${name(o.crewId)} is off today (${o.reason.toLowerCase()})`);
  }
  for (const j of dayJobs) if (j.crewIds.length === 0) out.push(`Nobody is on ${j.title}`);
  for (const p of meet.people) {
    if (onPlan.has(p.id) || p.usuallyOff || !isFieldCrew(state.crew.find((c) => c.id === p.id))) continue;
    out.push(`${p.name} is free but not on a job`);
  }
  return out;
}

// ---------------------------------------------------------------- fill the week

/** Monday to Saturday of the week the date falls in. */
/** The next 6 working days from this date (Sundays skipped), the date included. */
export function nextWorkDays(date: string, count = 6): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < count * 2; i++) {
    const d = addDaysISO(date, i);
    if (new Date(`${d}T12:00:00`).getDay() !== 0) out.push(d);
  }
  return out;
}

export function weekDaysMonSat(date: string): string[] {
  const d = new Date(`${date}T12:00:00`);
  const back = (d.getDay() + 6) % 7;
  const mon = addDaysISO(date, -back);
  return [0, 1, 2, 3, 4, 5].map((i) => addDaysISO(mon, i));
}

/**
 * True when a day has jobs and nothing planned yet: no job that starts
 * that day has crew arrival times, and not every job is a continuing
 * multi-day job that already has its crew.
 */
export function dayNeedsPlan(state: AppState, day: string): boolean {
  const jobs = boardJobs(state, day);
  if (jobs.length === 0) return false;
  // Planned already: on the board (arrival times) or by hand (a job that
  // starts that day has people on it). Fill never replaces either.
  if (jobs.some((j) => j.date === day && (Object.keys(j.crewArrivals ?? {}).length > 0 || j.crewIds.length > 0))) return false;
  if (jobs.every((j) => j.date < day && j.crewIds.length > 0)) return false;
  return true;
}

/**
 * Arrival times that still hold after a job changes: dropped when the
 * date or start time moved, and for people no longer on the job.
 */
export function keepArrivals(old: Job, next: Job): Record<string, string> | null {
  const a = next.crewArrivals ?? null;
  if (!a) return null;
  if (old.date !== next.date || old.startTime !== next.startTime) return null;
  const kept = Object.fromEntries(Object.entries(a).filter(([id]) => next.crewIds.includes(id)));
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * Exactly what "Save day" (saveDayBoard) writes to one job for a patch:
 * people on time off or marked unavailable on `date` are never added
 * (usually-off people placed by hand are). Null when the
 * patch changes nothing on the job.
 */
export function boardPatchJob(
  state: Pick<AppState, "crew" | "timeOff" | "unavailability">,
  j: Job,
  pt: DayBoardPatch | undefined,
  date: string,
): Job | null {
  if (!pt) return null;
  const next: Job = {
    ...j,
    crewIds: onlyAvailableAdded(state, j.crewIds, pt.crewIds, date).ids,
    startTime: pt.startTime ?? j.startTime,
    crewArrivals:
      pt.crewArrivals === undefined
        ? keepArrivals(j, { ...j, crewIds: pt.crewIds })
        : pt.crewArrivals && Object.keys(pt.crewArrivals).length > 0
          ? pt.crewArrivals
          : null,
    equipmentIds: pt.equipmentIds ?? j.equipmentIds,
    equipmentDrivers: pt.equipmentDrivers !== undefined ? pt.equipmentDrivers : j.equipmentDrivers,
  };
  const same =
    JSON.stringify([j.crewIds, j.startTime, j.crewArrivals ?? null, j.equipmentIds ?? [], j.equipmentDrivers ?? null]) ===
    JSON.stringify([next.crewIds, next.startTime, next.crewArrivals ?? null, next.equipmentIds ?? [], next.equipmentDrivers ?? null]);
  return same ? null : next;
}

/** Apply saved-day patches to a copy of the state (so the next day of a week fill sees them). */
export function applyPatches(state: AppState, patches: Record<string, DayBoardPatch>): AppState {
  return {
    ...state,
    jobs: state.jobs.map((j) => {
      const pt = patches[j.id];
      if (!pt) return j;
      return {
        ...j,
        crewIds: pt.crewIds,
        startTime: pt.startTime ?? j.startTime,
        crewArrivals: pt.crewArrivals === undefined ? j.crewArrivals : pt.crewArrivals,
        equipmentIds: pt.equipmentIds ?? j.equipmentIds,
        equipmentDrivers: pt.equipmentDrivers !== undefined ? pt.equipmentDrivers : j.equipmentDrivers,
      };
    }),
  };
}

/** "Tue" */
export function weekdayShort(day: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T12:00:00`).getDay()];
}

/** ✨ Auto-fill for one day, trucks included: what "Fill this week" saves for each day. */
export function autoPlanDay(
  state: AppState,
  date: string,
  dayJobs: Job[],
  meet: MeetInput,
): { fill: AutoFill; equipment: EquipDraft; patches: Record<string, DayBoardPatch>; finishMin: number; unfinished: number } | null {
  // A multi-day job that started earlier keeps its crew on its later days.
  const keep: NonNullable<MeetInput["startAt"]> = { ...(meet.startAt ?? {}) };
  for (const j of dayJobs) {
    if (j.date >= date || j.crewIds.length === 0) continue;
    for (const pid of j.crewIds) if (!keep[pid] && meet.people.some((x) => x.id === pid)) keep[pid] = { jobId: j.id };
  }
  // Usually-off people someone put on a job by hand stay where they are.
  const fill = autoFill(
    autoFillInput(state, Object.keys(keep).length > 0 ? { ...meet, startAt: keep } : meet, savedRoutes(state, dayJobs)),
  );
  if (!fill) return null;
  const equipment = fillEquipment(state, date, dayJobs, meet, fill.routes, fill.sim, savedEquipment(dayJobs));
  const patches = buildDayPatches(date, dayJobs, meet, fill.routes, fill.sim, equipment);
  const finishMin = Math.max(meet.dayStartMin, ...dayJobs.map((j) => fill.sim.jobs[j.id]?.endMin ?? 0));
  return { fill, equipment, patches, finishMin, unfinished: fill.sim.unfinished.length };
}
