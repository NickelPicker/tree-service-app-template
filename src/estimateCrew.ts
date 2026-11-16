/**
 * Equipment and crew on the estimate (requested: "when
 * writing the estimate I need the equipment needed for the job on there
 * as well. Ideally expected crew can be clickable").
 *
 * All of it is internal: never in the customer's email, the accept
 * page, the portal or "Customer said yes" (estimateForCustomer and
 * estimateEmail build the customer copy from a fixed list of fields).
 */
import type { AppState, CrewMember, Equipment, Estimate, Job } from "./types";
import { isSchedulable } from "./crewSuggest";
import { isFieldCrew } from "./planner/board";
import { isUnavailableOn } from "./unavailability";
import { isTimeOffOn } from "./utils";

/** The crew fields on an estimate the form edits. */
export interface EstimateCrewPick {
  expectedClimbers?: number | null;
  expectedGroundsmen?: number | null;
  expectedCrewIds?: string[] | null;
}

const count = (n: number | null | undefined): number =>
  n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

/**
 * The expected-crew total the rest of the app reads (crew-suggestion
 * cap, planner cap): the named people when names were picked,
 * otherwise climbers + groundsmen. Null = nothing set.
 */
export function crewTotal(pick: EstimateCrewPick): number | null {
  const named = new Set(pick.expectedCrewIds ?? []).size;
  if (named > 0) return named;
  const n = count(pick.expectedClimbers) + count(pick.expectedGroundsmen);
  return n > 0 ? n : null;
}

/**
 * A stepper changed: the new counts (both null when both are 0, so an
 * untouched estimate stays "not set") and the new total.
 */
export function withCounts(
  pick: EstimateCrewPick,
  climbers: number,
  groundsmen: number,
): Required<EstimateCrewPick> & { expectedCrew: number | null } {
  const c = Math.max(0, Math.min(50, Math.round(climbers)));
  const g = Math.max(0, Math.min(50, Math.round(groundsmen)));
  const none = c === 0 && g === 0;
  const next = {
    expectedClimbers: none ? null : c,
    expectedGroundsmen: none ? null : g,
    expectedCrewIds: pick.expectedCrewIds ?? null,
  };
  return { ...next, expectedCrew: crewTotal(next) };
}

/** Tap a name on or off. */
export function withCrewToggled(
  pick: EstimateCrewPick,
  crewId: string,
): Required<EstimateCrewPick> & { expectedCrew: number | null } {
  const ids = pick.expectedCrewIds ?? [];
  const nextIds = ids.includes(crewId) ? ids.filter((x) => x !== crewId) : [...ids, crewId];
  const next = {
    expectedClimbers: pick.expectedClimbers ?? null,
    expectedGroundsmen: pick.expectedGroundsmen ?? null,
    expectedCrewIds: nextIds.length > 0 ? nextIds : null,
  };
  return { ...next, expectedCrew: crewTotal(next) };
}

/** Tap a piece of equipment on or off. Null when none is left. */
export function toggleId(ids: string[] | null | undefined, id: string): string[] | null {
  const list = ids ?? [];
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return next.length > 0 ? next : null;
}

/** The people the estimate form offers: active field crew. */
export function estimateCrewChoices(state: AppState): CrewMember[] {
  return state.crew.filter((c) => isSchedulable(c) && isFieldCrew(c));
}

/** The fleet the estimate form offers: everything not retired. */
export function estimateEquipmentChoices(state: AppState): Equipment[] {
  return state.equipment.filter((e) => e.status !== "retired");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One line for the form: "Crew: 1 climber + 2 groundsmen · Equipment:
 * Chip truck, Chipper". Empty when nothing is set. Names of people or
 * equipment that were since removed are left out.
 */
export function crewEquipmentSummary(
  e: EstimateCrewPick & { expectedCrew?: number | null; equipmentIds?: string[] | null },
  crew: CrewMember[],
  equipment: Equipment[],
): string {
  const parts: string[] = [];
  const names = (e.expectedCrewIds ?? [])
    .map((id) => crew.find((c) => c.id === id)?.name)
    .filter((n): n is string => Boolean(n));
  const c = count(e.expectedClimbers);
  const g = count(e.expectedGroundsmen);
  if (names.length > 0) parts.push(`Crew: ${names.join(", ")}`);
  else if (c + g > 0) {
    const bits = [
      ...(c > 0 ? [plural(c, "climber", "climbers")] : []),
      ...(g > 0 ? [plural(g, "groundsman", "groundsmen")] : []),
    ];
    parts.push(`Crew: ${bits.join(" + ")}`);
  } else if (e.expectedCrew != null && e.expectedCrew > 0) {
    parts.push(`Crew: ${plural(e.expectedCrew, "person", "people")}`);
  }
  const eq = (e.equipmentIds ?? [])
    .map((id) => equipment.find((x) => x.id === id)?.name)
    .filter((n): n is string => Boolean(n));
  if (eq.length > 0) parts.push(`Equipment: ${eq.join(", ")}`);
  return parts.join(" · ");
}

// The estimate's counts as the job's crew requirement live in
// crewSuggest.ts (it reads them in requiredCrew).
export { estimateCrewNeed } from "./crewSuggest";

/**
 * What the estimate adds to a job made from it:
 *  - equipment: merged into the job's equipment, no duplicates;
 *  - named crew: only when the job has a day, and only people who are
 *    active and not on time off or marked unavailable that day (the
 *    same filter the crew suggestion uses); the rest are listed in
 *    `skipped` by name;
 *  - expectedCrew: the job's own, else the estimate's total.
 */
export function planFromEstimate(
  state: Pick<AppState, "crew" | "timeOff" | "unavailability">,
  job: Pick<Job, "date" | "crewIds" | "equipmentIds" | "expectedCrew">,
  est: Pick<Estimate, "equipmentIds" | "expectedCrewIds" | "expectedCrew">,
): { equipmentIds: string[]; crewIds: string[]; expectedCrew: number | null; skipped: string[] } {
  const equipmentIds = [...new Set([...(job.equipmentIds ?? []), ...(est.equipmentIds ?? [])])];
  const crewIds = [...job.crewIds];
  const skipped: string[] = [];
  if (job.date) {
    for (const id of new Set(est.expectedCrewIds ?? [])) {
      if (crewIds.includes(id)) continue;
      const m = state.crew.find((c) => c.id === id);
      if (!m) continue;
      if (
        !isSchedulable(m) ||
        isTimeOffOn(state.timeOff, id, job.date) ||
        isUnavailableOn(state.unavailability, id, job.date)
      ) {
        skipped.push(m.name);
        continue;
      }
      crewIds.push(id);
    }
  }
  return {
    equipmentIds,
    crewIds,
    expectedCrew: job.expectedCrew ?? est.expectedCrew ?? null,
    skipped,
  };
}
