/**
 * Synthetic fixtures for the planner tests. No live data: names, ids
 * and positions are made up.
 */
import { expect } from "vitest";
import type { AppState, CrewMember, CrewRule, Equipment, Job } from "../../types";
import { buildPlannerInput, type BuildPlannerOptions } from "../input";
import { planDay } from "../plan";
import type { DayPlan, PlannerInput } from "../types";
import { validatePlan } from "../validate";

/** A Wednesday. */
export const DATE = "2026-11-18";
export const MONDAY = "2026-11-16";
export const TUESDAY = "2026-11-17";
export const YARD = { lat: 39.7, lng: -105.0 };

/** One fixed rule: every job needs 1 climber + 1 groundsman. */
export const BASIC_RULES: CrewRule[] = [
  { id: "r1", name: "Every job", condition: { kind: "always" }, climbers: 1, groundsmen: 1, enabled: true },
];

export function baseState(over: Partial<AppState> = {}): AppState {
  const s = {
    customers: [],
    crew: [],
    jobs: [],
    estimates: [],
    invoices: [],
    timesheets: [],
    notes: [],
    threads: [],
    messages: [],
    auditLog: [],
    automations: [],
    settings: {
      autoClock: false,
      dailyTarget: 0,
      suggestDays: false,
      hoverRoute: false,
      showDayTotals: false,
      commercialTermsDays: 30,
      residentialTermsDays: 0,
      crewRules: BASIC_RULES,
      planner: null,
    },
    trees: [],
    equipment: [],
    maintenanceTasks: [],
    maintenanceRecords: [],
    equipmentNotes: [],
    phcPrograms: [],
    phcVisits: [],
    chemicalRecords: [],
    timeOff: [],
    closedDays: [],
    bookingRequests: [],
    dayCrews: [],
    unavailability: [],
    locationRequests: [],
    crewLocations: [],
  } as unknown as AppState;
  return { ...s, ...over };
}

export function person(id: string, skills: string[], over: Partial<CrewMember> = {}): CrewMember {
  return {
    id,
    name: id.toUpperCase(),
    role: "Crew",
    phone: "",
    color: "#000",
    appRole: "crew",
    email: "",
    status: "active",
    skills,
    driverLicensed: false,
    companyInsured: false,
    cdlClass: "none",
    lastResort: false,
    availableWeekdays: null,
    canDriveEquipment: null,
    worksWellWith: null,
    ...over,
  };
}

/** A legal driver (licensed and insured). */
export const driver = (id: string, skills: string[], over: Partial<CrewMember> = {}) =>
  person(id, skills, { driverLicensed: true, companyInsured: true, ...over });

export function equip(id: string, kind: Equipment["kind"], over: Partial<Equipment> = {}): Equipment {
  return { id, name: id, kind, details: "", status: "available", down: false, tows: null, seats: null, weightLbs: null, weeklyDriverLimit: null, ...over };
}

export function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    customerId: "c1",
    serviceType: "Trimming",
    title: id,
    date: DATE,
    startTime: "08:00",
    status: "scheduled",
    crewIds: [],
    notes: "",
    customerNotes: "",
    teamNotes: "",
    officeNotes: "",
    pruneClass: null,
    estimatedHours: 2,
    estimateId: null,
    invoiceId: null,
    value: 1000,
    treeIds: [],
    equipmentIds: [],
    equipmentDrivers: null,
    expectedCrew: null,
    endDate: null,
    recurring: null,
    recurringUntil: null,
    materialsCost: null,
    otherCost: null,
    laborRate: null,
    lat: YARD.lat + 0.01,
    lng: YARD.lng + 0.01,
    ...over,
  };
}

/** A standard rig set: two trucks, a chipper, a dump trailer, an equipment trailer. */
export function fleet(): Equipment[] {
  return [
    equip("truck-a", "Truck"),
    equip("truck-b", "Truck"),
    equip("chipper", "Chipper"),
    equip("dump", "Dump trailer"),
    equip("eqtrailer", "Equipment trailer"),
  ];
}

export function run(state: AppState, opts: BuildPlannerOptions = {}): { input: PlannerInput; plan: DayPlan } {
  const input = buildPlannerInput(state, DATE, { yard: YARD, ...opts });
  const plan = planDay(input);
  expect(validatePlan(input, plan)).toEqual([]);
  expect(plan.flags.filter((f) => f.code === "PLAN_CHECK_FAILED")).toEqual([]);
  return { input, plan };
}

export const crewOf = (plan: DayPlan, jobId: string) => plan.crews.find((c) => c.stops.some((s) => s.jobId === jobId));
export const codes = (plan: DayPlan) => plan.flags.map((f) => f.code);
export const flagsFor = (plan: DayPlan, code: string) => plan.flags.filter((f) => f.code === code);
