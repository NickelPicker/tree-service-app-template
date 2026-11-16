/**
 * Day planner settings: the owner's values from settings.planner with a
 * default for every missing key. All numbers are whole minutes or
 * counts, so every score stays an integer.
 */
import type { EquipmentKind, PlannerSettings, ServiceType } from "../types";

export interface ResolvedPlannerSettings {
  clusterMaxMinutes: number;
  dayStartMin: number;
  dayEndMin: number;
  travelBufferMin: number;
  overrunToleranceMin: number;
  maxCrews: number;
  /** Largest crew the extras pass builds when Pat set no expected crew (default 4). */
  maxCrewSize: number;
  /** idleWeight × 100, so the efficiency tier stays an integer. */
  idleWeightPct: number;
  defaultHoursByService: Record<ServiceType, number>;
  defaultEquipmentByService: Record<ServiceType, EquipmentKind[]>;
  defaultSkillsByService: Record<ServiceType, string[]>;
  /** Combined truck + haul weight above this needs a CDL Class A driver. */
  cdlAWeightLbs: number;
  /** Plan board: dollars of job value a crew of up to fullSpeedCrew does per hour. */
  dollarsPerHour: number;
  fullSpeedCrew: number;
  minTeam: number;
  /** Per-service dollarsPerHour, only for service types the owner set one. */
  dollarsPerHourByService: Partial<Record<ServiceType, number>>;
  /** Search budget: partitions staffed and scored per plan. */
  evaluationBudget: number;
  /** Exact enumeration of every split up to this many job groups. */
  exactMaxGroups: number;
  /** Person swaps tried when repairing each of the best splits. */
  repairBudget: number;
  /** How many of the best splits get the swap repair. */
  repairTop: number;
}

export const DEFAULT_HOURS_BY_SERVICE: Record<ServiceType, number> = {
  Removal: 6,
  Trimming: 4,
  "Stump Grinding": 2,
  "Plant Health Care": 1,
  Fertilization: 1,
  Emergency: 4,
};

export const DEFAULT_EQUIPMENT_BY_SERVICE: Record<ServiceType, EquipmentKind[]> = {
  Removal: ["Chipper", "Dump trailer"],
  Trimming: ["Chipper"],
  Emergency: ["Chipper"],
  "Stump Grinding": ["Stump grinder"],
  "Plant Health Care": [],
  Fertilization: [],
};

export const DEFAULT_SKILLS_BY_SERVICE: Record<ServiceType, string[]> = {
  Removal: [],
  Trimming: [],
  Emergency: [],
  "Stump Grinding": ["stump_grinding"],
  "Plant Health Care": [],
  Fertilization: ["fertilization"],
};

/** "HH:MM" as minutes after midnight; null when blank or malformed. */
export function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes after midnight as "HH:MM". */
export function formatHHMM(min: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const int = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, Math.round(v)))
    : fallback;

export function resolvePlannerSettings(
  p: PlannerSettings | null | undefined,
): ResolvedPlannerSettings {
  const dayStartMin = parseHHMM(p?.dayStart) ?? 7 * 60;
  let dayEndMin = parseHHMM(p?.dayEnd) ?? 17 * 60;
  if (dayEndMin <= dayStartMin) dayEndMin = Math.min(24 * 60 - 1, dayStartMin + 10 * 60);
  const idle = typeof p?.idleWeight === "number" && Number.isFinite(p.idleWeight) ? p.idleWeight : 0.5;
  return {
    clusterMaxMinutes: int(p?.clusterMaxMinutes, 30, 1, 600),
    dayStartMin,
    dayEndMin,
    travelBufferMin: int(p?.travelBufferMin, 10, 0, 120),
    overrunToleranceMin: int(p?.overrunToleranceMin, 30, 0, 240),
    maxCrews: int(p?.maxCrews, 4, 1, 8),
    maxCrewSize: int(p?.maxCrewSize, 4, 1, 12),
    idleWeightPct: Math.min(100, Math.max(0, Math.round(idle * 100))),
    defaultHoursByService: { ...DEFAULT_HOURS_BY_SERVICE, ...(p?.defaultHoursByService ?? {}) },
    defaultEquipmentByService: {
      ...DEFAULT_EQUIPMENT_BY_SERVICE,
      ...(p?.defaultEquipmentByService ?? {}),
    },
    defaultSkillsByService: { ...DEFAULT_SKILLS_BY_SERVICE, ...(p?.defaultSkillsByService ?? {}) },
    cdlAWeightLbs: 26001,
    dollarsPerHour: int(p?.dollarsPerHour, 400, 50, 10000),
    fullSpeedCrew: int(p?.fullSpeedCrew, 3, 1, 12),
    minTeam: int(p?.minTeam, 2, 1, 6),
    dollarsPerHourByService: Object.fromEntries(
      Object.entries(p?.dollarsPerHourByService ?? {})
        .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0)
        .map(([k, v]) => [k, int(v, 400, 50, 10000)]),
    ) as Partial<Record<ServiceType, number>>,
    evaluationBudget: 5000,
    exactMaxGroups: 8,
    repairBudget: 300,
    repairTop: 6,
  };
}
