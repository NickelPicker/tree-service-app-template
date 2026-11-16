/**
 * What applying a plan would change on each job, as plain patches. The
 * UI stage applies them in one mutate (applyDayPlan); nothing here
 * writes anything.
 *
 * - crewIds: the whole crew (a crew stays together all day).
 * - equipmentIds: the crew's trucks, haul units, carried machines and
 *   loose items.
 * - equipmentDrivers: each truck's driver; the truck's haul unit and
 *   carried machines list the same driver, so every piece shows who
 *   brings it.
 * - suggestedStartTime: the plan's start time ("HH:MM"), a suggestion
 *   only — the apply step decides whether to write it.
 * Jobs left out of the plan get empty assignments (they had no locks,
 * or they could not have been left out).
 */
import type { AppState } from "../types";
import { formatHHMM } from "./settings";
import type { DayPlan } from "./types";

export interface JobPatch {
  crewIds: string[];
  equipmentIds: string[];
  equipmentDrivers: Record<string, string>;
  suggestedStartTime: string | null;
  /** True when this differs from what the job has now. */
  changed: boolean;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

const sameMap = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join("\u0000") === kb.join("\u0000") && ka.every((k) => a[k] === b[k]);
};

export function planToJobPatches(plan: DayPlan, state: AppState): Record<string, JobPatch> {
  const out: Record<string, JobPatch> = {};
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  const make = (
    jobId: string,
    crewIds: string[],
    equipmentIds: string[],
    equipmentDrivers: Record<string, string>,
    suggestedStartTime: string | null,
  ) => {
    const job = jobs.get(jobId);
    if (!job) return;
    out[jobId] = {
      crewIds,
      equipmentIds,
      equipmentDrivers,
      suggestedStartTime,
      changed:
        !sameSet(job.crewIds, crewIds) ||
        !sameSet(job.equipmentIds ?? [], equipmentIds) ||
        !sameMap(job.equipmentDrivers ?? {}, equipmentDrivers) ||
        (suggestedStartTime != null && suggestedStartTime !== job.startTime),
    };
  };
  for (const c of plan.crews) {
    const equipmentIds = [...c.rigs.flatMap((r) => [r.truckId, r.haulId, ...r.carriedIds]), ...c.looseIds].sort();
    const drivers: Record<string, string> = {};
    for (const r of c.rigs) {
      const d = c.drivers[r.truckId];
      if (!d) continue;
      for (const id of [r.truckId, r.haulId, ...r.carriedIds]) drivers[id] = d;
    }
    for (const st of c.stops) {
      make(st.jobId, [...c.memberIds].sort(), equipmentIds, { ...drivers }, formatHHMM(st.startMin));
    }
  }
  for (const np of plan.notPlaced) make(np.jobId, [], [], {}, null);
  return out;
}
