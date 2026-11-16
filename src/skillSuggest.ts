/**
 * Skill suggestions from what the app already knows about each person:
 * their job role, the jobs they have been on (service type, prune
 * class, the equipment on the job), who drove which piece of
 * equipment, and who is named as the applicator on chemical records.
 *
 * Suggestions only: the owner accepts or dismisses each one on the
 * Skills grid. A dismissed suggestion stays dismissed
 * (settings.planner.dismissedSkillSuggestions). Nothing here changes
 * anyone's skills by itself.
 */
import { isSchedulable } from "./crewSuggest";
import { skillCatalog } from "./skills";
import type { AppState, CrewMember, Job } from "./types";

export interface SkillSuggestion {
  /** Stable key, "crewId:skillId" (or "crewId:driving"). */
  key: string;
  crewId: string;
  personName: string;
  /** A skill id, or "driving" for the licence + insurance boxes. */
  skillId: string;
  skillLabel: string;
  /** Plain-English reason, e.g. "on 6 removals". */
  reason: string;
  /** Extra caution shown with the suggestion (licences). */
  caution?: string;
  /** How strong the evidence is (jobs counted); used for sorting. */
  weight: number;
}

const MIN_JOBS = 3;

function roleHas(m: CrewMember, ...words: string[]): boolean {
  const r = m.role.toLowerCase();
  return words.some((w) => r.includes(w));
}

/** Jobs a person was on, counting only work that happened (past or done). */
function workedJobs(state: AppState, m: CrewMember, today: string): Job[] {
  return state.jobs.filter(
    (j) => j.crewIds.includes(m.id) && (j.status === "done" || j.date < today),
  );
}

export function skillSuggestions(state: AppState, today: string): SkillSuggestion[] {
  const catalog = skillCatalog(state);
  const label = new Map(catalog.map((s) => [s.id, s.label]));
  const dismissed = new Set(state.settings.planner?.dismissedSkillSuggestions ?? []);
  const kindOf = new Map(state.equipment.map((e) => [e.id, e.kind]));
  const out: SkillSuggestion[] = [];

  for (const m of state.crew) {
    if (m.status === "pending" || m.status === "revoked" || !isSchedulable(m)) continue;
    const has = new Set(m.skills ?? []);
    const add = (skillId: string, reason: string, weight: number, caution?: string) => {
      if (skillId !== "driving" && (!label.has(skillId) || has.has(skillId))) return;
      const key = `${m.id}:${skillId}`;
      if (dismissed.has(key) || out.some((s) => s.key === key)) return;
      out.push({
        key,
        crewId: m.id,
        personName: m.name,
        skillId,
        skillLabel:
          skillId === "driving"
            ? "Driver (licence + on insurance)"
            : (label.get(skillId) ?? skillId),
        reason,
        caution,
        weight,
      });
    };

    const jobs = workedJobs(state, m, today);
    const count = (pred: (j: Job) => boolean) => jobs.filter(pred).length;
    const climber = roleHas(m, "climb");
    const ground = roleHas(m, "ground");

    // From the job role written on their profile.
    if (climber) {
      add("climbing", `job role is "${m.role}"`, 5);
      add("chainsaw_tree", `job role is "${m.role}"`, 4);
    }
    if (ground) {
      add("ground_work", `job role is "${m.role}"`, 5);
      add("chainsaw_ground", `job role is "${m.role}"`, 3);
      add("cleanup", `job role is "${m.role}"`, 3);
    }
    if (roleHas(m, "sales", "estimat")) {
      add("estimating", `job role is "${m.role}"`, 5);
      add("sales_walkthrough", `job role is "${m.role}"`, 4);
      add("customer_comms", `job role is "${m.role}"`, 3);
    }
    if (roleHas(m, "foreman", "lead")) add("crew_lead", `job role is "${m.role}"`, 5);

    // From the jobs they have worked.
    const removals = count((j) => j.serviceType === "Removal" || j.serviceType === "Emergency");
    const trims = count((j) => j.serviceType === "Trimming");
    const stumps = count((j) => j.serviceType === "Stump Grinding");
    const phc = count((j) => j.serviceType === "Plant Health Care" || j.serviceType === "Fertilization");
    const class2 = count((j) => j.pruneClass === "2");
    if (removals >= MIN_JOBS) add("removals", `on ${removals} removal jobs`, removals);
    if (climber && trims >= MIN_JOBS) add("pruning", `climbed on ${trims} trimming jobs`, trims);
    if (climber && class2 >= 2) add("pruning", `on ${class2} Class II prunes`, class2);
    if (stumps >= 2) add("stump_grinding", `on ${stumps} stump grinding jobs`, stumps);
    if (phc >= 2) add("fertilization", `on ${phc} plant health care jobs`, phc);

    const withKind = (kind: string) =>
      count((j) => (j.equipmentIds ?? []).some((id) => kindOf.get(id) === kind));
    const chipperJobs = withKind("Chipper");
    if (chipperJobs >= MIN_JOBS && !climber) {
      add("chipper", `on ${chipperJobs} jobs that used the chipper`, chipperJobs);
    }
    const skidJobs = withKind("Mini skid");
    if (skidJobs >= 2) add("mini_skid", `on ${skidJobs} jobs that used the mini skid`, skidJobs);
    const grinderJobs = withKind("Stump grinder");
    if (grinderJobs >= 2) add("stump_grinding", `on ${grinderJobs} jobs that used the stump grinder`, grinderJobs);

    // From who drove what.
    let drives = 0;
    let tows = 0;
    for (const j of jobs) {
      for (const [eqId, driverId] of Object.entries(j.equipmentDrivers ?? {})) {
        if (driverId !== m.id) continue;
        drives++;
        const k = kindOf.get(eqId);
        if (k && k !== "Truck" && k !== "Other") tows++;
      }
    }
    if (drives >= 1 && !(m.driverLicensed && m.companyInsured)) {
      add(
        "driving",
        `drove company equipment ${drives} time${drives === 1 ? "" : "s"}`,
        drives,
        "Accept only if they hold a valid licence and are on the company insurance.",
      );
    }
    if (tows >= 2) add("trailer_towing", `hauled a trailer or the chipper ${tows} times`, tows);

    // Named as the applicator on chemical records.
    const name = m.name.trim().toLowerCase();
    const applied = name
      ? state.chemicalRecords.filter((r) => r.applicator.trim().toLowerCase() === name).length
      : 0;
    if (applied >= 1) {
      add(
        "qs_pesticide",
        `applicator on ${applied} chemical record${applied === 1 ? "" : "s"}`,
        applied,
        "Accept only if they hold the QS licence.",
      );
    }
  }
  return out.sort((a, b) => a.personName.localeCompare(b.personName) || b.weight - a.weight);
}
