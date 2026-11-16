/**
 * The plan's self-check, written independently of the engine: it
 * re-derives every hard rule and every shortfall from the finished
 * plan and the input alone.
 *
 * - Hard rules: nobody or nothing in two crews; every truck tows exactly
 *   one haul unit it may tow; every truck has a different legal driver
 *   from its crew (licence + insurance, may drive it, CDL A for heavy
 *   combinations, weekly limit + 1 at most); no down or unavailable
 *   equipment; no crew above its expected-crew cap (unless people were
 *   locked on by hand) or its seats.
 * - Every gap has a flag: a missing skill, piece of equipment, crew
 *   place, a job not placed, a last-resort person used, an extra drive
 *   of a limited vehicle, a leg over the cluster cap.
 *
 * Returns a list of problems; empty means the plan is sound.
 */
import { CARRIED_HOSTS, isHaul } from "./engine";
import type { DayPlan, PlannerInput } from "./types";

export function validatePlan(input: PlannerInput, plan: DayPlan): string[] {
  const out: string[] = [];
  const people = new Map(input.people.map((p) => [p.id, p]));
  const eq = new Map(input.equipment.map((e) => [e.id, e]));
  const jobs = new Map(input.jobs.map((j) => [j.id, j]));
  const s = input.settings;
  const hasFlag = (code: string | string[], f: { jobId?: string; personId?: string; crewKey?: string }) =>
    plan.flags.some(
      (x) =>
        (Array.isArray(code) ? code.includes(x.code) : x.code === code) &&
        (f.jobId == null || x.jobId === f.jobId) &&
        (f.personId == null || x.personId === f.personId) &&
        (f.crewKey == null || x.crewKey === f.crewKey),
    );

  const personCrew = new Map<string, string>();
  const eqCrew = new Map<string, string>();
  const jobSeen = new Map<string, number>();
  for (const c of plan.crews) {
    for (const id of c.memberIds) {
      if (personCrew.has(id)) out.push(`${id} is in two crews`);
      personCrew.set(id, c.key);
      if (!people.has(id)) out.push(`${id} is on ${c.key} but cannot work today`);
    }
    const items = [...c.rigs.flatMap((r) => [r.truckId, r.haulId, ...r.carriedIds]), ...c.looseIds];
    for (const id of items) {
      if (eqCrew.has(id)) out.push(`equipment ${id} is in two crews`);
      eqCrew.set(id, c.key);
      const e = eq.get(id);
      if (!e) out.push(`unknown equipment ${id}`);
      else if (!e.usable) out.push(`${e.name} is ${e.unusableReason} but is used`);
    }
    const driversUsed = new Set<string>();
    for (const r of c.rigs) {
      const t = eq.get(r.truckId);
      const h = eq.get(r.haulId);
      if (!t || t.kind !== "Truck") out.push(`rig on ${c.key} has no truck`);
      if (!h || !isHaul(h.kind)) out.push(`truck ${r.truckId} on ${c.key} has no haul unit`);
      if (t && h && t.tows && !t.tows.includes(h.id)) out.push(`${t.name} may not tow ${h.name}`);
      if (r.carriedIds.length > 1) out.push(`more than one machine on ${h?.name ?? r.haulId}`);
      for (const cid of r.carriedIds) {
        const ce = eq.get(cid);
        const hosts = ce ? CARRIED_HOSTS[ce.kind] : null;
        if (!hosts || !h || !(hosts as readonly string[]).includes(h.kind)) out.push(`${ce?.name ?? cid} cannot ride on ${h?.name ?? r.haulId}`);
      }
      const d = c.drivers[r.truckId];
      if (!d) {
        out.push(`${t?.name ?? r.truckId} has no driver`);
        continue;
      }
      if (driversUsed.has(d)) out.push(`${d} drives two trucks`);
      driversUsed.add(d);
      if (!c.memberIds.includes(d)) out.push(`driver ${d} is not on ${c.key}`);
      const p = people.get(d);
      if (!p || !p.legalDriver) out.push(`${d} is not a legal driver`);
      else {
        if (p.canDrive && t && !p.canDrive.includes(t.id)) out.push(`${p.name} is not set to drive ${t.name}`);
        const carriedLbs = r.carriedIds.reduce((n, id) => n + (eq.get(id)?.weightLbs ?? 0), 0);
        if (t && h && (t.weightLbs ?? 0) + (h.weightLbs ?? 0) + carriedLbs > s.cdlAWeightLbs && !p.cdlA) out.push(`${p.name} needs CDL A for ${t.name} + ${h.name}`);
        for (const e of [t, h]) {
          if (!e || e.weeklyDriverLimit == null) continue;
          const after = (p.vehicleUses[e.id] ?? 0) + 1;
          if (after > e.weeklyDriverLimit + 1) out.push(`${p.name} would drive ${e.name} more than limit + 1 this week`);
          else if (after > e.weeklyDriverLimit && !hasFlag("VEHICLE_EXTRA_DRIVE", { personId: p.id })) out.push(`extra drive of ${e.name} by ${p.name} has no flag`);
        }
      }
    }
    for (const [truck, d] of Object.entries(c.drivers)) {
      if (!c.rigs.some((r) => r.truckId === truck)) out.push(`driver ${d} set for ${truck}, which is not in a rig`);
    }

    // Cap and seats.
    const placed = c.stops.map((st) => jobs.get(st.jobId)).filter((j): j is NonNullable<typeof j> => !!j);
    const caps = placed.map((j) => j.cap).filter((x): x is number => x != null);
    const lockedHere = new Set(placed.flatMap((j) => j.locked.people).filter((id) => c.memberIds.includes(id)));
    if (caps.length > 0 && c.memberIds.length > Math.max(Math.min(...caps), lockedHere.size)) out.push(`${c.key} is over its expected-crew cap`);
    const trucks = c.rigs.map((r) => eq.get(r.truckId));
    if (trucks.length > 0 && trucks.every((t) => t?.seats != null)) {
      const seats = trucks.reduce((n, t) => n + (t?.seats ?? 0), 0);
      // People locked on by hand may go past the seats, with a SEATS_SHORT flag.
      if (c.memberIds.length > Math.max(seats, lockedHere.size) || (c.memberIds.length > seats && !hasFlag("SEATS_SHORT", { crewKey: c.key }))) {
        out.push(`${c.key} has more people than seats`);
      }
    }

    // Every gap has a flag.
    const skills = new Set(c.memberIds.flatMap((id) => people.get(id)?.skills ?? []));
    const kinds = new Set<string>(c.rigs.length > 0 ? ["Truck"] : []);
    for (const id of items) {
      const e = eq.get(id);
      if (e) kinds.add(e.kind);
    }
    if (placed.length > 0 && c.memberIds.length === 0 && !placed.every((j) => hasFlag("SHORT_HANDED", { jobId: j.id }))) {
      out.push(`${c.key} goes out with nobody and no flag`);
    }
    for (const j of placed) {
      jobSeen.set(j.id, (jobSeen.get(j.id) ?? 0) + 1);
      const want = [...j.skills, ...(j.climbers > 0 ? ["climbing"] : []), ...(j.groundsmen > 0 ? ["ground_work"] : [])];
      if (want.some((sk) => !skills.has(sk)) && !hasFlag("UNFILLED_SKILL", { jobId: j.id })) out.push(`${j.title} misses a skill with no flag`);
      if (j.kinds.some((k) => !kinds.has(k)) && !hasFlag(["NO_RIG", "NO_LEGAL_DRIVER"], { jobId: j.id })) out.push(`${j.title} misses equipment with no flag`);
      // Role places: a climber/groundsman with both skills fills one place.
      let a = 0;
      let b = 0;
      let d = 0;
      for (const id of c.memberIds) {
        const ps = people.get(id)?.skills ?? [];
        const cl = ps.includes("climbing");
        const gr = ps.includes("ground_work");
        if (cl && gr) d++;
        else if (cl) a++;
        else if (gr) b++;
      }
      const filled = Math.min(j.climbers + j.groundsmen, Math.min(j.climbers, a) + Math.min(j.groundsmen, b) + Math.min(d, Math.max(0, j.climbers - a) + Math.max(0, j.groundsmen - b)));
      if (filled < j.climbers + j.groundsmen && !hasFlag("SHORT_HANDED", { jobId: j.id })) out.push(`${j.title} is short-handed with no flag`);
    }
    for (const id of c.memberIds) {
      const p = people.get(id);
      if (p?.lastResort && !hasFlag("LAST_RESORT_USED", { personId: id })) out.push(`last-resort ${p.name} used with no flag`);
      if (p && !p.usualDay && !hasFlag("OFF_USUAL_DAY", { personId: id })) out.push(`${p.name} off their usual day with no flag`);
    }
    for (let k = 1; k < c.stops.length; k++) {
      if (c.stops[k].driveInMin > s.clusterMaxMinutes && !hasFlag("OVER_CLUSTER_CAP", { jobId: c.stops[k].jobId, crewKey: c.key })) {
        out.push(`leg into ${c.stops[k].jobId} is over the cluster cap with no flag`);
      }
    }
    const last = c.stops[c.stops.length - 1];
    if (last && last.endMin > s.dayEndMin && !hasFlag("DAY_OVERRUN", { crewKey: c.key })) out.push(`${c.key} runs past the day with no flag`);
  }
  for (const np of plan.notPlaced) {
    jobSeen.set(np.jobId, (jobSeen.get(np.jobId) ?? 0) + 1);
    if (!hasFlag(["DOES_NOT_FIT_DAY", "CLOSED_DAY"], { jobId: np.jobId })) out.push(`${np.jobId} not placed with no flag`);
  }
  for (const j of input.jobs) {
    const n = jobSeen.get(j.id) ?? 0;
    if (n !== 1) out.push(`${j.title} appears ${n} times in the plan`);
  }
  // Locks kept.
  for (const j of input.jobs) {
    const crew = plan.crews.find((c) => c.stops.some((st) => st.jobId === j.id));
    if (!crew) continue;
    for (const id of j.locked.people) if (people.has(id) && !crew.memberIds.includes(id)) out.push(`locked ${id} moved off ${j.title}`);
    for (const [truck, id] of Object.entries(j.locked.drivers)) {
      if (!crew.rigs.some((r) => r.truckId === truck) || crew.drivers[truck] === id) continue;
      if (!hasFlag("LOCK_CONFLICT", { personId: id })) out.push(`locked driver ${id} moved off ${truck} with no flag`);
    }
  }
  return out;
}
