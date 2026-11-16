/**
 * planDay: the whole-day plan for one date — crews, rigs, drivers, stop
 * order, suggested start times, and a flag for every gap.
 *
 * Priority order (strict, the owner's): the skills each job needs are on
 * site; legal drivers bring the right equipment; enough people; then
 * least driving. See engine.ts for the score tiers and search.ts for
 * how the day is split into crews.
 */
import { DEFAULT_SKILLS } from "../skills";
import { buildCtx, canDriveTruck, roleFilled, type CrewEval, type Ctx } from "./engine";
import { search } from "./search";
import { formatHHMM } from "./settings";
import type { DayPlan, Decision, PlanCrew, PlanFlag, PlannerInput } from "./types";
import { validatePlan } from "./validate";

const SKILL_LABEL = new Map(DEFAULT_SKILLS.map((s) => [s.id, s.label]));
export const skillLabel = (id: string) =>
  id === "climbing" ? "a climber" : id === "ground_work" ? "a groundsman" : (SKILL_LABEL.get(id) ?? id);

function emptyPlan(
  input: PlannerInput,
  flags: PlanFlag[],
  spareReason: string | null,
  notPlaced: DayPlan["notPlaced"] = [],
): DayPlan {
  return {
    date: input.date,
    mode: input.mode,
    crews: [],
    notPlaced,
    spare: spareReason ? input.people.map((p) => ({ crewId: p.id, reason: spareReason })) : [],
    off: spareReason
      ? input.off
      : [...input.off, ...input.people.map((p) => ({ crewId: p.id, name: p.name, reason: "Business closed" }))],
    flags,
    decisions: [],
    score: [],
    stats: { evaluations: 0, exact: true, repairs: 0, budget: input.settings.evaluationBudget },
  };
}

export function planDay(input: PlannerInput): DayPlan {
  if (input.closed) {
    const flags: PlanFlag[] = [{ severity: "info", code: "CLOSED_DAY", text: `The business is closed on ${input.date}.` }];
    const notPlaced = input.jobs.map((j) => ({ jobId: j.id, reason: "The business is closed on this day" }));
    for (const j of input.jobs) {
      flags.push({
        severity: "red",
        code: "CLOSED_DAY",
        jobId: j.id,
        text: `${j.title}: scheduled on a day the business is closed — not planned.`,
      });
    }
    const plan = emptyPlan(input, flags, null, notPlaced);
    for (const problem of validatePlan(input, plan)) {
      flags.push({ severity: "red", code: "PLAN_CHECK_FAILED", text: `Planner self-check: ${problem}. Please report this.` });
    }
    return plan;
  }
  if (input.jobs.length === 0) {
    return emptyPlan(input, [], "No jobs on this day");
  }
  const ctx = buildCtx(input);
  const { best, exact } = search(ctx);
  const ev = best.ev;
  const name = (id: string) => ctx.people[ctx.pIdx.get(id) ?? -1]?.name ?? id;
  const eqName = (id: string) => ctx.eqById.get(id)?.name ?? id;
  const flags: PlanFlag[] = [...input.inputFlags, ...ctx.lockFlags];
  const decisions: Decision[] = [];

  const crews: PlanCrew[] = ev.crews.map((c, i) => {
    const key = `crew-${i + 1}`;
    const drivers: Record<string, string> = {};
    for (const r of c.rig.rigs) drivers[r.truckId] = r.driverId;
    return {
      key,
      name: `Crew ${i + 1}`,
      memberIds: [...c.members],
      rigs: c.rig.rigs.map((r) => ({ truckId: r.truckId, haulId: r.haulId, carriedIds: [...r.carriedIds] })),
      looseIds: [...c.rig.loose],
      drivers,
      stops: c.route.order.map((ji, k) => ({
        jobId: ctx.jobs[ji].id,
        startMin: c.route.start[k],
        endMin: c.route.end[k],
        driveInMin: c.route.driveIn[k],
      })),
      driveMin: c.route.driveMin,
      idleMin: c.route.idleMin,
    };
  });

  const notPlaced: DayPlan["notPlaced"] = [];
  const maxCrewSize = Math.max(0, ...ev.crews.map((c) => c.members.length));
  ev.crews.forEach((c, i) => {
    const crew = crews[i];
    crewFlags(ctx, c, crew, flags, notPlaced, maxCrewSize, ev.crews.length, name);
    crewDecisions(ctx, c, crew, decisions, name, eqName);
  });

  const spare: DayPlan["spare"] = ev.spare.map((id) => {
    const p = ctx.people[ctx.pIdx.get(id)!];
    const reason = p.lastResort
      ? "Last resort — not needed: every need that they could fill was filled without them"
      : !p.usualDay
        ? "Not a usual workday, and not needed"
        : "Not needed today: every crew is at its minimum or its expected-crew cap";
    flags.push({ severity: "info", code: "NOT_NEEDED_TODAY", personId: id, text: `${p.name}: ${reason.toLowerCase()}.` });
    decisions.push({ subject: id, placedOn: "spare", because: [reason] });
    return { crewId: id, reason };
  });
  for (const o of input.off) decisions.push({ subject: o.crewId, placedOn: "off", because: [o.reason] });

  const plan: DayPlan = {
    date: input.date,
    mode: input.mode,
    crews,
    notPlaced,
    spare,
    off: input.off,
    flags,
    decisions,
    score: ev.score,
    stats: {
      evaluations: ctx.evaluations,
      exact,
      repairs: ctx.repairs,
      budget: input.settings.evaluationBudget,
    },
  };
  for (const problem of validatePlan(input, plan)) {
    flags.push({ severity: "red", code: "PLAN_CHECK_FAILED", text: `Planner self-check: ${problem}. Please report this.` });
  }
  return plan;
}

function crewFlags(
  ctx: Ctx,
  c: CrewEval,
  crew: PlanCrew,
  flags: PlanFlag[],
  notPlaced: DayPlan["notPlaced"],
  maxCrewSize: number,
  nCrews: number,
  name: (id: string) => string,
) {
  const s = ctx.input.settings;
  const key = crew.key;
  for (const ji of c.route.dropped) {
    const job = ctx.jobs[ji];
    const reason = `Does not fit in ${crew.name}'s day: it would run past ${formatHHMM(s.dayEndMin + s.overrunToleranceMin)}`;
    notPlaced.push({ jobId: job.id, reason });
    flags.push({ severity: "red", code: "DOES_NOT_FIT_DAY", jobId: job.id, crewKey: key, text: `${job.title}: not placed — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.` });
  }
  for (const [ji, r] of [...c.jobs.entries()].sort((a, b) => a[0] - b[0])) {
    const job = ctx.jobs[ji];
    for (const sk of r.missingSkills) {
      flags.push({
        severity: "red",
        code: "UNFILLED_SKILL",
        jobId: job.id,
        crewKey: key,
        text: `${job.title}: needs ${skillLabel(sk)} — nobody free on ${crew.name} has it.`,
      });
    }
    for (const m of r.missingKinds) {
      flags.push({
        severity: "red",
        code: m.reason,
        jobId: job.id,
        crewKey: key,
        text: `${job.title}: needs a ${m.kind.toLowerCase()} — ${m.text}.`,
      });
    }
    if (r.short > 0 && c.members.length === 0) {
      flags.push({
        severity: "red",
        code: "SHORT_HANDED",
        jobId: job.id,
        crewKey: key,
        text: `${job.title}: nobody is free to go out with ${crew.name}.`,
      });
    } else if (r.short > 0) {
      flags.push({
        severity: "red",
        code: "SHORT_HANDED",
        jobId: job.id,
        crewKey: key,
        text: `${job.title}: needs ${job.climbers} climber${job.climbers === 1 ? "" : "s"} + ${job.groundsmen} grounds${job.groundsmen === 1 ? "man" : "men"}; ${crew.name} has ${r.climbFilled} + ${r.groundFilled} (short ${r.short}).`,
      });
      const need = job.climbers + job.groundsmen;
      if (nCrews > 1 && need > maxCrewSize && ctx.people.length >= need) {
        flags.push({
          severity: "amber",
          code: "NEEDS_SECOND_CREW",
          jobId: job.id,
          crewKey: key,
          text: `${job.title}: needs ${need} people, more than any one crew today has — two crews meeting up on one job comes in a later stage.`,
        });
      }
    }
    if (job.cap != null && job.cap < job.climbers + job.groundsmen) {
      flags.push({
        severity: "amber",
        code: "CAPPED_BY_EXPECTED_CREW",
        jobId: job.id,
        crewKey: key,
        text: `${job.title}: the crew rules ask for ${job.climbers + job.groundsmen} people but the estimator expected ${job.cap}.`,
      });
    }
  }
  for (const late of c.route.late) {
    const job = ctx.jobs[late.job];
    flags.push({
      severity: "amber",
      code: "LATE_FOR_FIXED_TIME",
      jobId: job.id,
      crewKey: key,
      text: `${job.title}: ${crew.name} can get there ${late.min} min after its set start of ${formatHHMM(job.fixedStartMin ?? 0)}.`,
    });
  }
  if (c.route.overrunMin > 0) {
    const tooLate = c.route.overrunMin > s.overrunToleranceMin;
    flags.push({
      severity: tooLate ? "red" : "amber",
      code: "DAY_OVERRUN",
      crewKey: key,
      text: tooLate
        ? `${crew.name} cannot finish its jobs today: it runs ${c.route.overrunMin} min past ${formatHHMM(s.dayEndMin)}, and the jobs already assigned by hand cannot be moved. Move a job to another day.`
        : `${crew.name} finishes ${c.route.overrunMin} min after ${formatHHMM(s.dayEndMin)}.`,
    });
  }
  for (const leg of c.route.legs) {
    if (leg.from < 0 || leg.to < 0 || leg.min <= s.clusterMaxMinutes) continue;
    const a = ctx.jobs[leg.from];
    const b = ctx.jobs[leg.to];
    flags.push({
      severity: "amber",
      code: "OVER_CLUSTER_CAP",
      jobId: b.id,
      crewKey: key,
      text: leg.overridden
        ? `${crew.name}: ${a.title} → ${b.title} is ${leg.min} min (cap ${s.clusterMaxMinutes}), kept together because they share people or equipment set by hand.`
        : `${crew.name}: ${a.title} → ${b.title} is ${leg.min} min, over the ${s.clusterMaxMinutes}-min cluster cap.`,
    });
  }
  for (const r of c.rig.rigs) {
    if (!r.extra) continue;
    const p = ctx.people[ctx.pIdx.get(r.driverId)!];
    const t = ctx.eqById.get(r.truckId)!;
    const h = ctx.eqById.get(r.haulId)!;
    const limited = [t, h].find((e) => e.weeklyDriverLimit != null && (p.vehicleUses[e.id] ?? 0) + 1 > e.weeklyDriverLimit)!;
    flags.push({
      severity: "amber",
      code: "VEHICLE_EXTRA_DRIVE",
      crewKey: key,
      personId: p.id,
      equipmentId: limited.id,
      text: `${p.name} drives ${limited.name} again this week (limit ${limited.weeklyDriverLimit}) — nobody else could take it.`,
    });
  }
  if (c.rig.rigs.length > 0 && c.members.length > c.rig.seatCap) {
    flags.push({
      severity: "red",
      code: "SEATS_SHORT",
      crewKey: key,
      text: `${crew.name}: ${c.members.length} people are set on its jobs by hand but its trucks seat ${c.rig.seatCap}.`,
    });
  }
  for (const [truckId, pid] of Object.entries(c.req.lockedDrivers).sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = c.rig.rigs.find((x) => x.truckId === truckId);
    if (!r || r.driverId === pid || !c.members.includes(pid)) continue;
    const p = ctx.people[ctx.pIdx.get(pid)!];
    const t = ctx.eqById.get(truckId)!;
    const h = ctx.eqById.get(r.haulId)!;
    const carried = r.carriedIds.reduce((n, id) => n + (ctx.eqById.get(id)?.weightLbs ?? 0), 0);
    const legal = canDriveTruck(p, t, h, s.cdlAWeightLbs, carried).ok;
    flags.push({
      severity: "red",
      code: "LOCK_CONFLICT",
      crewKey: key,
      personId: pid,
      equipmentId: truckId,
      text: legal
        ? `${p.name} is set to drive ${t.name} but is needed to drive another truck on ${crew.name} — ${name(r.driverId)} drives ${t.name}.`
        : `${p.name} is set to drive ${t.name} but may not legally pull ${h.name} with it — ${name(r.driverId)} drives instead.`,
    });
  }
  for (const id of c.rig.strandedLocked) {
    flags.push({
      severity: "red",
      code: "LOCK_CONFLICT",
      crewKey: key,
      equipmentId: id,
      text: `${ctx.eqById.get(id)?.name ?? "A truck"} is set on a job but has no free trailer or chipper to tow or no legal driver on ${crew.name} — left at the yard.`,
    });
  }
  for (const id of c.members) {
    const p = ctx.people[ctx.pIdx.get(id)!];
    if (p.lastResort) {
      flags.push({
        severity: "amber",
        code: "LAST_RESORT_USED",
        crewKey: key,
        personId: id,
        text: `${p.name} (last resort) is on ${crew.name} because ${lastResortNeed(ctx, c, id)} would otherwise go unfilled.`,
      });
    }
    if (!p.usualDay) {
      flags.push({
        severity: "amber",
        code: "OFF_USUAL_DAY",
        crewKey: key,
        personId: id,
        text: `${p.name} does not usually work this weekday.`,
      });
    }
  }
  if (c.route.order.length > 0) {
    const finish = c.route.end[c.route.end.length - 1];
    if (finish <= s.dayEndMin - 60) {
      flags.push({ severity: "info", code: "CREW_FREE_AFTER", crewKey: key, text: `${crew.name} is done by ${formatHHMM(finish)}.` });
    }
  }
}

/** What a last-resort person covers on their crew: the needs that open up without them. */
function lastResortNeed(ctx: Ctx, c: CrewEval, id: string): string {
  const others = c.members.filter((m) => m !== id);
  const p = ctx.people[ctx.pIdx.get(id)!];
  const parts: string[] = [];
  const othersHave = new Set<string>();
  others.forEach((o) => ctx.people[ctx.pIdx.get(o)!].skills.forEach((s) => othersHave.add(s)));
  for (const ji of c.jobs.keys()) {
    const job = ctx.jobs[ji];
    const wants = [...job.skills, ...(job.climbers > 0 ? ["climbing"] : []), ...(job.groundsmen > 0 ? ["ground_work"] : [])];
    for (const s of wants) if (p.skills.includes(s) && !othersHave.has(s)) parts.push(`${skillLabel(s)} for ${job.title}`);
    const withHim = roleFilled(ctx, c.members, job.climbers, job.groundsmen);
    const without = roleFilled(ctx, others, job.climbers, job.groundsmen);
    if (withHim.climbFilled + withHim.groundFilled > without.climbFilled + without.groundFilled && !parts.some((x) => x.endsWith(job.title))) {
      parts.push(`a crew place on ${job.title}`);
    }
  }
  const drives = c.rig.rigs.find((r) => r.driverId === id);
  if (drives) {
    // A driving need only counts when no other member who is not driving could take this rig.
    const t = ctx.eqById.get(drives.truckId)!;
    const h = ctx.eqById.get(drives.haulId)!;
    const carried = drives.carriedIds.reduce((n, x) => n + (ctx.eqById.get(x)?.weightLbs ?? 0), 0);
    const otherDrivers = new Set(c.rig.rigs.filter((r) => r !== drives).map((r) => r.driverId));
    const someoneElse = others.some(
      (o) => !otherDrivers.has(o) && canDriveTruck(ctx.people[ctx.pIdx.get(o)!], t, h, ctx.input.settings.cdlAWeightLbs, carried).ok,
    );
    if (!someoneElse) parts.push(`a driver for ${t.name}`);
  }
  return parts.length > 0 ? [...new Set(parts)].join(", ") : "a crew place";
}

function crewDecisions(
  ctx: Ctx,
  c: CrewEval,
  crew: PlanCrew,
  decisions: Decision[],
  name: (id: string) => string,
  eqName: (id: string) => string,
) {
  const titles = (pred: (ji: number) => boolean) =>
    c.req.jobs.filter(pred).map((ji) => ctx.jobs[ji].title);
  for (const id of c.members) {
    const p = ctx.people[ctx.pIdx.get(id)!];
    const because: string[] = [];
    if (c.req.lockedPeople.includes(id)) because.push("Assigned by hand (kept)");
    const drives = c.rig.rigs.find((r) => r.driverId === id);
    if (drives) because.push(`Drives ${eqName(drives.truckId)} towing ${eqName(drives.haulId)}`);
    for (const s of p.skills) {
      const jobs = titles((ji) => {
        const j = ctx.jobs[ji];
        return j.skills.includes(s) || (s === "climbing" && j.climbers > 0) || (s === "ground_work" && j.groundsmen > 0);
      });
      if (jobs.length > 0) because.push(`Has ${skillLabel(s)} needed for ${jobs.join(", ")}`);
    }
    if (p.lastResort) because.push("Last resort: needed because nobody else was free for it");
    if (because.length === 0) because.push(c.members.length <= c.req.minHead ? "Fills the crew rules' headcount" : "Extra hand, within the expected crew");
    if (!p.usualDay) because.push("Note: not a usual workday");
    decisions.push({ subject: id, placedOn: crew.key, because });
  }
  for (const r of c.rig.rigs) {
    const haulKind = ctx.eqById.get(r.haulId)?.kind;
    const jobs = titles((ji) => ctx.jobs[ji].kinds.includes(haulKind!) || r.carriedIds.some((x) => ctx.jobs[ji].kinds.includes(ctx.eqById.get(x)!.kind)));
    const because = [
      `${eqName(r.truckId)} tows ${eqName(r.haulId)}${r.carriedIds.length > 0 ? ` carrying ${r.carriedIds.map(eqName).join(", ")}` : ""}`,
      jobs.length > 0 ? `Needed for ${jobs.join(", ")}` : "Assigned by hand (kept)",
      `Driver: ${name(r.driverId)}`,
    ];
    decisions.push({ subject: r.truckId, placedOn: crew.key, because });
  }
}
