/**
 * Day planner (auto-scheduler), stage 3a: the engine only, no UI.
 *
 *   const input = buildPlannerInput(state, date, { mode: "keep" });
 *   const plan = planDay(input);
 *   const patches = planToJobPatches(plan, state);
 *
 * Pure and synchronous; see plan.ts for the priority order.
 */
export { buildPlannerInput, plannerYard, jobActiveOn, personSkills, straightLineMinutes } from "./input";
export type { BuildPlannerOptions } from "./input";
export { planDay } from "./plan";
export { loadDriveTimes } from "./driveMatrix";
export type { DriveTimes } from "./driveMatrix";
export { planToJobPatches } from "./patches";
export type { JobPatch } from "./patches";
export { validatePlan } from "./validate";
export { resolvePlannerSettings, formatHHMM, parseHHMM } from "./settings";
export type { ResolvedPlannerSettings } from "./settings";
export { compareScores, scoreLayout } from "./engine";
export type * from "./types";
