/**
 * Step 0: turn the app state into a PlannerInput for one date.
 *
 * This is the only planner file that reads AppState. Everything the
 * engine needs is copied into plain data here, so planDay stays pure
 * and testable.
 */
import { isGenerallyAvailable, isSchedulable, requiredCrew, weekdayOf } from "../crewSuggest";
import { jobValue } from "../jobValue";
import { haversineMiles, type LatLng } from "../routing";
import type { AppState, CrewMember, EquipmentKind, Job } from "../types";
import { isUnavailableOn } from "../unavailability";
import { daysBetweenISO, isClosedDay, isTimeOffOn, parseISO, toISODate } from "../utils";
import { parseHHMM, resolvePlannerSettings, type ResolvedPlannerSettings } from "./settings";
import type { PlanEquipment, PlanFlag, PlanJob, PlanMode, PlanPerson, PlannerInput } from "./types";

export interface BuildPlannerOptions {
  /** "keep" (default): people, equipment and drivers already on the day's jobs are locks. "replan": ignore them. */
  mode?: PlanMode;
  /** Today's date (YYYY-MM-DD): earlier days of the week count timesheet hours, later days count planned hours. Default: the planned date. */
  today?: string;
  /** The yard the crews leave from. Undefined = the first company site with a position; null = no yard. */
  yard?: LatLng | null;
  /** Drive minutes between two points. Default: straight-line miles × 1.3 at 30 mph (flagged ESTIMATED_DRIVE). */
  driveMinutes?: (a: LatLng, b: LatLng) => number;
  /** Positions already looked up (e.g. geocoded addresses), by job id. Wins over the job's pin. */
  coords?: Record<string, LatLng | null>;
  /**
   * Which typed start times are fixed: "all", "non-default" (default:
   * every time except the app's creation default 08:00 and the planner's
   * day start), or "none".
   */
  fixedTimes?: "all" | "non-default" | "none";
}

/**
 * The shop drive times start and end at: the site chosen in the planner
 * settings, else the first shop
 * with a map position. Null when no shop is on the map.
 */
export function plannerYard(state: AppState): { label: string; address: string; at: LatLng } | null {
  const sites = state.settings.company?.sites ?? [];
  const placed = (s: (typeof sites)[number]) => s.lat != null && s.lng != null;
  const wanted = state.settings.planner?.yardSite?.trim().toLowerCase();
  const pick =
    (wanted ? sites.find((s) => placed(s) && (s.address.trim().toLowerCase() === wanted || s.label.trim().toLowerCase() === wanted)) : undefined) ??
    sites.find(placed);
  return pick ? { label: pick.label, address: pick.address, at: { lat: pick.lat as number, lng: pick.lng as number } } : null;
}

/** Straight-line drive estimate: miles × 1.3 road factor at 30 mph, in whole minutes. */
export function straightLineMinutes(a: LatLng, b: LatLng): number {
  return Math.ceil(haversineMiles(a, b) * 1.3 * 2);
}

/** True when a job is active on this date (multi-day jobs count on every day they span). */
export function jobActiveOn(job: Job, date: string): boolean {
  return job.date <= date && date <= (job.endDate && job.endDate >= job.date ? job.endDate : job.date);
}

/** Skill a piece of equipment on a job needs (also used by src/planner/learn.ts). */
export const EQUIPMENT_SKILL: Partial<Record<EquipmentKind, string>> = {
  Chipper: "chipper",
  "Mini skid": "mini_skid",
  "Stump grinder": "stump_grinding",
};

/** A person's skills: their ticked skills, else guessed from the job role. */
export function personSkills(m: CrewMember): { skills: string[]; fromRole: boolean } {
  if (m.skills && m.skills.length > 0) return { skills: [...new Set(m.skills)].sort(), fromRole: false };
  const r = (m.role || "").toLowerCase();
  const out = new Set<string>();
  if (r.includes("climb")) out.add("climbing");
  if (r.includes("ground")) out.add("ground_work");
  if (r.includes("contract")) out.add("climbing");
  return { skills: [...out].sort(), fromRole: true };
}

function weekDates(date: string): string[] {
  const wd = weekdayOf(date); // 0 = Sunday
  const back = (wd + 6) % 7; // days since Monday
  const d = parseISO(date);
  d.setDate(d.getDate() - back);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    out.push(toISODate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function timesheetMinutes(t: AppState["timesheets"][number]): number {
  if (t.hours != null) return Math.round(t.hours * 60);
  const a = parseHHMM(t.clockIn);
  const b = parseHHMM(t.clockOut);
  return a != null && b != null && b > a ? b - a : 0;
}

export function jobDays(job: Job): number {
  if (!job.endDate || job.endDate <= job.date) return 1;
  return daysBetweenISO(job.date, job.endDate) + 1;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 15;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function jobPosition(state: AppState, job: Job, opts: BuildPlannerOptions): LatLng | null {
  if (opts.coords && job.id in opts.coords) return opts.coords[job.id] ?? null;
  if (job.lat != null && job.lng != null) return { lat: job.lat, lng: job.lng };
  const c = state.customers.find((x) => x.id === job.customerId);
  if (!c || c.mapLat == null || c.mapLng == null) return null;
  // The customer's map pin is their primary property: use it only when
  // the job is at the primary address.
  const primaryId = (c.addresses ?? []).find((a) => a.isPrimary)?.id ?? null;
  if (job.addressId && primaryId && job.addressId !== primaryId) return null;
  return { lat: c.mapLat, lng: c.mapLng };
}

export function buildPlannerInput(
  state: AppState,
  date: string,
  opts: BuildPlannerOptions = {},
): PlannerInput {
  const mode: PlanMode = opts.mode ?? "keep";
  const settings: ResolvedPlannerSettings = resolvePlannerSettings(state.settings.planner);
  const flags: PlanFlag[] = [];
  const weekday = weekdayOf(date);
  const today = opts.today ?? date;
  const eqById = new Map(state.equipment.map((e) => [e.id, e]));

  // Equipment.
  const equipment: PlanEquipment[] = [...state.equipment]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      const reason =
        e.down === true
          ? "down"
          : e.status === "in_shop"
            ? "in the shop"
            : e.status !== "available"
              ? e.status
              : null;
      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        usable: reason == null,
        unusableReason: reason,
        tows: e.tows ?? null,
        seats: e.seats ?? null,
        weightLbs: e.weightLbs ?? null,
        weeklyDriverLimit: e.weeklyDriverLimit ?? null,
      };
    });
  const limited = new Set(equipment.filter((e) => e.weeklyDriverLimit != null).map((e) => e.id));

  // Jobs active on the date, highest value first.
  const active = state.jobs
    .filter((j) => j.status !== "done" && jobActiveOn(j, date))
    .map((j) => ({ j, value: Math.round(jobValue(state, j) ?? 0) }))
    .sort((a, b) => b.value - a.value || a.j.id.localeCompare(b.j.id));

  const positions: Array<LatLng | null> = [];
  const jobs: PlanJob[] = active.map(({ j, value }, i) => {
    const need = requiredCrew(state, j, date);
    // Equipment kinds: what is already on the job, else the service default.
    let kinds: EquipmentKind[] = [
      ...new Set(
        (j.equipmentIds ?? [])
          .map((id) => eqById.get(id)?.kind)
          .filter((k): k is EquipmentKind => k != null),
      ),
    ];
    if (kinds.length === 0) {
      kinds = [...(settings.defaultEquipmentByService[j.serviceType] ?? [])];
      if (kinds.length > 0) {
        flags.push({
          severity: "info",
          code: "NEEDS_GUESSED",
          jobId: j.id,
          text: `${j.title}: no equipment set on the job — assuming ${kinds.join(" + ")} for ${j.serviceType}.`,
        });
      }
    }
    kinds.sort();
    const skills = new Set<string>(settings.defaultSkillsByService[j.serviceType] ?? []);
    if (j.pruneClass === "2") skills.add("pruning");
    for (const k of kinds) {
      const s = EQUIPMENT_SKILL[k];
      if (s) skills.add(s);
    }
    // Climbers and groundsmen are counted by the crew rules, not here.
    skills.delete("climbing");
    skills.delete("ground_work");

    // Duration on this date.
    const dayLen = settings.dayEndMin - settings.dayStartMin;
    const days = jobDays(j);
    let durationMin: number;
    if (j.estimatedHours != null && j.estimatedHours > 0) {
      durationMin = Math.round((j.estimatedHours * 60) / days);
    } else {
      durationMin = days > 1 ? dayLen : Math.round((settings.defaultHoursByService[j.serviceType] ?? 4) * 60);
      flags.push({
        severity: "amber",
        code: "ASSUMED_HOURS",
        jobId: j.id,
        text: `${j.title}: no estimated hours — assuming ${Math.round(durationMin / 6) / 10} h.`,
      });
    }
    durationMin = Math.max(15, durationMin);

    const inProgress = j.status === "in_progress";
    const lock = mode === "keep" || inProgress;
    const typed = parseHHMM(j.startTime);
    const fixedTimes = opts.fixedTimes ?? "non-default";
    const fixedStartMin =
      // Only the first day of a multi-day job has a promised start.
      typed == null || date !== j.date || fixedTimes === "none"
        ? null
        : fixedTimes === "all" || (typed !== 8 * 60 && typed !== settings.dayStartMin)
          ? typed
          : null;

    positions.push(jobPosition(state, j, opts));
    return {
      id: j.id,
      title: j.title,
      serviceType: j.serviceType,
      value,
      durationMin,
      node: i + 1,
      climbers: need.climbers,
      groundsmen: need.groundsmen,
      allAvailable: need.allAvailable,
      cap: j.expectedCrew != null && j.expectedCrew > 0 ? Math.round(j.expectedCrew) : null,
      skills: [...skills].sort(),
      kinds,
      fixedStartMin,
      locked: lock
        ? {
            people: [...new Set(j.crewIds)].sort(),
            equipment: [...new Set(j.equipmentIds ?? [])].sort(),
            drivers: { ...(j.equipmentDrivers ?? {}) },
          }
        : { people: [], equipment: [], drivers: {} },
      inProgress,
      existingCrewIds: [...j.crewIds].sort(),
    };
  });

  // People.
  const weekOther = weekDates(date).filter((d) => d !== date);
  const people: PlanPerson[] = [];
  const off: PlannerInput["off"] = [];
  for (const m of [...state.crew].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isSchedulable(m)) continue; // not on the schedule at all
    if (isTimeOffOn(state.timeOff, m.id, date)) {
      off.push({ crewId: m.id, name: m.name, reason: "Approved time off" });
      continue;
    }
    if (isUnavailableOn(state.unavailability, m.id, date)) {
      off.push({ crewId: m.id, name: m.name, reason: "Marked unavailable" });
      continue;
    }
    const { skills, fromRole } = personSkills(m);
    if (skills.length === 0) {
      off.push({ crewId: m.id, name: m.name, reason: "No field skills recorded" });
      continue;
    }
    if (fromRole) {
      flags.push({
        severity: "info",
        code: "SKILLS_FROM_ROLE",
        personId: m.id,
        text: `${m.name}: no skills ticked — using the job role "${m.role}" (${skills.join(", ")}).`,
      });
    }
    let weekMinutes = 0;
    const vehicleUses: Record<string, number> = {};
    for (const d of weekOther) {
      if (d < today) {
        for (const t of state.timesheets) if (t.crewId === m.id && t.date === d) weekMinutes += timesheetMinutes(t);
      } else {
        for (const j of state.jobs) {
          if (j.crewIds.includes(m.id) && jobActiveOn(j, d)) {
            weekMinutes += Math.round(((j.estimatedHours ?? 0) * 60) / jobDays(j));
          }
        }
      }
      // Each (person, vehicle, date) counts once.
      const drove = new Set<string>();
      for (const j of state.jobs) {
        if (!jobActiveOn(j, d)) continue;
        const drivers = j.equipmentDrivers ?? {};
        for (const [eqId, who] of Object.entries(drivers)) {
          if (who === m.id && limited.has(eqId)) drove.add(eqId);
        }
        // A limited haul unit with no driver of its own was pulled by the job's truck
        // driver, when only one truck on the job has a driver recorded.
        const truckDrivers = Object.entries(drivers).filter(([eqId]) => eqById.get(eqId)?.kind === "Truck");
        if (truckDrivers.length === 1 && truckDrivers[0][1] === m.id) {
          for (const eqId of j.equipmentIds ?? []) {
            const kind = eqById.get(eqId)?.kind;
            if (limited.has(eqId) && kind !== "Truck" && drivers[eqId] == null) drove.add(eqId);
          }
        }
      }
      for (const eqId of drove) vehicleUses[eqId] = (vehicleUses[eqId] ?? 0) + 1;
    }
    people.push({
      id: m.id,
      name: m.name,
      skills,
      legalDriver: m.driverLicensed === true && m.companyInsured === true,
      cdlA: m.cdlClass === "A",
      canDrive: m.canDriveEquipment && m.canDriveEquipment.length > 0 ? [...m.canDriveEquipment].sort() : null,
      lastResort: m.lastResort === true,
      usualDay: isGenerallyAvailable(m, weekday),
      weekMinutes,
      worksWellWith: [...(m.worksWellWith ?? [])].sort(),
      vehicleUses,
    });
  }

  // Drive matrix: node 0 = yard, then each job.
  const yard: LatLng | null = opts.yard !== undefined ? opts.yard : plannerYard(state)?.at ?? null;
  if (!yard && jobs.length > 0) {
    flags.push({
      severity: "amber",
      code: "NO_YARD",
      text: "No shop location yet, so the first drive of each crew is not counted. Add the shop address in Schedule → Calendar settings → Company.",
    });
  }
  const fn = opts.driveMinutes ?? straightLineMinutes;
  if (!opts.driveMinutes && jobs.length > 0) {
    flags.push({
      severity: "info",
      code: "ESTIMATED_DRIVE",
      text: "Drive times are straight-line estimates (miles × 1.3 at 30 mph), not road times.",
    });
  }
  const pts: Array<LatLng | null> = [yard, ...positions];
  const n = pts.length;
  const drive: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const known: number[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const pa = pts[a];
      const pb = pts[b];
      if (pa && pb) {
        const v = Math.max(0, Math.round(fn(pa, pb)));
        drive[a][b] = v;
        if (a > 0 && b > 0) known.push(v);
      } else drive[a][b] = -1;
    }
  }
  const fallback = median(known);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (drive[a][b] !== -1) continue;
      // No yard: yard legs are free. A job with no position: the median leg.
      drive[a][b] = (a === 0 || b === 0) && !yard ? 0 : fallback;
    }
  }
  jobs.forEach((j, i) => {
    if (!positions[i]) {
      flags.push({
        severity: "amber",
        code: "NO_LOCATION",
        jobId: j.id,
        text: `${j.title}: no map position — drive times to it use a typical ${fallback} min leg.`,
      });
    }
  });

  return {
    date,
    mode,
    closed: isClosedDay(state.closedDays, date),
    settings,
    jobs,
    people,
    off,
    equipment,
    drive,
    hasYard: yard != null,
    inputFlags: flags,
  };
}
