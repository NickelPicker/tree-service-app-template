/**
 * Who drives what on one job (the job panel's "Who's driving what").
 *
 * Each person drives at most one truck and tows at most one thing behind
 * it (chipper or trailer); a mini skid or stump grinder rides on a
 * trailer. Only legal drivers (licence AND company insurance ticked) are
 * ever suggested; the owner can still drag anything onto anyone by hand
 * (the panel then shows a warning).
 */
import { isEquipmentDown, type AppState, type CrewMember, type Equipment, type EquipmentKind, type Job } from "./types";
import { isLegalDriver } from "./skills";
import { resolvePlannerSettings } from "./planner/settings";

export const TOWED: EquipmentKind[] = ["Chipper", "Dump trailer", "Equipment trailer", "Trailer", "Stump grinder"];
const RIDES_ON_TRAILER: EquipmentKind[] = ["Mini skid", "Stump grinder"];

export const isTruck = (e: Equipment) => e.kind === "Truck";
export const isTowed = (e: Equipment) => TOWED.includes(e.kind);

/** Usable today: available, not down. */
export const usable = (e: Equipment) => e.status === "available" && !isEquipmentDown(e);

/** Equipment booked on other jobs the same day (id -> job title). */
export function bookedElsewhere(state: AppState, job: Pick<Job, "id" | "date">): Map<string, string> {
  const out = new Map<string, string>();
  for (const j of state.jobs) {
    if (j.id === job.id || j.date !== job.date) continue;
    for (const id of j.equipmentIds ?? []) if (!out.has(id)) out.set(id, j.title);
  }
  return out;
}

/** Monday of the week a YYYY-MM-DD date falls in. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Days this week (other jobs) each person drove each vehicle. */
function weekDrives(state: AppState, job: Pick<Job, "id" | "date">): Map<string, number> {
  const mon = mondayOf(job.date);
  const end = new Date(`${mon}T12:00:00`);
  end.setDate(end.getDate() + 6);
  const sun = end.toISOString().slice(0, 10);
  const seen = new Set<string>();
  for (const j of state.jobs) {
    if (j.id === job.id || j.date < mon || j.date > sun) continue;
    for (const [eqId, crewId] of Object.entries(j.equipmentDrivers ?? {})) {
      seen.add(`${crewId}|${eqId}|${j.date}`);
    }
  }
  const counts = new Map<string, number>();
  for (const k of seen) {
    const [crewId, eqId] = k.split("|");
    counts.set(`${crewId}|${eqId}`, (counts.get(`${crewId}|${eqId}`) ?? 0) + 1);
  }
  return counts;
}

/** Why this person should not drive this truck (+ towed item), or null when fine. */
export function driveProblem(
  state: AppState,
  person: CrewMember,
  truck: Equipment | null,
  towed: Equipment | null,
): string | null {
  if (!isLegalDriver(person)) {
    return person.driverLicensed
      ? `${person.name} is not on the company insurance`
      : `${person.name} has no driver's licence recorded`;
  }
  const allowed = person.canDriveEquipment ?? [];
  for (const e of [truck, towed]) {
    if (e && allowed.length > 0 && !allowed.includes(e.id)) return `${person.name} isn't marked as able to drive ${e.name}`;
  }
  const s = resolvePlannerSettings(state.settings.planner);
  const lbs = (truck?.weightLbs ?? 0) + (towed?.weightLbs ?? 0);
  if (lbs > s.cdlAWeightLbs && person.cdlClass !== "A") {
    return `${truck?.name ?? "This truck"} + ${towed?.name ?? ""} is over ${s.cdlAWeightLbs.toLocaleString()} lb: needs a CDL Class A`;
  }
  return null;
}

export interface DriverSuggestion {
  /** equipment id -> crew id (a truck and what it tows share a driver). */
  drivers: Record<string, string>;
  /** Equipment the job should take (the job's own list, or what the suggestion picked). */
  equipmentIds: string[];
  notes: string[];
}

/**
 * Suggest who drives what for this job. Uses the job's equipment when it
 * has some; otherwise picks free equipment for the job's service type
 * (Removal: chipper + dump trailer, Trimming: chipper, ...).
 */
export function suggestDrivers(state: AppState, job: Job): DriverSuggestion {
  const notes: string[] = [];
  const s = resolvePlannerSettings(state.settings.planner);
  const busy = bookedElsewhere(state, job);
  const eqById = new Map(state.equipment.map((e) => [e.id, e]));
  const crew = job.crewIds
    .map((id) => state.crew.find((c) => c.id === id))
    .filter((c): c is CrewMember => !!c);
  const drivers = crew.filter((c) => isLegalDriver(c));
  if (crew.length === 0) return { drivers: {}, equipmentIds: job.equipmentIds ?? [], notes: ["Assign crew first."] };
  if (drivers.length === 0) {
    return {
      drivers: {},
      equipmentIds: job.equipmentIds ?? [],
      notes: ["Nobody on this job has a licence and company insurance ticked, so no driver is suggested."],
    };
  }

  // What to take.
  let chosen: Equipment[] = (job.equipmentIds ?? []).map((id) => eqById.get(id)).filter((e): e is Equipment => !!e);
  if (chosen.length === 0) {
    const kinds = s.defaultEquipmentByService[job.serviceType] ?? [];
    for (const kind of kinds) {
      const pick = state.equipment.find((e) => e.kind === kind && usable(e) && !busy.has(e.id) && !chosen.includes(e));
      if (pick) chosen.push(pick);
      else notes.push(`No free ${kind.toLowerCase()} that day.`);
    }
  }
  let towedList = chosen.filter(isTowed).filter((e) => !RIDES_ON_TRAILER.includes(e.kind) || !chosen.some((t) => t.kind === "Dump trailer" || t.kind === "Equipment trailer" || t.kind === "Trailer"));
  const riders = chosen.filter((e) => RIDES_ON_TRAILER.includes(e.kind) && !towedList.includes(e));
  const trucks = chosen.filter(isTruck);
  // Every towed item needs its own truck; pick free ones that can tow it.
  const extraTrucks = Math.max(0, towedList.length - trucks.length);
  const truckPool = state.equipment.filter((e) => isTruck(e) && usable(e) && !busy.has(e.id) && !trucks.includes(e));
  for (let i = 0; i < extraTrucks; i++) {
    const need = towedList[trucks.length];
    const t = truckPool.find((x) => !trucks.includes(x) && (x.tows == null || x.tows.includes(need.id)));
    if (t) trucks.push(t);
    else {
      notes.push(`No free truck that can tow ${need.name}.`);
      towedList = towedList.filter((x) => x !== need);
    }
  }
  if (trucks.length === 0 && chosen.length === 0) {
    const t = truckPool[0];
    if (t) trucks.push(t);
  }

  // Pair trucks with towed items, then give each pair a driver.
  const week = weekDrives(state, job);
  const used = new Set<string>();
  const out: Record<string, string> = {};
  const pairs = trucks.map((t, i) => ({ truck: t, towed: towedList.find((h, hi) => hi === i && (t.tows == null || t.tows.includes(h.id))) ?? null }));
  for (const { truck, towed } of pairs) {
    const ranked = drivers
      .filter((d) => !used.has(d.id) && !driveProblem(state, d, truck, towed))
      .map((d) => {
        const limit = truck.weeklyDriverLimit;
        const times = week.get(`${d.id}|${truck.id}`) ?? 0;
        return {
          d,
          over: limit != null && times >= limit ? (times >= limit + 1 ? 2 : 1) : 0,
          own: d.prefersOwnTruck && d.ownTruckId === truck.id ? 0 : 1,
          drives: [...week.entries()].filter(([k]) => k.startsWith(`${d.id}|`)).reduce((n, [, v]) => n + v, 0),
          skills: (d.skills ?? []).length,
        };
      })
      .filter((x) => x.over < 2)
      .sort((a, b) => a.over - b.over || a.own - b.own || a.drives - b.drives || a.skills - b.skills || a.d.id.localeCompare(b.d.id));
    const pick = ranked[0];
    if (!pick) {
      notes.push(`Nobody on this job can drive ${truck.name}${towed ? ` with ${towed.name}` : ""}.`);
      continue;
    }
    used.add(pick.d.id);
    out[truck.id] = pick.d.id;
    if (towed) out[towed.id] = pick.d.id;
    if (pick.over === 1) notes.push(`${pick.d.name} already drove ${truck.name} this week (second time: no one else could).`);
    // A mini skid / stump grinder rides on this person's trailer.
    if (towed && towed.kind !== "Chipper") {
      for (const r of riders) if (!out[r.id]) out[r.id] = pick.d.id;
    }
  }
  // Only take what someone on this job drives (or what the job already lists);
  // a truck nobody here can drive stays free for another job.
  const own = new Set(job.equipmentIds ?? []);
  const picked = [...trucks, ...towedList, ...riders];
  for (const e of picked) {
    if (!out[e.id] && !own.has(e.id)) notes.push(`No driver here for ${e.name}, so it stays at the shop.`);
  }
  const equipmentIds = [...new Set([...own, ...picked.filter((e) => out[e.id]).map((e) => e.id)])];
  return { drivers: out, equipmentIds, notes };
}

/** What a person carries: one truck, one thing behind it, one thing on the trailer. */
export type DriveSlot = "truck" | "tow" | "load";
export const SLOT_LABEL: Record<DriveSlot, string> = {
  truck: "Truck",
  tow: "Towing",
  load: "On the trailer / also bringing",
};
const TRAILERS: EquipmentKind[] = ["Dump trailer", "Equipment trailer", "Trailer"];

/**
 * Which slot this equipment fills for a person who already has `held`.
 * A stump grinder is towed on its own, or rides on a trailer when they
 * are already towing one.
 */
export function slotOf(e: Equipment, held: Equipment[]): DriveSlot {
  if (e.kind === "Truck") return "truck";
  if (e.kind === "Mini skid" || e.kind === "Other") return "load";
  if (e.kind === "Stump grinder" && held.some((h) => TRAILERS.includes(h.kind))) return "load";
  return "tow";
}

/**
 * Put equipment on a person. Whatever they had in that slot comes off
 * the job; if someone else had this equipment it moves over.
 * Returns the new equipment list and drivers.
 */
export function assignDrive(
  equipment: Equipment[],
  equipmentIds: string[],
  drivers: Record<string, string>,
  crewId: string,
  eqId: string,
): { equipmentIds: string[]; drivers: Record<string, string> } {
  const byId = new Map(equipment.map((e) => [e.id, e]));
  const eq = byId.get(eqId);
  if (!eq) return { equipmentIds, drivers };
  const next = { ...drivers };
  delete next[eqId];
  const held = Object.entries(next)
    .filter(([, c]) => c === crewId)
    .map(([id]) => byId.get(id))
    .filter((e): e is Equipment => !!e);
  const slot = slotOf(eq, held);
  let ids = equipmentIds.filter((x) => x !== eqId);
  for (const h of held) {
    if (slotOf(h, held.filter((o) => o !== h)) === slot) {
      delete next[h.id];
      ids = ids.filter((x) => x !== h.id);
    }
  }
  next[eqId] = crewId;
  return { equipmentIds: [...ids, eqId], drivers: next };
}

/** Take equipment off its driver and off the job. */
export function removeDrive(
  equipmentIds: string[],
  drivers: Record<string, string>,
  eqId: string,
): { equipmentIds: string[]; drivers: Record<string, string> } {
  const next = { ...drivers };
  delete next[eqId];
  return { equipmentIds: equipmentIds.filter((x) => x !== eqId), drivers: next };
}
