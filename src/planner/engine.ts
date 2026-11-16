/**
 * The planner's working parts: lock groups, crew requirements, rigs and
 * drivers, routes, staffing and the score of one way to split the day.
 *
 * Pure and synchronous. Every loop runs in index order and every sort
 * ends with an id, so the same input always gives the same plan.
 */
import type { EquipmentKind } from "../types";
import type { HaulKind, PlanEquipment, PlanFlag, PlanJob, PlanPerson, PlannerInput } from "./types";

export const HAUL_KINDS: readonly HaulKind[] = ["Chipper", "Dump trailer", "Equipment trailer", "Trailer"];
/** Which trailers each carried machine rides on, in order of preference. */
export const CARRIED_HOSTS: Readonly<Partial<Record<EquipmentKind, readonly HaulKind[]>>> = {
  "Mini skid": ["Dump trailer", "Equipment trailer"],
  "Stump grinder": ["Equipment trailer", "Dump trailer", "Trailer"],
};
/** A crew that only needs "a truck" still tows something: the lightest-duty unit first. */
const TRUCK_FILL_ORDER: readonly HaulKind[] = ["Trailer", "Equipment trailer", "Dump trailer", "Chipper"];

export const isHaul = (k: EquipmentKind): k is HaulKind => (HAUL_KINDS as readonly string[]).includes(k);
export const isCarried = (k: EquipmentKind): boolean => CARRIED_HOSTS[k] != null;

const INF = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------- context

/** Jobs that must share a crew because they share a locked person or piece of equipment. */
export interface Unit {
  jobs: number[];
  people: string[];
  equipment: string[];
  /** Locked truck id -> driver id. */
  drivers: Record<string, string>;
}

export interface Ctx {
  input: PlannerInput;
  jobs: PlanJob[];
  people: PlanPerson[];
  pIdx: Map<string, number>;
  pSkills: Set<string>[];
  eqById: Map<string, PlanEquipment>;
  usableEq: PlanEquipment[];
  units: Unit[];
  jobUnit: number[];
  /** Equipment id -> the unit whose jobs lock it. */
  eqLockUnit: Map<string, number>;
  lockFlags: PlanFlag[];
  routeMemo: Map<string, RouteResult>;
  reqMemo: Map<string, CrewReq>;
  rigMemo: Map<string, RigOut>;
  evaluations: number;
  repairs: number;
}

export function buildCtx(input: PlannerInput): Ctx {
  const jobs = input.jobs;
  const people = input.people;
  const pIdx = new Map(people.map((p, i) => [p.id, i]));
  const eqById = new Map(input.equipment.map((e) => [e.id, e]));
  const offById = new Map(input.off.map((o) => [o.crewId, o]));
  const lockFlags: PlanFlag[] = [];

  const parent = jobs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const personOwner = new Map<string, number>();
  const eqOwner = new Map<string, number>();
  const keptPeople: string[][] = jobs.map(() => []);
  const keptEq: string[][] = jobs.map(() => []);
  const keptDrivers: Array<Record<string, string>> = jobs.map(() => ({}));

  const claimPerson = (pid: string, i: number) => {
    const o = personOwner.get(pid);
    if (o == null) personOwner.set(pid, i);
    else union(o, i);
    if (!keptPeople[i].includes(pid)) keptPeople[i].push(pid);
  };

  jobs.forEach((job, i) => {
    for (const pid of job.locked.people) {
      if (pIdx.has(pid)) claimPerson(pid, i);
      else {
        const off = offById.get(pid);
        lockFlags.push({
          severity: "red",
          code: "LOCK_CONFLICT",
          jobId: job.id,
          personId: pid,
          text: `${job.title}: ${off?.name ?? "someone"} is assigned but cannot work today${off ? ` (${off.reason.toLowerCase()})` : ""} — left off the plan.`,
        });
      }
    }
    for (const eid of job.locked.equipment) {
      const e = eqById.get(eid);
      if (!e) continue;
      if (!e.usable) {
        lockFlags.push({
          severity: "red",
          code: "LOCKED_ITEM_DOWN",
          jobId: job.id,
          equipmentId: eid,
          text: `${job.title}: ${e.name} is assigned but is ${e.unusableReason} — not used.`,
        });
        continue;
      }
      const o = eqOwner.get(eid);
      if (o == null) eqOwner.set(eid, i);
      else union(o, i);
      keptEq[i].push(eid);
    }
    for (const [eid, pid] of Object.entries(job.locked.drivers).sort((a, b) => a[0].localeCompare(b[0]))) {
      const e = eqById.get(eid);
      if (!e || !e.usable || e.kind !== "Truck") continue; // trailers follow their truck's driver
      const pi = pIdx.get(pid);
      if (pi == null) {
        // Flagged above when they were also on the crew; otherwise flag it here.
        if (!job.locked.people.includes(pid)) {
          const off = offById.get(pid);
          lockFlags.push({
            severity: "red",
            code: "LOCK_CONFLICT",
            jobId: job.id,
            personId: pid,
            equipmentId: eid,
            text: `${job.title}: ${off?.name ?? "someone"} is set to drive ${e.name} but cannot work today${off ? ` (${off.reason.toLowerCase()})` : ""} — the plan picks another driver.`,
          });
        }
        continue;
      }
      const p = people[pi];
      if (!canDriveTruck(p, e, null, input.settings.cdlAWeightLbs).ok) {
        lockFlags.push({
          severity: "red",
          code: "LOCK_CONFLICT",
          jobId: job.id,
          personId: pid,
          equipmentId: eid,
          text: `${job.title}: ${p.name} is set to drive ${e.name} but is not a legal driver for it — the plan picks another driver.`,
        });
        claimPerson(pid, i);
        continue;
      }
      claimPerson(pid, i);
      if (!keptEq[i].includes(eid)) {
        const o = eqOwner.get(eid);
        if (o == null) eqOwner.set(eid, i);
        else union(o, i);
        keptEq[i].push(eid);
      }
      keptDrivers[i][eid] = pid;
    }
  });

  const unitOfRoot = new Map<number, number>();
  const units: Unit[] = [];
  const jobUnit: number[] = jobs.map(() => -1);
  jobs.forEach((_, i) => {
    const r = find(i);
    let u = unitOfRoot.get(r);
    if (u == null) {
      u = units.length;
      unitOfRoot.set(r, u);
      units.push({ jobs: [], people: [], equipment: [], drivers: {} });
    }
    const unit = units[u];
    unit.jobs.push(i);
    jobUnit[i] = u;
    for (const p of keptPeople[i]) if (!unit.people.includes(p)) unit.people.push(p);
    for (const e of keptEq[i]) if (!unit.equipment.includes(e)) unit.equipment.push(e);
    for (const [t, p] of Object.entries(keptDrivers[i])) {
      const drivingOther = Object.entries(unit.drivers).some(([t2, p2]) => p2 === p && t2 !== t);
      if (unit.drivers[t] == null && !drivingOther) unit.drivers[t] = p;
      else if (unit.drivers[t] !== p) {
        lockFlags.push({
          severity: "red",
          code: "LOCK_CONFLICT",
          jobId: jobs[i].id,
          personId: p,
          equipmentId: t,
          text: `${jobs[i].title}: two different drivers are set for the same truck, or one person for two trucks — keeping the first.`,
        });
      }
    }
  });
  const eqLockUnit = new Map<string, number>();
  units.forEach((u, ui) => {
    u.people.sort();
    u.equipment.sort();
    for (const e of u.equipment) eqLockUnit.set(e, ui);
  });

  return {
    input,
    jobs,
    people,
    pIdx,
    pSkills: people.map((p) => new Set(p.skills)),
    eqById,
    usableEq: input.equipment.filter((e) => e.usable),
    units,
    jobUnit,
    eqLockUnit,
    lockFlags,
    routeMemo: new Map(),
    reqMemo: new Map(),
    rigMemo: new Map(),
    evaluations: 0,
    repairs: 0,
  };
}

// ---------------------------------------------------------- requirements

export interface CrewReq {
  key: string;
  units: number[];
  /** Job indices, highest value first. */
  jobs: number[];
  /** Index of the crew's most valuable job (crews are staffed in this order). */
  top: number;
  cap: number;
  climb: number;
  ground: number;
  minHead: number;
  presence: string[];
  hauls: HaulKind[];
  carried: EquipmentKind[];
  needTruck: boolean;
  needOther: boolean;
  lockedPeople: string[];
  lockedEq: string[];
  lockedDrivers: Record<string, string>;
  /** Most people the extras pass may bring this crew to. */
  extrasLimit: number;
}

export function crewReq(ctx: Ctx, unitIds: number[]): CrewReq {
  const sortedUnits = [...unitIds].sort((a, b) => a - b);
  const key = sortedUnits.join(",");
  const hit = ctx.reqMemo.get(key);
  if (hit) return hit;
  const jobs: number[] = [];
  const lockedPeople = new Set<string>();
  const lockedEq = new Set<string>();
  const lockedDrivers: Record<string, string> = {};
  for (const u of sortedUnits) {
    const unit = ctx.units[u];
    jobs.push(...unit.jobs);
    unit.people.forEach((p) => lockedPeople.add(p));
    unit.equipment.forEach((e) => lockedEq.add(e));
    Object.assign(lockedDrivers, unit.drivers);
  }
  jobs.sort((a, b) => a - b);
  let cap = INF;
  let climb = 0;
  let ground = 0;
  let minHead = 0;
  let anyAll = false;
  let allCapped = true;
  const presence = new Set<string>();
  const kinds = new Set<EquipmentKind>();
  for (const i of jobs) {
    const j = ctx.jobs[i];
    if (j.cap != null) cap = Math.min(cap, j.cap);
    else allCapped = false;
    climb = Math.max(climb, j.climbers);
    ground = Math.max(ground, j.groundsmen);
    // Every crew sends at least one person, whatever the rules' minimums.
    minHead = Math.max(minHead, j.climbers + j.groundsmen, 1);
    if (j.allAvailable) anyAll = true;
    j.skills.forEach((s) => presence.add(s));
    j.kinds.forEach((k) => kinds.add(k));
  }
  const req: CrewReq = {
    key,
    units: sortedUnits,
    jobs,
    top: jobs[0] ?? INF,
    cap,
    climb,
    ground,
    minHead,
    presence: [...presence].sort(),
    hauls: HAUL_KINDS.filter((k) => kinds.has(k)),
    carried: [...kinds].filter(isCarried).sort(),
    needTruck: kinds.has("Truck"),
    needOther: kinds.has("Other"),
    lockedPeople: [...lockedPeople].sort(),
    lockedEq: [...lockedEq].sort(),
    lockedDrivers,
    // Extras (business rule: extra people go to the biggest jobs):
    // up to the cap when every job has one, everyone available (within
    // the cap) when a job's rule says so, and otherwise up to the
    // planner's "largest crew" setting. Seats still limit it afterwards.
    extrasLimit: anyAll ? cap : allCapped ? cap : Math.min(cap, ctx.input.settings.maxCrewSize),
  };
  ctx.reqMemo.set(key, req);
  return req;
}

/** Most of `climb` climbing and `ground` ground slots distinct people can fill. */
export function roleFilled(
  ctx: Ctx,
  members: readonly string[],
  climb: number,
  ground: number,
): { climbFilled: number; groundFilled: number } {
  let a = 0; // climbing only
  let b = 0; // ground only
  let d = 0; // both
  for (const id of members) {
    const s = ctx.pSkills[ctx.pIdx.get(id) ?? -1];
    if (!s) continue;
    const c = s.has("climbing");
    const g = s.has("ground_work");
    if (c && g) d++;
    else if (c) a++;
    else if (g) b++;
  }
  const climbFromA = Math.min(climb, a);
  const useD = Math.min(d, climb - climbFromA);
  const climbFilled = climbFromA + useD;
  const groundFilled = Math.min(ground, b + d - useD);
  return { climbFilled, groundFilled };
}

// ------------------------------------------------------------- drivers

export function canDriveTruck(
  p: PlanPerson,
  truck: PlanEquipment,
  haul: PlanEquipment | null,
  cdlLbs: number,
  /** Weight of the machines riding on the haul unit (part of the combination weight). */
  carriedLbs = 0,
): { ok: boolean; extra: boolean } {
  if (!p.legalDriver) return { ok: false, extra: false };
  if (p.canDrive && !p.canDrive.includes(truck.id)) return { ok: false, extra: false };
  if (haul && (truck.weightLbs ?? 0) + (haul.weightLbs ?? 0) + carriedLbs > cdlLbs && !p.cdlA) {
    return { ok: false, extra: false };
  }
  let extra = false;
  for (const e of haul ? [truck, haul] : [truck]) {
    if (e.weeklyDriverLimit == null) continue;
    const after = (p.vehicleUses[e.id] ?? 0) + 1;
    if (after > e.weeklyDriverLimit + 1) return { ok: false, extra: false };
    if (after > e.weeklyDriverLimit) extra = true;
  }
  return { ok: true, extra };
}

export const towsOk = (truck: PlanEquipment, haul: PlanEquipment) => truck.tows == null || truck.tows.includes(haul.id);

// ---------------------------------------------------------------- rigs

export interface RigPlan {
  truckId: string;
  haulId: string;
  carriedIds: string[];
  driverId: string;
  extra: boolean;
}

export interface MissingKind {
  kind: EquipmentKind;
  reason: "NO_RIG" | "NO_LEGAL_DRIVER";
  text: string;
}

export interface RigOut {
  rigs: RigPlan[];
  loose: string[];
  missing: MissingKind[];
  /** Equipment ids this crew takes. */
  used: string[];
  /** Seats in the crew's trucks; INF when a truck has no seat count or there is no truck. */
  seatCap: number;
  /** Locked trucks that could not go out (no haul unit or no driver). */
  strandedLocked: string[];
  /** Hauls that a member could not drive although a truck was free (staffing adds a driver). */
  needDriverFor: Array<{ pairs: Array<{ truckId: string; haulId: string }>; carriedLbs: number }>;
}

interface HaulSlot {
  /** The haul units this slot may use, in order of preference (one, when locked). */
  cands: PlanEquipment[];
  /** Haul kinds the slot accepts (decides which carried machines it can host). */
  kinds: HaulKind[];
  carried: PlanEquipment[];
  /** The kinds this slot provides (its own and its carried machines). */
  provides: EquipmentKind[];
  needed: boolean;
}

/**
 * Pick the crew's rigs (truck + exactly one towed unit, plus carried
 * machines) from the equipment still free, and a different legal driver
 * from the crew for each truck. Which haul unit fills a slot is part of
 * the search, so a unit nobody can legally pull is passed over for one
 * they can. Equipment locked to another crew's jobs is never taken.
 */
export function rigCrew(ctx: Ctx, req: CrewReq, members: readonly string[], used: ReadonlySet<string>): RigOut {
  const memoKey = `${req.key}|${[...members].sort().join(",")}|${[...used].sort().join(",")}`;
  const hit = ctx.rigMemo.get(memoKey);
  if (hit) return hit;
  const out = rigCrewUncached(ctx, req, members, used);
  ctx.rigMemo.set(memoKey, out);
  return out;
}

function rigCrewUncached(ctx: Ctx, req: CrewReq, members: readonly string[], used: ReadonlySet<string>): RigOut {
  const cdl = ctx.input.settings.cdlAWeightLbs;
  const taken = new Set<string>();
  const unitSet = new Set(req.units);
  const lockedElsewhere = (id: string) => {
    const u = ctx.eqLockUnit.get(id);
    return u != null && !unitSet.has(u);
  };
  const free = (e: PlanEquipment) =>
    !used.has(e.id) && !taken.has(e.id) && !req.lockedEq.includes(e.id) && !lockedElsewhere(e.id);
  const locked = req.lockedEq
    .map((id) => ctx.eqById.get(id))
    .filter((e): e is PlanEquipment => !!e && e.usable && !used.has(e.id));
  const missing: MissingKind[] = [];
  const slots: HaulSlot[] = [];
  const loose: string[] = [];
  const freeHauls = (kinds: readonly HaulKind[]) =>
    kinds.flatMap((k) => ctx.usableEq.filter((e) => e.kind === k && free(e)));

  // Hauls: locked ones first, then one slot per needed kind.
  for (const e of locked) {
    if (isHaul(e.kind)) {
      slots.push({ cands: [e], kinds: [e.kind], carried: [], provides: [e.kind], needed: req.hauls.includes(e.kind) });
      taken.add(e.id);
    }
  }
  const lockedTrucks = locked.filter((e) => e.kind === "Truck");
  lockedTrucks.forEach((t) => taken.add(t.id));
  const trucksFor = (h: PlanEquipment) =>
    ctx.usableEq.filter((t) => t.kind === "Truck" && towsOk(t, h) && (free(t) || lockedTrucks.includes(t)));
  for (const k of req.hauls) {
    if (slots.some((s) => s.kinds.length === 1 && s.kinds[0] === k)) continue;
    const cands = freeHauls([k]);
    if (cands.length === 0) {
      missing.push({ kind: k, reason: "NO_RIG", text: `no ${k.toLowerCase()} free` });
      continue;
    }
    slots.push({ cands, kinds: [k], carried: [], provides: [k], needed: true });
  }
  // Carried machines ride on a trailer.
  const carriedNeeded = new Set<EquipmentKind>(req.carried);
  for (const e of locked) if (isCarried(e.kind)) carriedNeeded.add(e.kind);
  for (const k of [...carriedNeeded].sort()) {
    const item = locked.find((e) => e.kind === k) ?? ctx.usableEq.find((e) => e.kind === k && free(e));
    if (!item) {
      missing.push({ kind: k, reason: "NO_RIG", text: `no ${k.toLowerCase()} free` });
      continue;
    }
    const hosts = CARRIED_HOSTS[k] ?? [];
    let host = slots.find((s) => s.kinds.every((x) => hosts.includes(x)) && s.carried.length === 0);
    if (!host) {
      const kinds = hosts.filter((x) => HAUL_KINDS.includes(x));
      const cands = freeHauls(kinds).filter((h) => !slots.some((s) => s.cands.length === 1 && s.cands[0].id === h.id));
      if (cands.length === 0) {
        missing.push({ kind: k, reason: "NO_RIG", text: `no ${hosts.join(" or ").toLowerCase()} free to carry it` });
        continue;
      }
      host = { cands, kinds: [...kinds], carried: [], provides: [], needed: true };
      slots.push(host);
    }
    taken.add(item.id);
    host.carried.push(item);
    host.provides.push(k);
    host.needed = true;
  }
  // Loose items ("Other").
  for (const e of locked) if (!isHaul(e.kind) && !isCarried(e.kind) && e.kind !== "Truck") loose.push(e.id);
  if (req.needOther && !loose.some((id) => ctx.eqById.get(id)?.kind === "Other")) {
    const o = ctx.usableEq.find((e) => e.kind === "Other" && free(e));
    if (o) {
      taken.add(o.id);
      loose.push(o.id);
    } else missing.push({ kind: "Other", reason: "NO_RIG", text: "no other equipment free" });
  }
  // A truck never leaves alone: a "truck" need or a locked truck gets a trailer.
  const truckSlotsWanted = Math.max(req.needTruck ? 1 : 0, lockedTrucks.length);
  for (let n = slots.length; n < truckSlotsWanted; n++) {
    const cands = freeHauls(TRUCK_FILL_ORDER);
    if (cands.length === 0) break;
    slots.push({ cands, kinds: [...TRUCK_FILL_ORDER], carried: [], provides: [], needed: true });
  }

  // Trucks, hauls and drivers: a small exhaustive search over the slots.
  const slotCarriedLbs = slots.map((s) => s.carried.reduce((t, c) => t + (c.weightLbs ?? 0), 0));
  const options = (s: HaulSlot) => s.cands.reduce((n, h) => n + trucksFor(h).length, 0);
  const orderIdx = slots
    .map((s, i) => ({ i, n: options(s) }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.i);
  const order = orderIdx.map((i) => slots[i]);
  const orderLbs = orderIdx.map((i) => slotCarriedLbs[i]);
  const memberPeople = members
    .map((id) => ctx.people[ctx.pIdx.get(id) ?? -1])
    .filter((p): p is PlanPerson => !!p)
    .sort(
      (a, b) =>
        Number(a.lastResort) - Number(b.lastResort) || a.skills.length - b.skills.length || a.id.localeCompare(b.id),
    );
  const memberSet = new Set(members);
  // Driver locks that still apply: the truck is with this crew and its driver is a member.
  const driverLocks = Object.entries(req.lockedDrivers).filter(
    ([t, p]) => memberSet.has(p) && lockedTrucks.some((x) => x.id === t),
  );
  const lockedDriverOf = new Map(driverLocks);
  // Drivers recorded by hand on this crew's chipper / trailers (keep mode).
  const lockedHaulDriverOf = new Map<string, string>();
  for (const ji of req.jobs) {
    for (const [eid, pid] of Object.entries(ctx.jobs[ji].locked.drivers)) {
      if (isHaul(ctx.eqById.get(eid)?.kind ?? "Other") && !lockedHaulDriverOf.has(eid)) {
        lockedHaulDriverOf.set(eid, pid);
      }
    }
  }
  // Flexibility: how many pairings a truck or haul unit could make. Using the least flexible
  // first leaves the versatile ones for the crews staffed after this one.
  const flex = new Map<string, number>();
  for (const e of ctx.usableEq) {
    if (e.kind === "Truck") flex.set(e.id, ctx.usableEq.filter((h) => isHaul(h.kind) && towsOk(e, h)).length);
    else if (isHaul(e.kind)) flex.set(e.id, ctx.usableEq.filter((t) => t.kind === "Truck" && towsOk(t, e)).length);
  }
  type Pick = { truck: PlanEquipment; haul: PlanEquipment; driver: PlanPerson; extra: boolean } | null;
  const picks: Pick[] = order.map(() => null);
  let best: Pick[] = [...picks];
  let bestKey: number[] | null = null;
  const usedTrucks = new Set<string>();
  const usedHauls = new Set<string>();
  const usedDrivers = new Set<string>();
  let nodes = 0;
  const keyOf = (ps: Pick[]): number[] => {
    let unrigged = 0;
    let lockedOut = 0;
    let lockBroken = 0;
    let extra = 0;
    let limitedUse = 0;
    let seats = 0;
    let seatsKnown = true;
    let rigged = 0;
    let lrDrivers = 0;
    let flexUsed = 0;
    let driverSkills = 0;
    ps.forEach((p, i) => {
      const s = order[i];
      if (!p) {
        unrigged += s.needed ? 1 + s.carried.length : 0;
        return;
      }
      rigged++;
      if (p.extra) extra++;
      if (p.truck.weeklyDriverLimit != null) limitedUse++;
      if (p.haul.weeklyDriverLimit != null) limitedUse++;
      if (p.truck.seats == null) seatsKnown = false;
      else seats += p.truck.seats;
      if (p.driver.lastResort) lrDrivers++;
      flexUsed += (flex.get(p.truck.id) ?? 0) + (flex.get(p.haul.id) ?? 0);
      driverSkills += p.driver.skills.length;
      const want = lockedDriverOf.get(p.truck.id);
      if (want && want !== p.driver.id) lockBroken++;
      // A haul unit (chipper, trailer) keeps the driver it was given by
      // hand, so an accepted truck + trailer pairing stays as it was.
      const wantHaul = lockedHaulDriverOf.get(p.haul.id);
      if (wantHaul && memberSet.has(wantHaul) && wantHaul !== p.driver.id) lockBroken++;
    });
    for (const t of lockedTrucks) if (!ps.some((p) => p?.truck.id === t.id)) lockedOut++;
    const seatShort = rigged > 0 && seatsKnown ? Math.max(0, members.length - seats) : 0;
    // Prefer: every needed unit rigged, locked trucks used, locked drivers kept,
    // seats enough, no extra drive of a limited vehicle, limited vehicles left
    // home, fewest trucks, last-resort people not driving, the least versatile
    // equipment, drivers with fewer other skills.
    return [unrigged, lockedOut, lockBroken, seatShort, extra, limitedUse, rigged, lrDrivers, flexUsed, driverSkills];
  };
  const lessKey = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  let unriggedSoFar = 0;
  const dfs = (i: number) => {
    if (++nodes > 4000) return;
    // Bound: unrigged units only add up along the search.
    if (bestKey && unriggedSoFar > bestKey[0]) return;
    if (i === order.length) {
      const k = keyOf(picks);
      if (!bestKey || lessKey(k, bestKey)) {
        bestKey = k;
        best = [...picks];
      }
      return;
    }
    const s = order[i];
    for (const h of s.cands) {
      if (usedHauls.has(h.id)) continue;
      const trucks = trucksFor(h)
        .filter((t) => !usedTrucks.has(t.id))
        .sort(
          (a, b) =>
            Number(!lockedTrucks.includes(a)) - Number(!lockedTrucks.includes(b)) ||
            Number(a.weeklyDriverLimit != null) - Number(b.weeklyDriverLimit != null) ||
            a.id.localeCompare(b.id),
        );
      for (const t of trucks) {
        // A locked driver who is free and legal for this combination is the only choice.
        const forced = lockedDriverOf.get(t.id);
        const forcedPerson = forced ? ctx.people[ctx.pIdx.get(forced)!] : null;
        const forcedOk =
          !!forcedPerson && !usedDrivers.has(forcedPerson.id) && canDriveTruck(forcedPerson, t, h, cdl, orderLbs[i]).ok;
        for (const p of memberPeople) {
          if (usedDrivers.has(p.id)) continue;
          // Anyone else may drive (a locked driver too), but the key counts a broken driver lock.
          if (forcedOk && p.id !== forced) continue;
          const ok = canDriveTruck(p, t, h, cdl, orderLbs[i]);
          if (!ok.ok) continue;
          usedTrucks.add(t.id);
          usedHauls.add(h.id);
          usedDrivers.add(p.id);
          picks[i] = { truck: t, haul: h, driver: p, extra: ok.extra };
          dfs(i + 1);
          picks[i] = null;
          usedTrucks.delete(t.id);
          usedHauls.delete(h.id);
          usedDrivers.delete(p.id);
        }
      }
    }
    // Leave this slot without a truck.
    const add = s.needed ? 1 + s.carried.length : 0;
    unriggedSoFar += add;
    dfs(i + 1);
    unriggedSoFar -= add;
  };
  dfs(0);

  const rigs: RigPlan[] = [];
  const usedIds: string[] = [];
  const needDriverFor: RigOut["needDriverFor"] = [];
  let seatCap = 0;
  let seatsKnown = true;
  const bestTrucks = new Set(best.filter((b): b is NonNullable<Pick> => !!b).map((b) => b.truck.id));
  const bestHauls = new Set(best.filter((b): b is NonNullable<Pick> => !!b).map((b) => b.haul.id));
  order.forEach((s, i) => {
    const p = best[i];
    if (p) {
      rigs.push({
        truckId: p.truck.id,
        haulId: p.haul.id,
        carriedIds: s.carried.map((c) => c.id),
        driverId: p.driver.id,
        extra: p.extra,
      });
      usedIds.push(p.truck.id, p.haul.id, ...s.carried.map((c) => c.id));
      if (p.truck.seats == null) seatsKnown = false;
      else seatCap += p.truck.seats;
      return;
    }
    if (!s.needed) return;
    const pairs = s.cands
      .filter((h) => !bestHauls.has(h.id))
      .flatMap((h) => trucksFor(h).filter((t) => !bestTrucks.has(t.id)).map((t) => ({ truckId: t.id, haulId: h.id })));
    const kinds = s.provides.length > 0 ? s.provides : [s.cands[0].kind];
    const name = s.cands.length === 1 ? `the ${s.cands[0].name}` : `a ${s.kinds.join(" or ").toLowerCase()}`;
    for (const k of kinds) {
      missing.push(
        pairs.length === 0
          ? { kind: k, reason: "NO_RIG", text: `no free truck can tow ${name}` }
          : { kind: k, reason: "NO_LEGAL_DRIVER", text: `nobody on the crew can legally drive a truck towing ${name}` },
      );
    }
    if (pairs.length > 0) needDriverFor.push({ pairs, carriedLbs: orderLbs[i] });
  });
  if (req.needTruck && rigs.length === 0) {
    missing.push(
      needDriverFor.length > 0
        ? { kind: "Truck", reason: "NO_LEGAL_DRIVER", text: "nobody on the crew can legally drive a free truck" }
        : { kind: "Truck", reason: "NO_RIG", text: "no truck with a trailer or chipper to tow is free" },
    );
  }
  usedIds.push(...loose);
  return {
    rigs,
    loose: loose.sort(),
    missing,
    used: usedIds,
    seatCap: rigs.length > 0 && seatsKnown ? seatCap : INF,
    strandedLocked: lockedTrucks.filter((t) => !rigs.some((r) => r.truckId === t.id)).map((t) => t.id),
    needDriverFor,
  };
}

// --------------------------------------------------------------- routes

export interface RouteLeg {
  from: number; // job index, -1 = yard
  to: number;
  min: number;
  overridden: boolean;
}

export interface RouteResult {
  order: number[];
  dropped: number[];
  start: number[];
  end: number[];
  driveIn: number[];
  driveMin: number;
  idleMin: number;
  lateMin: number;
  late: Array<{ job: number; min: number }>;
  overrunMin: number;
  clusterMin: number;
  legs: RouteLeg[];
}

const roundUp15 = (m: number) => Math.ceil(m / 15) * 15;

function simulate(ctx: Ctx, order: number[], withReturn = true): RouteResult {
  const s = ctx.input.settings;
  const d = ctx.input.drive;
  const node = (i: number) => ctx.jobs[i].node;
  const start: number[] = [];
  const end: number[] = [];
  const driveIn: number[] = [];
  const legs: RouteLeg[] = [];
  const late: RouteResult["late"] = [];
  let drive = 0;
  let idle = 0;
  let lateMin = 0;
  let cluster = 0;
  let prevEnd = s.dayStartMin;
  order.forEach((ji, k) => {
    const job = ctx.jobs[ji];
    const leg = k === 0 ? d[0][node(ji)] : d[node(order[k - 1])][node(ji)];
    drive += leg;
    driveIn.push(leg);
    if (k > 0) {
      const overridden = ctx.jobUnit[order[k - 1]] === ctx.jobUnit[ji];
      legs.push({ from: order[k - 1], to: ji, min: leg, overridden });
      if (!overridden && leg > s.clusterMaxMinutes) cluster += leg - s.clusterMaxMinutes;
    } else legs.push({ from: -1, to: ji, min: leg, overridden: false });
    const arrive = k === 0 ? prevEnd + leg : prevEnd + leg + s.travelBufferMin;
    let st = roundUp15(arrive);
    if (job.fixedStartMin != null) {
      if (arrive <= job.fixedStartMin) {
        if (k > 0) idle += job.fixedStartMin - arrive;
        st = job.fixedStartMin;
      } else {
        lateMin += st - job.fixedStartMin;
        late.push({ job: ji, min: st - job.fixedStartMin });
      }
    } else if (k > 0) idle += st - arrive;
    start.push(st);
    end.push(st + job.durationMin);
    prevEnd = st + job.durationMin;
  });
  if (order.length > 0 && withReturn) {
    const back = d[node(order[order.length - 1])][0];
    drive += back;
    legs.push({ from: order[order.length - 1], to: -1, min: back, overridden: false });
  }
  const overrunMin = order.length > 0 ? Math.max(0, prevEnd - s.dayEndMin) : 0;
  return {
    order,
    dropped: [],
    start,
    end,
    driveIn,
    driveMin: drive,
    idleMin: idle,
    lateMin,
    late,
    overrunMin,
    clusterMin: cluster,
    legs,
  };
}

/** Route objective, the same order as the score: lateness/overrun, cluster cap, then drive (+ weighted idle). */
function routeKey(ctx: Ctx, r: RouteResult): [number, number, number] {
  return [r.lateMin + r.overrunMin, r.clusterMin, r.driveMin * 100 + r.idleMin * ctx.input.settings.idleWeightPct];
}
const lessTriple = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

function bestOrder(ctx: Ctx, jobs: number[]): RouteResult {
  if (jobs.length <= 1) return simulate(ctx, [...jobs]);
  if (jobs.length <= 7) {
    // Every order, pruned: all three keys only grow along a route. The
    // route is extended one stop at a time (the same arithmetic as
    // simulate), so each search node costs O(1).
    const st = ctx.input.settings;
    const d = ctx.input.drive;
    // Start from the heuristic route, so the search prunes from the first branch.
    const seed = heuristicOrder(ctx, jobs);
    let bestK: [number, number, number] | null = routeKey(ctx, seed);
    let bestOrd: number[] = seed.order;
    const cur: number[] = [];
    const usedJ = new Set<number>();
    // Lower bounds for the stops still to place: each needs at least its
    // cheapest incoming leg and its own work time, and the route its
    // cheapest leg home.
    const minIn = new Map<number, number>();
    for (const j of jobs) {
      let m = d[0][ctx.jobs[j].node];
      for (const i of jobs) if (i !== j) m = Math.min(m, d[ctx.jobs[i].node][ctx.jobs[j].node]);
      minIn.set(j, m);
    }
    const rec = (last: number, prevEnd: number, drive: number, idle: number, late: number, cluster: number) => {
      const k = cur.length;
      if (k > 0 && bestK) {
        let restDrive = 0;
        let restTime = 0;
        let back = INF;
        for (const j of jobs) {
          if (usedJ.has(j)) continue;
          const m = minIn.get(j)!;
          restDrive += m;
          restTime += m + st.travelBufferMin + ctx.jobs[j].durationMin;
          back = Math.min(back, d[ctx.jobs[j].node][0]);
        }
        if (back === INF) back = 0; // complete: the leaf adds the exact leg home
        const p0 = late + Math.max(0, prevEnd + restTime - st.dayEndMin);
        const p2 = (drive + restDrive + back) * 100 + idle * st.idleWeightPct;
        // Ties are pruned too: only a strictly better route replaces the best.
        if (p0 !== bestK[0] ? p0 > bestK[0] : cluster !== bestK[1] ? cluster > bestK[1] : p2 >= bestK[2]) return;
      }
      if (k === jobs.length) {
        const total = drive + d[ctx.jobs[last].node][0];
        const key: [number, number, number] = [
          late + Math.max(0, prevEnd - st.dayEndMin),
          cluster,
          total * 100 + idle * st.idleWeightPct,
        ];
        if (!bestK || lessTriple(key, bestK)) {
          bestK = key;
          bestOrd = [...cur];
        }
        return;
      }
      for (const j of jobs) {
        if (usedJ.has(j)) continue;
        const job = ctx.jobs[j];
        const leg = k === 0 ? d[0][job.node] : d[ctx.jobs[last].node][job.node];
        let cl = cluster;
        if (k > 0 && ctx.jobUnit[last] !== ctx.jobUnit[j] && leg > st.clusterMaxMinutes) cl += leg - st.clusterMaxMinutes;
        const arrive = k === 0 ? prevEnd + leg : prevEnd + leg + st.travelBufferMin;
        let start = roundUp15(arrive);
        let id = idle;
        let lt = late;
        if (job.fixedStartMin != null) {
          if (arrive <= job.fixedStartMin) {
            if (k > 0) id += job.fixedStartMin - arrive;
            start = job.fixedStartMin;
          } else lt += start - job.fixedStartMin;
        } else if (k > 0) id += start - arrive;
        usedJ.add(j);
        cur.push(j);
        rec(j, start + job.durationMin, drive + leg, id, lt, cl);
        cur.pop();
        usedJ.delete(j);
      }
    };
    rec(-1, st.dayStartMin, 0, 0, 0, 0);
    return bestOrd === seed.order ? seed : simulate(ctx, bestOrd);
  }
  return heuristicOrder(ctx, jobs);
}

/** Fixed times first in time order, then nearest neighbour, then 2-opt. */
function heuristicOrder(ctx: Ctx, jobs: number[]): RouteResult {
  const d = ctx.input.drive;
  const left = new Set(jobs);
  const order: number[] = [];
  let at = 0;
  while (left.size > 0) {
    let pick = -1;
    let pickD = INF;
    for (const j of [...left].sort((a, b) => a - b)) {
      const fx = ctx.jobs[j].fixedStartMin ?? INF;
      const dd = d[at][ctx.jobs[j].node] + (fx === INF ? 0 : Math.floor(fx / 4));
      if (dd < pickD) {
        pick = j;
        pickD = dd;
      }
    }
    order.push(pick);
    left.delete(pick);
    at = ctx.jobs[pick].node;
  }
  let best = simulate(ctx, order);
  let bestK = routeKey(ctx, best);
  for (let pass = 0, improved = true; improved && pass < 20; pass++) {
    improved = false;
    for (let a = 0; a < order.length - 1; a++) {
      for (let b = a + 1; b < order.length; b++) {
        const cand = [...best.order.slice(0, a), ...best.order.slice(a, b + 1).reverse(), ...best.order.slice(b + 1)];
        const r = simulate(ctx, cand);
        const k = routeKey(ctx, r);
        if (lessTriple(k, bestK)) {
          best = r;
          bestK = k;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** A crew's route; jobs that make it run past the day (and are not locked) are left off, lowest value first. */
export function routeCrew(ctx: Ctx, jobs: number[]): RouteResult {
  const key = jobs.join(",");
  const hit = ctx.routeMemo.get(key);
  if (hit) return hit;
  let kept = [...jobs];
  const dropped: number[] = [];
  let r = bestOrder(ctx, kept);
  const tol = ctx.input.settings.overrunToleranceMin;
  while (r.overrunMin > tol && kept.length > 1) {
    const droppable = kept.filter((i) => {
      const j = ctx.jobs[i];
      return !j.inProgress && j.locked.people.length === 0 && j.locked.equipment.length === 0;
    });
    if (droppable.length === 0) break;
    const victim = droppable[droppable.length - 1]; // lowest value (jobs are in value order)
    kept = kept.filter((i) => i !== victim);
    dropped.push(victim);
    r = bestOrder(ctx, kept);
  }
  const out = { ...r, dropped: dropped.sort((a, b) => a - b) };
  ctx.routeMemo.set(key, out);
  return out;
}

// ---------------------------------------------------------- evaluation

export interface JobResult {
  missingSkills: string[];
  missingKinds: MissingKind[];
  short: number;
  climbFilled: number;
  groundFilled: number;
}

export interface CrewEval {
  req: CrewReq;
  members: string[];
  rig: RigOut;
  route: RouteResult;
  jobs: Map<number, JobResult>;
}

export interface Evaluation {
  score: number[];
  crews: CrewEval[];
  spare: string[];
  hard: string[];
}

export function jobNeedsCount(job: PlanJob): { skills: number; kinds: number; head: number } {
  return {
    skills: job.skills.length + (job.climbers > 0 ? 1 : 0) + (job.groundsmen > 0 ? 1 : 0),
    kinds: job.kinds.length,
    head: job.climbers + job.groundsmen,
  };
}

/** Score one split (crews in staffing order) with the given members. */
export function evaluate(ctx: Ctx, reqs: CrewReq[], members: string[][]): Evaluation {
  const n = ctx.jobs.length;
  const A = new Array<number>(n).fill(0);
  const B = new Array<number>(n).fill(0);
  const C = new Array<number>(n).fill(0);
  const used = new Set<string>();
  const crews: CrewEval[] = [];
  const hard: string[] = [];
  const s = ctx.input.settings;
  let lastResort = 0;
  let extra = 0;
  let lateOver = 0;
  // Minutes past day end beyond the tolerance that dropping jobs could
  // not fix (the jobs are locked). An impossible day is worse than any
  // missing skill or machine, so this ranks right after the hard rules.
  let excessOverrun = 0;
  let notPlaced = 0;
  let cluster = 0;
  let eff = 0;
  let maxDrive = 0;
  let offUsual = 0;
  let pairs = 0;
  let churn = 0;
  const todayMin = new Map<string, number>();
  const seen = new Set<string>();

  reqs.forEach((req, ci) => {
    const mem = members[ci];
    for (const id of mem) {
      if (seen.has(id)) hard.push(`person ${id} in two crews`);
      seen.add(id);
    }
    const rig = rigCrew(ctx, req, mem, used);
    for (const e of rig.used) {
      if (used.has(e)) hard.push(`equipment ${e} in two crews`);
      used.add(e);
    }
    const route = routeCrew(ctx, req.jobs);
    const lockedCount = req.lockedPeople.filter((p) => ctx.pIdx.has(p)).length;
    if (mem.length > Math.max(req.cap, lockedCount)) hard.push(`crew ${ci} over its cap`);
    // People locked on by hand stay even past the seats (flagged SEATS_SHORT).
    if (mem.length > Math.max(rig.seatCap, lockedCount)) hard.push(`crew ${ci} over its seats`);
    const memSkills = new Set<string>();
    mem.forEach((id) => ctx.pSkills[ctx.pIdx.get(id) ?? -1]?.forEach((sk) => memSkills.add(sk)));
    const covered = new Set<EquipmentKind>();
    for (const r of rig.rigs) {
      covered.add("Truck");
      covered.add(ctx.eqById.get(r.haulId)!.kind);
      r.carriedIds.forEach((c) => covered.add(ctx.eqById.get(c)!.kind));
      if (r.extra) extra++;
    }
    rig.loose.forEach((c) => covered.add(ctx.eqById.get(c)!.kind));
    const jobsOut = new Map<number, JobResult>();
    for (const ji of req.jobs) {
      const job = ctx.jobs[ji];
      if (route.dropped.includes(ji)) {
        const nc = jobNeedsCount(job);
        A[ji] = nc.skills;
        B[ji] = nc.kinds;
        C[ji] = nc.head;
        notPlaced++;
        continue;
      }
      const missingSkills = job.skills.filter((sk) => !memSkills.has(sk));
      if (job.climbers > 0 && !memSkills.has("climbing")) missingSkills.unshift("climbing");
      if (job.groundsmen > 0 && !memSkills.has("ground_work")) missingSkills.push("ground_work");
      const rf = roleFilled(ctx, mem, job.climbers, job.groundsmen);
      // A crew with nobody on it is short even when the rules ask for no one in particular.
      const short = Math.max(job.climbers + job.groundsmen - rf.climbFilled - rf.groundFilled, mem.length === 0 ? 1 : 0);
      const missingKinds: MissingKind[] = [];
      for (const k of job.kinds) {
        if (covered.has(k)) continue;
        missingKinds.push(
          rig.missing.find((m) => m.kind === k) ?? { kind: k, reason: "NO_RIG", text: `no ${k.toLowerCase()} free` },
        );
      }
      A[ji] = missingSkills.length;
      B[ji] = missingKinds.length;
      C[ji] = short;
      jobsOut.set(ji, { missingSkills, missingKinds, short, ...rf });
      for (const pid of mem) if (!job.existingCrewIds.includes(pid)) churn++;
      for (const pid of job.existingCrewIds) if (!mem.includes(pid)) churn++;
    }
    lateOver += route.lateMin + route.overrunMin;
    excessOverrun += Math.max(0, route.overrunMin - s.overrunToleranceMin);
    cluster += route.clusterMin;
    eff += route.driveMin * 100 + route.idleMin * s.idleWeightPct;
    maxDrive = Math.max(maxDrive, route.driveMin);
    const work = route.order.reduce((t, ji) => t + ctx.jobs[ji].durationMin, 0) + route.driveMin;
    for (let a = 0; a < mem.length; a++) {
      const p = ctx.people[ctx.pIdx.get(mem[a]) ?? -1];
      if (!p) continue;
      if (p.lastResort) lastResort++;
      if (!p.usualDay) offUsual++;
      todayMin.set(p.id, work);
      for (let b = a + 1; b < mem.length; b++) {
        const q = ctx.people[ctx.pIdx.get(mem[b]) ?? -1];
        if (q && (p.worksWellWith.includes(q.id) || q.worksWellWith.includes(p.id))) pairs++;
      }
    }
    crews.push({ req, members: mem, rig, route, jobs: jobsOut });
  });
  let fairness = 0;
  for (const p of ctx.people) {
    const h = Math.round((p.weekMinutes + (todayMin.get(p.id) ?? 0)) / 60);
    fairness += h * h;
  }
  const spare = ctx.people.map((p) => p.id).filter((id) => !seen.has(id));
  const score = [
    hard.length,
    excessOverrun,
    ...A,
    ...B,
    ...C,
    lastResort,
    lateOver,
    notPlaced,
    cluster,
    eff,
    extra,
    maxDrive,
    offUsual,
    fairness,
    -pairs,
    churn,
  ];
  return { score, crews, spare, hard };
}

export function compareScores(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

/** Names of the score tiers, for the explanation trail and the tests. */
export function scoreLayout(nJobs: number): { A: number; B: number; C: number; rest: string[] } {
  return {
    A: 2,
    B: 2 + nJobs,
    C: 2 + 2 * nJobs,
    rest: [
      "lastResort",
      "lateOrOverrunMin",
      "notPlaced",
      "clusterCapMin",
      "efficiency",
      "vehicleExtraDrives",
      "maxCrewDrive",
      "offUsualDay",
      "fairness",
      "worksWellWith",
      "churn",
    ],
  };
}

// ------------------------------------------------------------ staffing

interface StaffState {
  members: string[][];
  assigned: Set<string>;
  seatCap: number[];
}

function openNeeds(ctx: Ctx, req: CrewReq, mem: readonly string[]) {
  const have = new Set<string>();
  mem.forEach((id) => ctx.pSkills[ctx.pIdx.get(id) ?? -1]?.forEach((s) => have.add(s)));
  const rf = roleFilled(ctx, mem, req.climb, req.ground);
  const legal = mem.filter((id) => ctx.people[ctx.pIdx.get(id) ?? -1]?.legalDriver).length;
  const rigsWanted = req.hauls.length + (req.hauls.length === 0 && (req.needTruck || req.carried.length > 0) ? 1 : 0);
  return {
    presence: req.presence.filter((s) => !have.has(s)),
    climb: req.climb - rf.climbFilled,
    ground: req.ground - rf.groundFilled,
    drivers: Math.max(0, rigsWanted - legal),
    head: Math.max(0, req.minHead - mem.length),
  };
}

function coverage(ctx: Ctx, p: PlanPerson, need: ReturnType<typeof openNeeds>): number {
  const s = ctx.pSkills[ctx.pIdx.get(p.id)!];
  let n = 0;
  for (const sk of need.presence) if (s.has(sk)) n++;
  if (need.climb > 0 && s.has("climbing")) n++;
  if (need.ground > 0 && s.has("ground_work")) n++;
  if (need.drivers > 0 && p.legalDriver) n++;
  return n;
}

function links(p: PlanPerson, mem: readonly string[], ctx: Ctx): number {
  let n = 0;
  for (const id of mem) {
    if (p.worksWellWith.includes(id)) n++;
    if (ctx.people[ctx.pIdx.get(id) ?? -1]?.worksWellWith.includes(p.id)) n++;
  }
  return n;
}

function wanted(req: CrewReq): Set<string> {
  const w = new Set(req.presence);
  if (req.climb > 0) w.add("climbing");
  if (req.ground > 0) w.add("ground_work");
  return w;
}

/** Best free person for a crew: not last resort, covers most open needs, usual day, fewest unneeded skills, works well with, fewest week hours, id. */
function pickPerson(
  ctx: Ctx,
  st: StaffState,
  ci: number,
  req: CrewReq,
  filter: (p: PlanPerson) => boolean,
  allowLR: boolean,
  opts: { requireUsual?: boolean } = {},
): PlanPerson | null {
  const mem = st.members[ci];
  const need = openNeeds(ctx, req, mem);
  const want = wanted(req);
  let best: PlanPerson | null = null;
  let bestKey: number[] = [];
  for (const p of ctx.people) {
    if (st.assigned.has(p.id)) continue;
    if (p.lastResort && !allowLR) continue;
    if (opts.requireUsual && !p.usualDay) continue;
    if (!filter(p)) continue;
    const unneeded = p.skills.filter((s) => !want.has(s)).length;
    const key = [
      p.lastResort ? 1 : 0,
      -coverage(ctx, p, need),
      p.usualDay ? 0 : 1,
      unneeded,
      -links(p, mem, ctx),
      p.weekMinutes,
    ];
    let better = best == null;
    if (!better) {
      for (let i = 0; i < key.length; i++) {
        if (key[i] !== bestKey[i]) {
          better = key[i] < bestKey[i];
          break;
        }
        if (i === key.length - 1) better = p.id < best!.id;
      }
    }
    if (better) {
      best = p;
      bestKey = key;
    }
  }
  return best;
}

const room = (st: StaffState, req: CrewReq, ci: number) =>
  Math.min(req.cap, st.seatCap[ci]) - st.members[ci].length;

function add(st: StaffState, ci: number, id: string) {
  st.members[ci].push(id);
  st.assigned.add(id);
}

/**
 * Staff one split: locked people, then skills (rarest first), then
 * drivers, then headcount, then extras. `allowLR` lets last-resort
 * people in, always as the last choice.
 */
export function staff(ctx: Ctx, reqs: CrewReq[], allowLR: boolean): string[][] {
  const st: StaffState = {
    members: reqs.map(() => []),
    assigned: new Set(),
    seatCap: reqs.map(() => INF),
  };
  reqs.forEach((req, ci) => {
    for (const p of req.lockedPeople) if (ctx.pIdx.has(p) && !st.assigned.has(p)) add(st, ci, p);
  });

  // Skills, rarest first (supply / demand, compared without division).
  const demand = new Map<string, number>();
  reqs.forEach((req, ci) => {
    const need = openNeeds(ctx, req, st.members[ci]);
    for (const s of need.presence) demand.set(s, (demand.get(s) ?? 0) + 1);
    if (need.climb > 0) demand.set("climbing", (demand.get("climbing") ?? 0) + need.climb);
    if (need.ground > 0) demand.set("ground_work", (demand.get("ground_work") ?? 0) + need.ground);
  });
  const supply = (s: string) =>
    ctx.people.filter((p) => !st.assigned.has(p.id) && (allowLR || !p.lastResort) && ctx.pSkills[ctx.pIdx.get(p.id)!].has(s)).length;
  const skills = [...demand.entries()]
    .map(([s, d]) => ({ s, d, sup: supply(s) }))
    .sort((a, b) => a.sup * b.d - b.sup * a.d || a.s.localeCompare(b.s));
  for (const { s } of skills) {
    reqs.forEach((req, ci) => {
      for (let guard = 0; guard < 20; guard++) {
        const need = openNeeds(ctx, req, st.members[ci]);
        const open = s === "climbing" ? need.climb : s === "ground_work" ? need.ground : need.presence.includes(s) ? 1 : 0;
        if (open <= 0 || room(st, req, ci) <= 0) break;
        const p = pickPerson(ctx, st, ci, req, (x) => ctx.pSkills[ctx.pIdx.get(x.id)!].has(s), allowLR);
        if (!p) break;
        add(st, ci, p.id);
      }
    });
  }

  // Drivers: rig each crew in order; add a legal driver when a truck is free but nobody can drive it.
  const used = new Set<string>();
  reqs.forEach((req, ci) => {
    let rig = rigCrew(ctx, req, st.members[ci], used);
    for (let guard = 0; guard < 4 && rig.needDriverFor.length > 0; guard++) {
      if (Math.min(req.cap, rig.seatCap) - st.members[ci].length <= 0) break;
      const want = rig.needDriverFor[0];
      const p = pickPerson(
        ctx,
        st,
        ci,
        req,
        (x) =>
          want.pairs.some(
            (pair) =>
              canDriveTruck(
                x,
                ctx.eqById.get(pair.truckId)!,
                ctx.eqById.get(pair.haulId)!,
                ctx.input.settings.cdlAWeightLbs,
                want.carriedLbs,
              ).ok,
          ),
        allowLR,
      );
      if (!p) break;
      add(st, ci, p.id);
      rig = rigCrew(ctx, req, st.members[ci], used);
    }
    rig.used.forEach((e) => used.add(e));
    st.seatCap[ci] = rig.seatCap;
  });

  // Headcount up to each crew's minimum.
  reqs.forEach((req, ci) => {
    for (let guard = 0; guard < 30; guard++) {
      if (st.members[ci].length >= req.minHead || room(st, req, ci) <= 0) break;
      const p = pickPerson(ctx, st, ci, req, () => true, allowLR);
      if (!p) break;
      add(st, ci, p.id);
    }
  });

  // Extras: leftover people to the most valuable crews, up to the cap. Never last-resort people.
  reqs.forEach((req, ci) => {
    for (let guard = 0; guard < 30; guard++) {
      if (st.members[ci].length >= req.extrasLimit || room(st, req, ci) <= 0) break;
      const p = pickPerson(ctx, st, ci, req, () => true, false, { requireUsual: true });
      if (!p) break;
      add(st, ci, p.id);
    }
  });

  // Seats: never more people than the trucks can carry.
  reqs.forEach((req, ci) => {
    while (st.members[ci].length > st.seatCap[ci]) {
      const removable = [...st.members[ci]].reverse().find((id) => !req.lockedPeople.includes(id));
      if (!removable) break;
      st.members[ci] = st.members[ci].filter((id) => id !== removable);
      st.assigned.delete(removable);
    }
  });
  for (const m of st.members) m.sort();
  return st.members;
}
