/**
 * The team's skill list (what the auto-scheduler can ask for).
 *
 * Each person has a set of skill ids (crew.skills). The list itself is
 * the owner's: it starts with the catalog below and lives in
 * settings.planner.skillCatalog once the owner adds, renames or removes
 * a skill on the Skills page. Skills are plain checkboxes per person:
 * nothing is inferred from the job role.
 *
 * Driving is NOT a skill here: licence, company insurance and CDL class
 * are separate fields on the person (crew.driver_licensed,
 * company_insured, cdl_class), because they gate who may drive.
 */
import type { AppState, SkillDef } from "./types";

export const SKILL_GROUPS = [
  "Climbing & tree work",
  "Ground & cleanup",
  "Equipment operation",
  "Plant health care",
  "Sales & office",
  "Safety & leadership",
  "Licences & credentials",
  "Other",
] as const;

/** The starter catalog (starter set). Ids never change. */
export const DEFAULT_SKILLS: SkillDef[] = [
  { id: "climbing", label: "Climbing (rope & saddle)", group: "Climbing & tree work" },
  { id: "rigging", label: "Rigging / lowering", group: "Climbing & tree work" },
  { id: "removals", label: "Removals", group: "Climbing & tree work" },
  { id: "pruning", label: "Pruning", group: "Climbing & tree work" },
  { id: "crane_removals", label: "Crane-assisted removals", group: "Climbing & tree work" },
  { id: "aerial_rescue", label: "Aerial rescue", group: "Climbing & tree work" },
  { id: "chainsaw_tree", label: "Chainsaw (in tree)", group: "Climbing & tree work" },
  { id: "chainsaw_ground", label: "Chainsaw (ground)", group: "Climbing & tree work" },
  { id: "ground_work", label: "Ground work / drag & chip", group: "Ground & cleanup" },
  { id: "chipper", label: "Chipper operation", group: "Ground & cleanup" },
  { id: "stump_grinding", label: "Stump grinding", group: "Ground & cleanup" },
  { id: "cleanup", label: "Site cleanup / raking", group: "Ground & cleanup" },
  { id: "mini_skid", label: "Mini skid steer", group: "Equipment operation" },
  { id: "skid_loader", label: "Skid steer / loader", group: "Equipment operation" },
  { id: "dump_truck", label: "Dump truck", group: "Equipment operation" },
  { id: "bucket_truck", label: "Bucket truck / forestry truck", group: "Equipment operation" },
  { id: "chip_truck", label: "Chip truck", group: "Equipment operation" },
  { id: "trailer_towing", label: "Trailer towing", group: "Equipment operation" },
  { id: "qs_pesticide", label: "Spraying / pesticide application (QS license)", group: "Plant health care" },
  { id: "fertilization", label: "Fertilization & soil care", group: "Plant health care" },
  { id: "risk_assessment", label: "Tree risk assessment", group: "Plant health care" },
  { id: "phc_diagnosis", label: "PHC inspection / diagnosis", group: "Plant health care" },
  { id: "estimating", label: "Estimating / quoting", group: "Sales & office" },
  { id: "sales_walkthrough", label: "Sales walkthrough", group: "Sales & office" },
  { id: "customer_comms", label: "Customer communication", group: "Sales & office" },
  { id: "dispatch", label: "Scheduling / dispatch", group: "Sales & office" },
  { id: "first_aid", label: "First aid / CPR", group: "Safety & leadership" },
  { id: "crew_lead", label: "Crew lead / foreman", group: "Safety & leadership" },
  { id: "isa_arborist", label: "ISA Certified Arborist", group: "Licences & credentials" },
  { id: "municipal_arborist", label: "Municipal arborist licence (your city)", group: "Licences & credentials" },
];

/** The skill list in force: the owner's saved list, else the starter catalog. */
export function skillCatalog(state: AppState | null | undefined): SkillDef[] {
  const saved = state?.settings.planner?.skillCatalog;
  return saved && saved.length > 0 ? saved : DEFAULT_SKILLS;
}

/** The catalog grouped for display, in SKILL_GROUPS order (unknown groups last). */
export function skillsByGroup(catalog: SkillDef[]): Array<{ group: string; skills: SkillDef[] }> {
  const order = new Map<string, number>(SKILL_GROUPS.map((g, i) => [g, i]));
  const groups = new Map<string, SkillDef[]>();
  for (const s of catalog) {
    const g = s.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  return [...groups.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99) || a[0].localeCompare(b[0]))
    .map(([group, skills]) => ({ group, skills }));
}

/** A new skill id from its label: lowercase words joined by "_", made unique. */
export function newSkillId(label: string, catalog: SkillDef[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "skill";
  const taken = new Set(catalog.map((s) => s.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** True when this person may legally drive company vehicles. */
export function isLegalDriver(m: {
  driverLicensed?: boolean | null;
  companyInsured?: boolean | null;
}): boolean {
  return m.driverLicensed === true && m.companyInsured === true;
}
