/**
 * Plan board: who goes where, when crews split up and meet again.
 *
 * Work is measured in dollars of job value: a crew of up to
 * `fullSpeedCrew` people (default 3) gets through `dollarsPerHour`
 * (default $400) an hour, so an $800 job is 2 hours. Every person past
 * that adds the same share: 6 people do $800 an hour.
 *
 * The day is simulated minute by minute. Each person follows their own
 * route (an ordered list of jobs). With "auto help" on (the auto-fill),
 * anyone whose route is finished drives to the job where they help
 * most: a job nobody has started yet first, else the one that would
 * otherwise finish last. That is how "two people knock out the $400 job,
 * everyone else starts the $6,500 job, and the two meet them there"
 * happens: nothing special-cases it.
 *
 * Every available person goes on a job site (owner's rule).
 */
import type { PlannerInput } from "./types";

export interface MeetJob {
  id: string;
  title: string;
  /** Dollars of work on this date. */
  work: number;
  /** Row/column in `drive` (0 = shop). */
  node: number;
  /** Work cannot start before this (a promised time); null = any time. */
  fixedStartMin: number | null;
  climbers: number;
  skills: string[];
}

export interface MeetPerson {
  id: string;
  name: string;
  legalDriver: boolean;
  skills: string[];
  /**
   * "usually off Mondays" when the day is not one of their usual weekdays
   * (business rule): Auto-fill and Fill never place them, but they can
   * be dragged on by hand.
   */
  usuallyOff?: string;
}

export interface MeetInput {
  jobs: MeetJob[];
  people: MeetPerson[];
  /** Drive minutes between nodes; 0 = shop. */
  drive: number[][];
  dayStartMin: number;
  dayEndMin: number;
  dollarsPerHour: number;
  fullSpeedCrew: number;
  minTeam: number;
  /**
   * Start the day at this minute instead of `dayStartMin` (re-planning
   * the rest of today from now). Optional: leaving it out changes nothing.
   */
  startMin?: number;
  /**
   * Where people are when the simulation starts. Anyone not listed starts
   * at the shop. `jobId`: already working on that job (they stay until it
   * is done, then follow their route); `node`: idle at that place.
   */
  startAt?: Record<string, { jobId?: string | null; node?: number }>;
  /**
   * People placed by hand whose route Auto-fill keeps as it is (it plans
   * everyone else around them). Optional: leaving it out changes nothing.
   */
  fixedRoutes?: Routes;
}

/** person id -> the jobs they go to, in order. */
export type Routes = Record<string, string[]>;

export interface JobTimeline {
  jobId: string;
  startMin: number | null;
  endMin: number | null;
  /** person id -> minute they arrive (first time). */
  arrivals: Record<string, number>;
  /** person id -> minute they leave. */
  leaves: Record<string, number>;
  /** Dollars of work not done by the end of the simulation. */
  remaining: number;
}

export interface SimResult {
  jobs: Record<string, JobTimeline>;
  /** The route each person actually followed (with auto help, the jobs they were sent to). */
  routes: Routes;
  /** person id -> minute they finish their last job (null = never went out). */
  freeAt: Record<string, number | null>;
  /** When the last job is done (or the simulation gave up). */
  finishMin: number;
  /** Minutes of driving, counting people who leave together for the same place once. */
  vehicleDriveMin: number;
  unfinished: string[];
}

/** Dollars per minute for n people on a job. */
export function ratePerMin(input: Pick<MeetInput, "dollarsPerHour" | "fullSpeedCrew">, n: number): number {
  if (n <= 0) return 0;
  return (input.dollarsPerHour * Math.max(1, n / input.fullSpeedCrew)) / 60;
}

/** Hours a job of `work` dollars takes for a crew of n. */
export function hoursFor(input: Pick<MeetInput, "dollarsPerHour" | "fullSpeedCrew">, work: number, n: number): number {
  const r = ratePerMin(input, n);
  return r > 0 ? work / r / 60 : Infinity;
}

const LIMIT_MIN = 18 * 60;

export function simulate(input: MeetInput, routes: Routes, opts: { autoHelp?: boolean } = {}): SimResult {
  const jobById = new Map(input.jobs.map((j) => [j.id, j]));
  const remaining = new Map(input.jobs.map((j) => [j.id, Math.max(0, j.work)]));
  const timeline: Record<string, JobTimeline> = Object.fromEntries(
    input.jobs.map((j) => [j.id, { jobId: j.id, startMin: null, endMin: null, arrivals: {}, leaves: {}, remaining: 0 }]),
  );
  // A job with no work is done as soon as someone gets there.
  type P = {
    id: string;
    route: string[];
    idx: number;
    loc: number;
    status: "idle" | "drive" | "work" | "done";
    dest: string | null;
    arriveAt: number;
  };
  const startAt = input.startAt ?? {};
  const handOnly = new Set(input.people.filter((p) => p.usuallyOff).map((p) => p.id));
  const start = input.startMin ?? input.dayStartMin;
  const people: P[] = input.people
    .filter((p) => routes[p.id] !== undefined || opts.autoHelp || startAt[p.id] !== undefined)
    .map((p) => {
      const at = startAt[p.id];
      const here = at?.jobId && jobById.has(at.jobId) && (remaining.get(at.jobId) ?? 0) > 0 ? at.jobId : null;
      const route = [...(routes[p.id] ?? [])].filter((id) => jobById.has(id) && id !== here);
      const loc = here ? jobById.get(here)!.node : (at?.node ?? 0);
      return { id: p.id, route, idx: 0, loc, status: here ? "work" : "idle", dest: here, arriveAt: start };
    });
  const actual: Routes = Object.fromEntries(people.map((p) => [p.id, p.dest ? [p.dest] : []]));
  // People already working on a job when the simulation starts.
  for (const p of people) {
    if (!p.dest) continue;
    const tl = timeline[p.dest];
    tl.arrivals[p.id] = start;
    if (tl.startMin === null) tl.startMin = start;
  }
  const freeAt: Record<string, number | null> = Object.fromEntries(input.people.map((p) => [p.id, null]));
  const legs = new Set<string>();
  let vehicleDriveMin = 0;
  const drive = (a: number, b: number) => (a === b ? 0 : Math.max(0, input.drive[a]?.[b] ?? 0));
  const done = (id: string) => (remaining.get(id) ?? 0) <= 1e-9 && timeline[id].endMin != null;
  const workersOn = (id: string) => people.filter((p) => p.dest === id && (p.status === "work" || p.status === "drive")).length;

  const helpTarget = (p: P, t: number): string | null => {
    let best: { id: string; key: number[] } | null = null;
    for (const j of input.jobs) {
      if (done(j.id)) continue;
      const rem = remaining.get(j.id) ?? 0;
      const n = workersOn(j.id);
      const d = drive(p.loc, j.node);
      // Minutes from now until work there can start (drive, then any promised time).
      const ready = Math.max(d, (j.fixedStartMin ?? -Infinity) - t);
      let key: number[];
      if (n === 0) {
        // Nobody on it yet: it must be started. One that can start when I get
        // there beats one with a later promised time; then nearest, then bigger.
        key = [ready > d ? 2 : 0, 0, ready, -rem];
      } else if (n < input.minTeam) {
        // Started but short-handed (fewer than the smallest team): top it up
        // before helping anywhere else, so nobody is left alone on a job.
        key = [ready > d ? 2 : 0, 1, ready, -rem];
      } else {
        const r = ratePerMin(input, n);
        const finishNow = Math.max(0, (j.fixedStartMin ?? -Infinity) - t) + rem / r;
        // The people there finish before I could arrive: no point going.
        if (finishNow <= d) continue;
        const workedBeforeMe = Math.max(0, d - Math.max(0, (j.fixedStartMin ?? -Infinity) - t));
        const remAtArrival = Math.max(0, rem - r * workedBeforeMe);
        const finishWithMe = ready + remAtArrival / ratePerMin(input, n + 1);
        // The biggest saving first; when nobody saves time, the job that ends last.
        key = [1, 0, -(finishNow - finishWithMe), -finishNow, d];
      }
      if (!best || compare(key, best.key) < 0) best = { id: j.id, key };
    }
    return best?.id ?? null;
  };

  let t = start;
  for (; t < start + LIMIT_MIN; t++) {
    // Arrivals and departures (repeat: someone may arrive at a job that just finished).
    for (let guard = 0; guard < 4; guard++) {
      let changed = false;
      for (const p of people) {
        if (p.status === "drive" && p.arriveAt <= t && p.dest) {
          p.loc = jobById.get(p.dest)!.node;
          if (done(p.dest)) {
            // Finished before they got there: the trip doesn't count as going there.
            const a = actual[p.id];
            if (a[a.length - 1] === p.dest) a.pop();
            p.status = "idle";
          } else {
            p.status = "work";
            const tl = timeline[p.dest];
            if (tl.arrivals[p.id] === undefined) tl.arrivals[p.id] = t;
            if (tl.startMin === null || t < tl.startMin) tl.startMin = t;
          }
          changed = true;
        }
        if (p.status === "idle") {
          let next: string | null = null;
          while (p.idx < p.route.length) {
            const id = p.route[p.idx++];
            if (!done(id)) {
              next = id;
              break;
            }
          }
          // Someone usually off today only goes where they were put by hand:
          // auto help never sends them on to another job.
          if (!next && opts.autoHelp && !handOnly.has(p.id)) next = helpTarget(p, t);
          if (!next) {
            p.status = "done";
            p.dest = null;
            continue;
          }
          const node = jobById.get(next)!.node;
          const d = drive(p.loc, node);
          if (d > 0) {
            const leg = `${p.loc}>${node}@${t}`;
            if (!legs.has(leg)) {
              legs.add(leg);
              vehicleDriveMin += d;
            }
          }
          p.status = "drive";
          p.dest = next;
          p.arriveAt = t + d;
          actual[p.id].push(next);
          changed = true;
        }
      }
      if (!changed) break;
    }
    // One minute of work.
    let anyActive = false;
    const finishing: string[] = [];
    for (const j of input.jobs) {
      if (done(j.id)) continue;
      if (j.fixedStartMin != null && t < j.fixedStartMin) {
        if (workersOn(j.id) > 0) anyActive = true;
        continue;
      }
      const n = people.filter((p) => p.status === "work" && p.dest === j.id).length;
      if (n === 0) continue;
      anyActive = true;
      const tl = timeline[j.id];
      if (j.fixedStartMin != null && (tl.startMin === null || tl.startMin < j.fixedStartMin)) tl.startMin = j.fixedStartMin;
      const rem = (remaining.get(j.id) ?? 0) - ratePerMin(input, n);
      remaining.set(j.id, rem);
      if (rem <= 1e-9) finishing.push(j.id);
    }
    for (const id of finishing) {
      remaining.set(id, 0);
      const tl = timeline[id];
      tl.endMin = t + 1;
      for (const p of people) {
        if (p.status === "work" && p.dest === id) {
          tl.leaves[p.id] = t + 1;
          freeAt[p.id] = t + 1;
          p.status = "idle";
          p.dest = null;
        }
      }
    }
    if (!anyActive && people.every((p) => p.status === "done" || p.status === "idle") && finishing.length === 0) {
      // Everyone idle with nothing left to pick: stop after one more pass.
      if (people.every((p) => p.status === "done")) break;
    }
    if (people.every((p) => p.status === "done")) break;
  }
  // People still working when the simulation gave up.
  for (const p of people) {
    if (p.status === "work" && p.dest) {
      timeline[p.dest].leaves[p.id] = t;
      freeAt[p.id] = t;
    }
  }
  const unfinished: string[] = [];
  let finishMin = start;
  for (const j of input.jobs) {
    const tl = timeline[j.id];
    tl.remaining = Math.max(0, remaining.get(j.id) ?? 0);
    if (tl.endMin == null) {
      if (j.work > 0 || Object.keys(tl.arrivals).length === 0) unfinished.push(j.id);
      else tl.endMin = tl.startMin;
    }
    finishMin = Math.max(finishMin, tl.endMin ?? t);
  }
  return { jobs: timeline, routes: actual, freeAt, finishMin, vehicleDriveMin, unfinished };
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Needs not covered on each job by the people who worked there. */
export function coverageProblems(input: MeetInput, sim: SimResult): Array<{ jobId: string; text: string }> {
  const byId = new Map(input.people.map((p) => [p.id, p]));
  const out: Array<{ jobId: string; text: string }> = [];
  for (const j of input.jobs) {
    const who = Object.keys(sim.jobs[j.id]?.arrivals ?? {}).map((id) => byId.get(id)).filter((p): p is MeetPerson => !!p);
    if (who.length === 0) continue;
    const climbers = who.filter((p) => p.skills.includes("climbing")).length;
    if (climbers < j.climbers) out.push({ jobId: j.id, text: `needs ${j.climbers} climber${j.climbers === 1 ? "" : "s"}, has ${climbers}` });
    for (const s of j.skills) {
      if (!who.some((p) => p.skills.includes(s))) out.push({ jobId: j.id, text: `nobody with ${s.replace(/_/g, " ")}` });
    }
  }
  return out;
}

/** Teams that leave the shop without a legal driver. */
export function driverProblems(input: MeetInput, routes: Routes): string[] {
  const groups = new Map<string, MeetPerson[]>();
  for (const p of input.people) {
    // Already on a site (re-planning from now): they don't leave the shop.
    const at = input.startAt?.[p.id];
    if (at?.jobId || (at?.node ?? 0) !== 0) continue;
    const first = routes[p.id]?.[0];
    if (!first) continue;
    groups.set(first, [...(groups.get(first) ?? []), p]);
  }
  return [...groups.entries()].filter(([, ps]) => !ps.some((p) => p.legalDriver)).map(([jobId]) => jobId);
}

export interface AutoFill {
  routes: Routes;
  sim: SimResult;
  /** The teams leaving the shop: first job -> people. */
  teams: Array<{ jobId: string; people: string[] }>;
  score: number[];
  tried: number;
}

/** Score of a plan, lower is better: problems, unfinished jobs, finish time (10-minute steps), driving. */
export function scoreSim(input: MeetInput, routes: Routes, sim: SimResult): number[] {
  const problems = coverageProblems(input, sim).length + driverProblems(input, routes).length;
  return [problems, sim.unfinished.length, Math.ceil(sim.finishMin / 10), sim.vehicleDriveMin, sim.finishMin];
}

function* combinations<T>(items: T[], k: number, from = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = from; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * Pick people for teams that leave the shop: each small team gets a
 * driver and the skills its job needs, then fills up with the people
 * whose skills are least needed elsewhere; the main team (the first
 * one) gets everybody left.
 */
function staffTeams(input: MeetInput, jobs: MeetJob[], size: number): string[][] {
  const pool = [...input.people];
  const take = (pred: (p: MeetPerson) => boolean, preferNonDriver = false): MeetPerson | null => {
    const c = pool
      .filter(pred)
      .sort(
        (a, b) =>
          (preferNonDriver ? Number(a.legalDriver) - Number(b.legalDriver) : 0) ||
          a.skills.length - b.skills.length ||
          a.id.localeCompare(b.id),
      )[0];
    if (!c) return null;
    pool.splice(pool.indexOf(c), 1);
    return c;
  };
  const teams: string[][] = jobs.map(() => []);
  // Small teams first (index 1..), smallest job first so the main team keeps the skills.
  const order = jobs.map((_, i) => i).slice(1).sort((a, b) => jobs[a].work - jobs[b].work);
  // Reserve one driver for the main team.
  const mainDriver = take((p) => p.legalDriver && p.skills.includes("climbing")) ?? take((p) => p.legalDriver);
  for (const i of order) {
    const j = jobs[i];
    const team: MeetPerson[] = [];
    const d = take((p) => p.legalDriver);
    if (d) team.push(d);
    for (let c = team.filter((p) => p.skills.includes("climbing")).length; c < j.climbers; c++) {
      const x = take((p) => p.skills.includes("climbing"));
      if (x) team.push(x);
    }
    for (const s of j.skills) {
      if (team.some((p) => p.skills.includes(s))) continue;
      const x = take((p) => p.skills.includes(s));
      if (x) team.push(x);
    }
    while (team.length < size) {
      const x = take(() => true, true);
      if (!x) break;
      team.push(x);
    }
    teams[i] = team.map((p) => p.id);
  }
  teams[0] = [...(mainDriver ? [mainDriver.id] : []), ...pool.map((p) => p.id)];
  return teams;
}

/**
 * The auto-fill: tries every way of splitting the crew into teams that
 * leave the shop (the biggest job always gets the main team; each
 * smaller team starts at one of the other jobs), simulates each with
 * auto help, and keeps the best. Everyone available goes out.
 */
export function autoFill(input: MeetInput): AutoFill | null {
  if (input.jobs.length === 0 || input.people.length === 0) return null;
  const jobs = [...input.jobs].sort((a, b) => b.work - a.work || a.id.localeCompare(b.id));
  // People already working on a job (re-planning from now) stay there; the
  // rest are split into teams leaving the shop.
  const jobIds = new Set(input.jobs.map((j) => j.id));
  const pinned: Routes = {};
  for (const p of input.people) {
    const j = input.startAt?.[p.id]?.jobId;
    if (j && jobIds.has(j)) pinned[p.id] = [j];
  }
  // People placed by hand keep their route.
  for (const p of input.people) {
    if (pinned[p.id]) continue;
    const r = (input.fixedRoutes?.[p.id] ?? []).filter((id) => jobIds.has(id));
    if (r.length > 0) pinned[p.id] = r;
  }
  const freeInput: MeetInput = { ...input, people: input.people.filter((p) => !pinned[p.id]) };
  if (freeInput.people.length === 0) {
    const sim = simulate(input, pinned, { autoHelp: true });
    const teams = [...new Set(Object.values(pinned).map((r) => r[0]))].map((jobId) => ({
      jobId,
      people: Object.keys(pinned).filter((pid) => pinned[pid][0] === jobId),
    }));
    return { routes: sim.routes, sim, teams, score: scoreSim(input, sim.routes, sim), tried: 1 };
  }
  const N = freeInput.people.length;
  const maxTeams = Math.max(1, Math.min(jobs.length, Math.floor(N / Math.max(1, input.minTeam))));
  const sizes = [...new Set([input.minTeam, input.fullSpeedCrew])];
  let best: AutoFill | null = null;
  let tried = 0;
  // The main team usually takes the biggest job; when that one has a later
  // promised time, starting somewhere else first can be better, so each job
  // gets a turn as the main team's first stop (biggest first).
  search: for (const main of jobs) {
    const rest = jobs.filter((j) => j !== main);
    for (let T = 1; T <= maxTeams; T++) {
      for (const others of combinations(rest, T - 1)) {
        for (const size of T === 1 ? [input.minTeam] : sizes) {
          if (T > 1 && N - size * (T - 1) < 1) continue;
          const starts = [main, ...others];
          const teams = staffTeams(freeInput, starts, size);
          if (teams.some((t) => t.length === 0)) continue;
          const routes: Routes = { ...pinned };
          teams.forEach((ids, i) => ids.forEach((id) => (routes[id] = [starts[i].id])));
          const sim = simulate(input, routes, { autoHelp: true });
          const score = scoreSim(input, sim.routes, sim);
          tried++;
          if (!best || compare(score, best.score) < 0) {
            best = { routes: sim.routes, sim, teams: starts.map((s, i) => ({ jobId: s.id, people: teams[i] })), score, tried: 0 };
          }
          if (tried >= 2000) break search;
        }
      }
    }
  }
  if (best) best.tried = tried;
  return best;
}

/** Build the board's input from the planner's day input. */
export function meetInputFrom(
  p: PlannerInput,
  workOf: (jobId: string, value: number, durationMin: number) => number,
): MeetInput {
  return {
    jobs: p.jobs.map((j) => ({
      id: j.id,
      title: j.title,
      work: workOf(j.id, j.value, j.durationMin),
      node: j.node,
      fixedStartMin: j.fixedStartMin,
      climbers: j.climbers,
      skills: j.skills,
    })),
    people: p.people.map((x) => ({ id: x.id, name: x.name, legalDriver: x.legalDriver, skills: x.skills })),
    drive: p.drive,
    dayStartMin: p.settings.dayStartMin,
    dayEndMin: p.settings.dayEndMin,
    dollarsPerHour: p.settings.dollarsPerHour,
    fullSpeedCrew: p.settings.fullSpeedCrew,
    minTeam: p.settings.minTeam,
  };
}
