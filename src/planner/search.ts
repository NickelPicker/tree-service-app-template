/**
 * Step 3: search over ways to split the day's jobs into crews.
 *
 * The units are the lock groups (jobs that must share a crew). Up to
 * exactMaxGroups units, every split into at most Kmax crews is staffed
 * and scored. Above that, complete-linkage area clusters seed a local
 * search (move / swap / merge). Both stop at a fixed number of
 * evaluations, never at a time limit, so every device gets the same plan.
 * The best few splits then get a bounded person-swap repair.
 */
import {
  compareScores,
  crewReq,
  evaluate,
  staff,
  type CrewReq,
  type Ctx,
  type Evaluation,
} from "./engine";

export interface Candidate {
  key: string;
  reqs: CrewReq[];
  members: string[][];
  ev: Evaluation;
}

function partitionKey(groups: number[][]): string {
  return groups
    .map((g) => [...g].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
    .map((g) => g.join(","))
    .join("|");
}

/** Prefix of the score covering hard rules, unfixable day overrun and tiers A to C. */
function needsPrefix(ctx: Ctx, score: number[]): number[] {
  return score.slice(0, 2 + 3 * ctx.jobs.length);
}

function hasLastResortHelp(ctx: Ctx, ev: Evaluation): boolean {
  const needs = needsPrefix(ctx, ev.score).some((x) => x > 0);
  return needs && ev.spare.some((id) => ctx.people[ctx.pIdx.get(id)!].lastResort);
}

/** Staff and score one split. Last-resort people are tried only when a need is still open, and kept only if strictly better. */
export function evaluateSplit(ctx: Ctx, groups: number[][]): Candidate {
  const reqs = groups.map((g) => crewReq(ctx, g)).sort((a, b) => a.top - b.top);
  const m1 = staff(ctx, reqs, false);
  const ev1 = evaluate(ctx, reqs, m1);
  ctx.evaluations++;
  let best: Candidate = { key: partitionKey(groups), reqs, members: m1, ev: ev1 };
  if (hasLastResortHelp(ctx, ev1)) {
    const m2 = staff(ctx, reqs, true);
    const ev2 = evaluate(ctx, reqs, m2);
    ctx.evaluations++;
    if (compareScores(ev2.score, ev1.score) < 0) best = { ...best, members: m2, ev: ev2 };
  }
  return best;
}

class TopList {
  items: Candidate[] = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  offer(c: Candidate) {
    if (this.items.some((x) => x.key === c.key)) return;
    let i = this.items.length;
    while (i > 0 && compareScores(c.ev.score, this.items[i - 1].ev.score) < 0) i--;
    this.items.splice(i, 0, c);
    if (this.items.length > this.size) this.items.pop();
  }
}

function kMax(ctx: Ctx): number {
  return Math.max(1, Math.min(ctx.input.settings.maxCrews, ctx.units.length, Math.max(1, ctx.people.length)));
}

function exact(ctx: Ctx, top: TopList, budget: number): boolean {
  const n = ctx.units.length;
  const K = kMax(ctx);
  const assign = new Array<number>(n).fill(0);
  let complete = true;
  const rec = (i: number, used: number) => {
    if (!complete) return;
    if (i === n) {
      if (ctx.evaluations >= budget) {
        complete = false;
        return;
      }
      const groups: number[][] = Array.from({ length: used }, () => []);
      assign.forEach((g, u) => groups[g].push(u));
      top.offer(evaluateSplit(ctx, groups));
      return;
    }
    for (let g = 0; g < Math.min(used + 1, K); g++) {
      assign[i] = g;
      rec(i + 1, Math.max(used, g + 1));
    }
  };
  rec(0, 0);
  return complete;
}

function unitDistance(ctx: Ctx, a: number, b: number): number {
  const d = ctx.input.drive;
  let m = 0;
  for (const i of ctx.units[a].jobs) {
    for (const j of ctx.units[b].jobs) {
      const ni = ctx.jobs[i].node;
      const nj = ctx.jobs[j].node;
      m = Math.max(m, d[ni][nj], d[nj][ni]);
    }
  }
  return m;
}

/** Complete-linkage clusters of the units: merge the closest pair until `k` remain, or while within `maxDist`. */
function clusters(ctx: Ctx, k: number, maxDist: number): number[][] {
  let groups = ctx.units.map((_, i) => [i]);
  const dist = (g: number[], h: number[]) => {
    let m = 0;
    for (const a of g) for (const b of h) m = Math.max(m, unitDistance(ctx, a, b));
    return m;
  };
  while (groups.length > k) {
    let bi = -1;
    let bj = -1;
    let bd = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const dd = dist(groups[i], groups[j]);
        if (dd < bd) {
          bd = dd;
          bi = i;
          bj = j;
        }
      }
    }
    if (bd > maxDist) break;
    const merged = [...groups[bi], ...groups[bj]].sort((a, b) => a - b);
    groups = groups.filter((_, x) => x !== bi && x !== bj);
    groups.push(merged);
    groups.sort((a, b) => a[0] - b[0]);
  }
  return groups;
}

function local(ctx: Ctx, top: TopList, budget: number): void {
  const K = kMax(ctx);
  const memo = new Map<string, Candidate>();
  const evalMemo = (groups: number[][]): Candidate | null => {
    const g = groups.filter((x) => x.length > 0);
    const key = partitionKey(g);
    const hit = memo.get(key);
    if (hit) return hit;
    if (ctx.evaluations >= budget) return null;
    const c = evaluateSplit(ctx, g);
    memo.set(key, c);
    top.offer(c);
    return c;
  };
  const seeds: number[][][] = [];
  for (let k = 1; k <= K; k++) seeds.push(clusters(ctx, k, Number.MAX_SAFE_INTEGER));
  const byArea = clusters(ctx, 1, ctx.input.settings.clusterMaxMinutes);
  if (byArea.length <= K) seeds.push(byArea);

  for (const seed of seeds) {
    let cur = evalMemo(seed);
    if (!cur) return;
    let groups = seed.map((g) => [...g]);
    for (let improved = true; improved; ) {
      improved = false;
      const neighbours: number[][][] = [];
      // Move one unit to another crew (or a new crew).
      for (let g = 0; g < groups.length; g++) {
        for (const u of groups[g]) {
          for (let h = 0; h <= groups.length; h++) {
            if (h === g || (h === groups.length && groups.length >= K)) continue;
            if (h === groups.length && groups[g].length === 1) continue;
            const next = groups.map((x) => x.filter((y) => y !== u));
            if (h === groups.length) next.push([u]);
            else next[h] = [...next[h], u];
            neighbours.push(next);
          }
        }
      }
      // Swap two units between crews.
      for (let g = 0; g < groups.length; g++) {
        for (let h = g + 1; h < groups.length; h++) {
          for (const u of groups[g]) {
            for (const v of groups[h]) {
              const next = groups.map((x) => [...x]);
              next[g] = next[g].map((y) => (y === u ? v : y));
              next[h] = next[h].map((y) => (y === v ? u : y));
              neighbours.push(next);
            }
          }
        }
      }
      // Merge two crews.
      for (let g = 0; g < groups.length; g++) {
        for (let h = g + 1; h < groups.length; h++) {
          const next = groups.filter((_, x) => x !== h).map((x) => [...x]);
          next[g] = [...groups[g], ...groups[h]];
          neighbours.push(next);
        }
      }
      for (const nb of neighbours) {
        const c = evalMemo(nb);
        if (!c) return;
        if (compareScores(c.ev.score, cur.ev.score) < 0) {
          cur = c;
          groups = nb.filter((x) => x.length > 0).map((x) => [...x].sort((a, b) => a - b));
          groups.sort((a, b) => a[0] - b[0]);
          improved = true;
          break;
        }
      }
    }
  }
}

/** Person swaps between crews and with the spare pool, kept only when the score improves. */
function repair(ctx: Ctx, c: Candidate): Candidate {
  const budget = ctx.input.settings.repairBudget;
  let tries = 0;
  let best = c;
  const locked = (ci: number, id: string) => best.reqs[ci].lockedPeople.includes(id);
  const tryMembers = (members: string[][], needsOnly: boolean): boolean => {
    if (tries >= budget) return false;
    tries++;
    ctx.repairs++;
    const ev = evaluate(ctx, best.reqs, members.map((m) => [...m].sort()));
    const better = needsOnly
      ? compareScores(needsPrefix(ctx, ev.score), needsPrefix(ctx, best.ev.score)) < 0
      : compareScores(ev.score, best.ev.score) < 0;
    if (better) best = { ...best, members: members.map((m) => [...m].sort()), ev };
    return better;
  };
  for (let improved = true; improved && tries < budget; ) {
    improved = false;
    const mem = best.members;
    const spare = best.ev.spare;
    outer: {
      for (let a = 0; a < mem.length; a++) {
        for (let b = a + 1; b < mem.length; b++) {
          for (const x of mem[a]) {
            if (locked(a, x)) continue;
            for (const y of mem[b]) {
              if (locked(b, y)) continue;
              const next = mem.map((m) => [...m]);
              next[a] = next[a].map((z) => (z === x ? y : z));
              next[b] = next[b].map((z) => (z === y ? x : z));
              if (tryMembers(next, false)) {
                improved = true;
                break outer;
              }
            }
          }
        }
      }
      for (let a = 0; a < mem.length; a++) {
        for (const x of mem[a]) {
          if (locked(a, x)) continue;
          for (const y of spare) {
            const next = mem.map((m) => [...m]);
            next[a] = next[a].map((z) => (z === x ? y : z));
            if (tryMembers(next, false)) {
              improved = true;
              break outer;
            }
          }
        }
      }
      // Adding a spare person (or moving one across) only counts when it fills a need.
      for (let a = 0; a < mem.length; a++) {
        for (const y of spare) {
          const next = mem.map((m) => [...m]);
          next[a] = [...next[a], y];
          if (tryMembers(next, true)) {
            improved = true;
            break outer;
          }
        }
        for (let b = 0; b < mem.length; b++) {
          if (b === a) continue;
          for (const x of mem[b]) {
            if (locked(b, x)) continue;
            const next = mem.map((m) => [...m]);
            next[b] = next[b].filter((z) => z !== x);
            next[a] = [...next[a], x];
            if (tryMembers(next, true)) {
              improved = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return best;
}

export function search(ctx: Ctx): { best: Candidate; exact: boolean } {
  const s = ctx.input.settings;
  const top = new TopList(s.repairTop);
  let complete = false;
  if (ctx.units.length <= s.exactMaxGroups) complete = exact(ctx, top, s.evaluationBudget);
  else local(ctx, top, s.evaluationBudget);
  let best: Candidate | null = null;
  for (const c of top.items) {
    const r = repair(ctx, c);
    if (!best || compareScores(r.ev.score, best.ev.score) < 0) best = r;
  }
  return { best: best!, exact: complete };
}
