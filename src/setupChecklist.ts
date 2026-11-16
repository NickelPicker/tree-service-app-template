/**
 * "Finish setting up" (owners and managers): a short checklist that
 * ticks itself from the company's real data and disappears once every
 * item is done. No React here so it is unit tested on its own.
 *
 * Gmail is listed only when the app knows the answer (the newest
 * automatic-email run says whether the Gmail app password is saved).
 * The test-email recipients are a GitHub setting the app cannot see,
 * so they are not listed.
 */
import type { AppState, CrewMember, Equipment, EquipmentKind } from "./types";
import type { View } from "./store";
import { documentStatus } from "./companyDocuments";
import { isSchedulable } from "./crewSuggest";

export type SetupItemId =
  | "company"
  | "pay"
  | "review"
  | "site"
  | "truckWeights"
  | "parkedAt"
  | "skills"
  | "insurance"
  | "gmail";

export interface SetupItem {
  id: SetupItemId;
  label: string;
  done: boolean;
  /** One line: how to do it. */
  how: string;
  /** What is still missing, e.g. "Truck 2, Big Truck" (empty when done). */
  missing: string;
  /** Page the button opens. */
  view: View;
  button: string;
}

export interface SetupInput {
  state: Pick<AppState, "settings" | "equipment" | "crew" | "companyDocuments">;
  today: string;
  /** From the newest automatic-email run; null = unknown (item left out). */
  gmailReady: boolean | null;
}

const filled = (v: string | null | undefined) => (v ?? "").trim() !== "";

function names(list: Array<{ name: string }>, max = 3): string {
  const shown = list.slice(0, max).map((x) => x.name || "(no name)");
  return list.length > max ? `${shown.join(", ")} +${list.length - max} more` : shown.join(", ");
}

/** Login roles that are office staff, not field crew. */
const OFFICE_ROLES = new Set(["owner", "manager", "office"]);

/**
 * People who need a skill for "Crew skills": the active roster on the
 * Skills grid (Users → 🧰 Skills grid), without office staff (owner,
 * manager and office logins; business rule: "leave office staff
 * out of crew have skills").
 */
export function skillsPeople(crew: CrewMember[]): CrewMember[] {
  return crew.filter(
    (c) =>
      c.status !== "pending" &&
      c.status !== "revoked" &&
      isSchedulable(c) &&
      !OFFICE_ROLES.has(c.appRole),
  );
}

/**
 * Equipment that needs a weight (business rule): trucks, trailers
 * and the chipper. A truck's weight decides who may drive it with a
 * trailer; a trailer's or chipper's is part of the combined weight.
 */
export const NEEDS_WEIGHT: ReadonlySet<EquipmentKind> = new Set<EquipmentKind>([
  "Truck",
  "Trailer",
  "Dump trailer",
  "Equipment trailer",
  "Chipper",
]);

function inUse(eq: Equipment[]): Equipment[] {
  return eq.filter((e) => e.status !== "retired");
}

export function setupChecklist({ state, today, gmailReady }: SetupInput): SetupItem[] {
  const company = state.settings.company ?? null;
  const equipment = inUse(state.equipment);
  const trucksNoWeight = equipment.filter((e) => NEEDS_WEIGHT.has(e.kind) && !(Number(e.weightLbs) > 0));
  const notParked = equipment.filter((e) => !filled(e.homeSite));
  const noSkills = skillsPeople(state.crew).filter((c) => (c.skills ?? []).length === 0);
  const companyMissing = [
    !filled(company?.name) && "name",
    !filled(company?.phone) && "phone",
    !filled(company?.email) && "email",
  ].filter((x): x is string => Boolean(x));
  const insurance = (state.companyDocuments ?? []).some(
    (d) =>
      d.kind === "liability_insurance" &&
      d.crewId === null &&
      filled(d.fileId) &&
      documentStatus(d, today).kind !== "expired",
  );

  const items: SetupItem[] = [
    {
      id: "company",
      label: "Company details",
      done: companyMissing.length === 0,
      how: "Schedule → Calendar settings → Company: business name, phone and email.",
      missing: companyMissing.length ? `Missing ${companyMissing.join(", ")}` : "",
      view: "schedule",
      button: "Open Schedule",
    },
    {
      id: "pay",
      label: "How customers pay",
      done: filled(company?.zelleNumber) || filled(company?.checkPayee),
      how: "Invoices → Invoice settings → How customers pay: a Zelle number or who checks are made out to.",
      missing: "",
      view: "invoices",
      button: "Open Invoices",
    },
    {
      id: "review",
      label: "Review link",
      done: filled(company?.reviewUrl),
      how: "Invoices → Invoice settings → Review link (Google): paste your Google review link.",
      missing: "",
      view: "invoices",
      button: "Open Invoices",
    },
    {
      id: "site",
      label: "Shop or yard",
      done: (company?.sites ?? []).some((s) => filled(s.address)),
      how: "Schedule → Calendar settings → Company → Shop/yard: add at least one address (planning and clock-in start there).",
      missing: "",
      view: "schedule",
      button: "Open Schedule",
    },
    {
      id: "truckWeights",
      label: "Every truck, trailer and chipper in use has a weight",
      done: trucksNoWeight.length === 0,
      how: "Equipment → tap the truck, trailer or chipper → Edit → Weight (lb). Needed to know who may drive with a trailer.",
      missing: trucksNoWeight.length ? `No weight: ${names(trucksNoWeight)}` : "",
      view: "equipment",
      button: "Open Equipment",
    },
    {
      id: "parkedAt",
      label: "Where equipment is parked",
      done: notParked.length === 0,
      how: "Equipment → tap a machine → Edit → Parked at: pick the shop or yard.",
      missing: notParked.length ? `Not set: ${names(notParked)}` : "",
      view: "equipment",
      button: "Open Equipment",
    },
    {
      id: "skills",
      label: "Crew skills",
      done: noSkills.length === 0,
      how: "Users → 🧰 Skills grid: tick what each person can do (the planner uses it).",
      missing: noSkills.length ? `No skills: ${names(noSkills)}` : "",
      view: "users",
      button: "Open Users",
    },
    {
      id: "insurance",
      label: "Liability insurance",
      done: insurance,
      how: "More → Licences & insurance → Add: General liability insurance, with the policy PDF or photo uploaded.",
      missing: "",
      view: "documents",
      button: "Open Licences & insurance",
    },
  ];
  if (gmailReady !== null) {
    items.push({
      id: "gmail",
      label: "Gmail connected",
      done: gmailReady,
      how: "Ask whoever set up the app to save the Gmail app password (a GitHub secret); the Automations page shows when it works.",
      missing: "",
      view: "automations",
      button: "Open Automations",
    });
  }
  return items;
}

/** Items still to do; the card hides when this is empty. */
export function setupToDo(items: SetupItem[]): SetupItem[] {
  return items.filter((i) => !i.done);
}
