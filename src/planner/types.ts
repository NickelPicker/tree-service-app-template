/**
 * Day planner data shapes. Everything here is plain data (no Maps,
 * no functions), so a PlannerInput or a DayPlan can be logged, stored
 * or sent to a Web Worker as JSON.
 */
import type { EquipmentKind, ServiceType } from "../types";
import type { ResolvedPlannerSettings } from "./settings";

export type PlanMode = "keep" | "replan";

/** One job active on the planned date. */
export interface PlanJob {
  id: string;
  title: string;
  serviceType: ServiceType;
  /** Job value in whole dollars (jobValue, else 0). */
  value: number;
  /** Minutes of work on this date. */
  durationMin: number;
  /** Row/column of this job in PlannerInput.drive (0 is the yard). */
  node: number;
  /** Crew rule minimums: people with skill "climbing" / "ground_work". */
  climbers: number;
  groundsmen: number;
  /** A matching crew rule says "everyone available". */
  allAvailable: boolean;
  /** The estimator's expected crew: a hard cap. Null = no cap. */
  cap: number | null;
  /** Skills that must be on site (besides the climber/groundsman counts). */
  skills: string[];
  /** Equipment kinds the crew must bring. */
  kinds: EquipmentKind[];
  /** A start time typed on the job that the plan must respect, in minutes after midnight. */
  fixedStartMin: number | null;
  /** Assignments the planner must keep (mode "keep", or a job in progress). */
  locked: {
    people: string[];
    equipment: string[];
    /** equipment id -> crew id */
    drivers: Record<string, string>;
  };
  inProgress: boolean;
  /** Assignment on the job before planning (for the churn tier). */
  existingCrewIds: string[];
}

export interface PlanPerson {
  id: string;
  name: string;
  skills: string[];
  legalDriver: boolean;
  cdlA: boolean;
  /** Equipment ids this person may drive; null = no restriction recorded. */
  canDrive: string[] | null;
  lastResort: boolean;
  /** The date is one of their usual weekdays. */
  usualDay: boolean;
  /** Minutes already worked or planned on other days of the same week. */
  weekMinutes: number;
  worksWellWith: string[];
  /** Times this person drove a limited vehicle on other days this week: equipment id -> count. */
  vehicleUses: Record<string, number>;
}

export type HaulKind = "Chipper" | "Dump trailer" | "Equipment trailer" | "Trailer";

export interface PlanEquipment {
  id: string;
  name: string;
  kind: EquipmentKind;
  usable: boolean;
  /** Why it is not usable ("down", "in the shop", "retired"). */
  unusableReason: string | null;
  /** Trucks: ids this truck may tow; null = any. */
  tows: string[] | null;
  seats: number | null;
  weightLbs: number | null;
  weeklyDriverLimit: number | null;
}

export interface PlannerInput {
  date: string;
  mode: PlanMode;
  closed: boolean;
  settings: ResolvedPlannerSettings;
  /** Active jobs, highest value first (ties by id). */
  jobs: PlanJob[];
  /** People who can work today, by id. */
  people: PlanPerson[];
  /** People who cannot work today, with the reason. */
  off: Array<{ crewId: string; name: string; reason: string }>;
  equipment: PlanEquipment[];
  /** Drive minutes between nodes: 0 = yard, job.node = that job. */
  drive: number[][];
  /** False when there is no yard point: yard legs are then 0. */
  hasYard: boolean;
  /** Flags found while reading the data (assumed hours, guessed needs, …). */
  inputFlags: PlanFlag[];
}

export type FlagSeverity = "red" | "amber" | "info";

export interface PlanFlag {
  severity: FlagSeverity;
  code: string;
  jobId?: string;
  crewKey?: string;
  personId?: string;
  equipmentId?: string;
  text: string;
}

export interface Rig {
  truckId: string;
  haulId: string;
  carriedIds: string[];
}

export interface PlanStop {
  jobId: string;
  startMin: number;
  endMin: number;
  /** Drive minutes into this stop (from the yard or the previous stop). */
  driveInMin: number;
}

export interface PlanCrew {
  key: string;
  name: string;
  memberIds: string[];
  rigs: Rig[];
  /** Equipment with no towing role that rides along ("Other"). */
  looseIds: string[];
  /** truck id -> crew id of its driver. */
  drivers: Record<string, string>;
  stops: PlanStop[];
  /** Drive minutes for the whole route, yard to yard. */
  driveMin: number;
  idleMin: number;
}

export interface Decision {
  /** A person or equipment id. */
  subject: string;
  /** A crew key, or "spare" / "off". */
  placedOn: string;
  because: string[];
}

export interface DayPlan {
  date: string;
  mode: PlanMode;
  crews: PlanCrew[];
  notPlaced: Array<{ jobId: string; reason: string }>;
  spare: Array<{ crewId: string; reason: string }>;
  off: Array<{ crewId: string; name: string; reason: string }>;
  flags: PlanFlag[];
  decisions: Decision[];
  /** Tier vector, compared left to right, lower is better (see score.ts). */
  score: number[];
  stats: {
    evaluations: number;
    exact: boolean;
    repairs: number;
    budget: number;
  };
}
