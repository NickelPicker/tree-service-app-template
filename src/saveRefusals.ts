import type { SaveRefusal } from "./data/adapter";

/** Plain names for the tables a refused change can be in. */
const TABLE_NAMES: Record<string, string> = {
  jobs: "jobs",
  customers: "customers",
  customer_addresses: "customer addresses",
  trees: "trees",
  estimates: "estimates",
  invoices: "invoices",
  crew: "team profiles",
  timesheets: "time entries",
  time_off_requests: "time-off requests",
  crew_unavailability: "unavailable days",
  equipment: "equipment",
  equipment_notes: "equipment notes",
  maintenance_tasks: "maintenance tasks",
  maintenance_records: "maintenance records",
  day_crews: "day crews",
  closed_days: "closed days",
  settings: "company settings",
  automations: "automations",
  phc_programs: "plant health programs",
  phc_visits: "plant health visits",
  chemical_records: "chemical records",
  email_threads: "messages",
  messages: "messages",
  private_notes: "notes",
  location_requests: "location requests",
  booking_requests: "booking requests",
};

/** "a", "a and b", "a, b and c" */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The notice shown when the database refused some changes because
 * this login may not make them. A permission trigger explains itself
 * ("Crew can only change the status of a job."), so its reason is
 * shown; row-level security messages are technical, so they are not.
 */
export function refusalNotice(refused: SaveRefusal[]): string {
  const names = [
    ...new Set(
      refused.map((r) => TABLE_NAMES[r.table] ?? r.table.replace(/_/g, " ")),
    ),
  ];
  const explained = refused
    .flatMap((r) => r.reasons)
    .find(
      (m) =>
        m.trim() !== "" && !/row-level security|permission denied/i.test(m),
    );
  return [
    `Not saved: your login isn't allowed to make that change to ${joinNames(names)}.`,
    explained,
    "The screen now shows what is saved. Ask an owner or manager if the change is needed.",
  ]
    .filter(Boolean)
    .join(" ");
}
