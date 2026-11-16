import { useEffect, useMemo, useRef, useState } from "react";
import { planTimeNote } from "../fieldDay";
import { useStore } from "../store";
import { jobAddress } from "../scheduling";
import { resolveJobCoords, type LatLng } from "../routing";
import { loadDriveTimes, plannerYard, type DriveTimes } from "../planner";
import {
  autoFill,
  coverageProblems,
  driverProblems,
  hoursFor,
  simulate,
  type AutoFill,
  type MeetInput,
  type Routes,
} from "../planner/meetup";
import {
  applyPatches,
  boardJobs,
  autoFillInput,
  isFieldCrew,
  boardMeetInput,
  boardPatchJob,
  boardSnapshot,
  buildDayPatches,
  draftByJob,
  equipmentGroups,
  fillEquipment,
  placeEquipment,
  replanFromNow,
  savedEquipment,
  savedRoutes,
  time12,
  todayChanges,
  unplaceEquipment,
  weekdayShort,
  type EquipDraft,
  type Replan,
} from "../planner/board";
import { isTruck, usable } from "../driverSuggest";
import { isOwnerLike } from "../permissions";
import { money, todayStr } from "../utils";
import type { AppState, Equipment, Job } from "../types";
import PlanInsights from "./PlanInsights";
import { blockedReason, handAddedNote } from "../crewSuggest";
import { showFlash } from "../flash";
import { dayPlanEmailCount, dayPlanEmailMessage, emailCrewOnSave, emailDayPlan } from "../dayPlanEmail";
import { useDoubleConfirm } from "../useDoubleConfirm";
import { needsDoubleConfirm } from "../doubleConfirm";
import {
  fillEmail,
  fillPreview,
  fillSkippedDays,
  fillUndoSnapshot,
  getFillUndo,
  planFillDay,
  planUndo,
  checkFillApply,
  setFillUndo,
  undoMinutesLeft,
  undoSnapshot,
  useFillUndo,
  type FillDay,
  type FillEmail,
  type FillPreview,
} from "../planner/fillPreview";

const hrs = (h: number) => (Number.isFinite(h) ? `${Math.round(h * 10) / 10} h` : "—");
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
/** Same equipment on every job (order of keys and drivers does not matter). */
const eqKey = (jobs: Job[], d: EquipDraft) =>
  JSON.stringify(
    jobs.map((j) => [
      d[j.id]?.equipmentIds ?? [],
      Object.entries(d[j.id]?.drivers ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
    ]),
  );

/** Positions and road drive times for one day's jobs (cached; straight-line when the service doesn't answer). */
async function dayInput(state: AppState, date: string, shop: LatLng | null) {
  const jobs = boardJobs(state, date);
  const pairs = await Promise.all(
    jobs.map(async (j) => [j.id, await resolveJobCoords(j, jobAddress(state, j)).catch(() => null)] as const),
  );
  const coords = Object.fromEntries(pairs);
  const pts = [shop, ...Object.values(coords)].filter((p): p is LatLng => p != null);
  const t = await loadDriveTimes(pts);
  return { jobs, ...boardMeetInput(state, date, coords, t.minutes) };
}

/**
 * The day plan board (staff): the day's jobs on the left, the crew on
 * the right. Drag people onto jobs (or tap a person, then a job); drag
 * a person from one job to another to move them; ✕ takes them off.
 * ✨ Auto-fill splits the crew up, has them meet at the big job and
 * picks trucks for each team leaving the shop. Drag a truck or other
 * equipment onto a person on a job to change who drives what. Today:
 * "Re-plan the rest of today" starts from now. "Fill this week" fills
 * every unplanned day. Times follow the $400-an-hour rule. Nothing
 * saves until "Save day".
 */
export type BoardDraft = {
  date: string;
  jobs: Record<string, { crewIds: string[]; startTime: string | null }>;
} | null;

export default function PlanBoard({
  date,
  onDraft,
}: {
  date: string;
  /** Told about the unsaved plan (null when it matches what's saved). */
  onDraft?: (draft: BoardDraft) => void;
}) {
  const { state, saveDayBoard, savePlannerSettings, role } = useStore();
  // The newest state, for Apply after the email dialog (a teammate may
  // have saved meanwhile).
  const latestState = useRef(state);
  useEffect(() => {
    latestState.current = state;
  });
  const [emailNote, setEmailNote] = useState<string | null>(null);
  // Owner's rule: more than 3 emails at once need two "are you sure" steps.
  const { confirmEmails, dialog: confirmDialog } = useDoubleConfirm();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{
    date: string;
    routes: Routes;
    equipment: EquipDraft;
    replan: Replan | null;
  } | null>(null);
  const [suggested, setSuggested] = useState<{ date: string; fill: AutoFill } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedEq, setPickedEq] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [weekBusy, setWeekBusy] = useState(false);
  // The Fill preview (nothing saved until Apply) and its notes.
  const [fill, setFill] = useState<{ base: AppState; days: FillDay[]; preview: FillPreview } | null>(null);
  const [applying, setApplying] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const undo = useFillUndo();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!undo) return;
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, [undo]);

  const dayJobs = useMemo(() => (state ? boardJobs(state, date) : []), [state, date]);
  // Map positions for jobs with an address but no pin.
  const coordsKey = dayJobs.map((j) => `${j.id}:${j.lat}:${j.lng}`).join("|");
  const [coords, setCoords] = useState<{ key: string; map: Record<string, LatLng | null> } | null>(null);
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void Promise.all(
      dayJobs.map(async (j) => [j.id, await resolveJobCoords(j, jobAddress(state, j)).catch(() => null)] as const),
    ).then((pairs) => {
      if (!cancelled) setCoords({ key: coordsKey, map: Object.fromEntries(pairs) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordsKey]);
  const ready = coords?.key === coordsKey;
  // Road drive times from the shop and between jobs (cached on this device).
  const yard = useMemo(() => (state ? plannerYard(state) : null), [state]);
  const shop = yard?.at ?? null;
  const timesKey = `${coordsKey}|${shop ? `${shop.lat},${shop.lng}` : "no-shop"}`;
  const [times, setTimes] = useState<{ key: string; t: DriveTimes } | null>(null);
  useEffect(() => {
    if (!ready || !coords) return;
    let cancelled = false;
    const pts = [shop, ...Object.values(coords.map)].filter((p): p is LatLng => p != null);
    void loadDriveTimes(pts).then((t) => {
      if (!cancelled) setTimes({ key: timesKey, t });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, timesKey]);
  const timesReady = times?.key === timesKey;

  const input = useMemo(() => {
    if (!state || !ready || !timesReady) return null;
    return boardMeetInput(state, date, coords?.map ?? {}, times?.t.minutes);
  }, [state, date, ready, coords, timesReady, times]);

  const saved0 = useMemo(() => (state ? savedRoutes(state, dayJobs) : {}), [state, dayJobs]);
  const savedEq0 = useMemo(() => savedEquipment(dayJobs), [dayJobs]);
  const mine = draft?.date === date ? draft : null;
  const routes = mine?.routes ?? saved0;
  const equipment = mine?.equipment ?? savedEq0;
  const replan = mine?.replan ?? null;
  const dirty =
    mine != null &&
    (replan != null ||
      JSON.stringify(mine.routes) !== JSON.stringify(saved0) ||
      eqKey(dayJobs, mine.equipment) !== eqKey(dayJobs, savedEq0));
  // Re-planning from now: people clocked in stay on their job, unless they were dragged off it.
  const meetNow: MeetInput | null = useMemo(() => {
    if (!input) return null;
    if (!replan) return input.meet;
    const startAt = Object.fromEntries(
      Object.entries(replan.meet.startAt ?? {}).filter(([pid, at]) => at.jobId && routes[pid]?.includes(at.jobId)),
    );
    return { ...replan.meet, startAt };
  }, [input, replan, routes]);
  const sim = useMemo(() => (meetNow ? simulate(meetNow, routes) : null), [meetNow, routes]);
  // Keep the Schedule's pinned route panel in step with the board.
  useEffect(() => {
    if (!onDraft) return;
    onDraft(dirty && sim ? { date, jobs: draftByJob(dayJobs, routes, sim) } : null);
  }, [onDraft, dirty, sim, routes, dayJobs, date]);
  useEffect(() => () => onDraft?.(null), [onDraft]);

  if (!state) return null;
  if (!input || !sim || !meetNow) {
    return (
      <p className="mt-3 text-sm text-slate-500">
        Setting up the day… ({!ready ? "looking up addresses" : "getting road drive times"})
      </p>
    );
  }
  const { p } = input;
  const meet = meetNow;
  if (dayJobs.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No jobs on this day yet.</p>;
  }

  const isToday = date === todayStr();
  const crewById = new Map(state.crew.map((c) => [c.id, c]));
  const eqById = new Map(state.equipment.map((e) => [e.id, e]));
  const name = (id: string) => crewById.get(id)?.name ?? "(someone)";
  const jobTitle = (id: string) => dayJobs.find((j) => j.id === id)?.title ?? "(job)";
  const setRoutes = (fn: (r: Routes) => Routes) => {
    setDraft({ date, routes: fn(JSON.parse(JSON.stringify(routes)) as Routes), equipment, replan });
    setSaved(null);
  };
  const setEquipment = (next: EquipDraft) => {
    setDraft({ date, routes, equipment: next, replan });
    setSaved(null);
  };
  const addTo = (pid: string, jobId: string, from: string | null) => {
    // Time off and "marked unavailable" can't be put on a job (business rule). Usually off that weekday is soft: they can be added by hand.
    const why = blockedReason(state, pid, date);
    if (why) {
      const name = state.crew.find((c) => c.id === pid)?.name ?? "That person";
      showFlash(`${name} can't be put on a job today: ${why}.`, { tone: "warn" });
      return;
    }
    setRoutes((r) => {
      const route = r[pid] ?? [];
      if (from && from !== jobId) {
        const i = route.indexOf(from);
        if (route.includes(jobId)) route.splice(i, 1);
        else route.splice(i, 1, jobId);
      } else if (!route.includes(jobId)) route.push(jobId);
      r[pid] = route;
      if (r[pid].length === 0) delete r[pid];
      return r;
    });
  };
  const removeFrom = (pid: string, jobId: string) =>
    setRoutes((r) => {
      r[pid] = (r[pid] ?? []).filter((x) => x !== jobId);
      if (r[pid].length === 0) delete r[pid];
      return r;
    });
  const putEquipment = (eqId: string, jobId: string, pid: string) => {
    setEquipment(placeEquipment(state.equipment, equipment, jobId, pid, eqId));
    setPickedEq(null);
  };

  const runAutoFill = () => {
    // Usually-off people placed by hand keep their place.
    const fill = autoFill(autoFillInput(state, meet, routes));
    if (!fill) return;
    setSuggested({ date, fill });
    const eq = fillEquipment(state, date, dayJobs, meet, fill.routes, fill.sim, equipment, replan?.pinned ?? {});
    setDraft({ date, routes: fill.routes, equipment: eq, replan });
    setSaved(null);
  };

  const runReplan = () => {
    const r = replanFromNow(state, date, input.meet, nowMinutes());
    const fill = autoFill(autoFillInput(state, r.meet, routes));
    if (!fill) return;
    setSuggested({ date, fill });
    const eq = fillEquipment(state, date, dayJobs, r.meet, fill.routes, fill.sim, savedEq0, r.pinned);
    setDraft({ date, routes: fill.routes, equipment: eq, replan: r });
    setSaved(null);
  };

  const save = async () => {
    if (saving) return;
    const patches = buildDayPatches(
      date,
      dayJobs,
      meet,
      routes,
      sim,
      equipment,
      replan ? { keepArrivals: replan.keepArrivals, keepStart: new Set(replan.inProgress) } : {},
    );
    const snapshot = boardSnapshot(
      meet,
      suggested?.date === date ? suggested.fill.routes : null,
      routes,
      replan ? { replanFrom: replan.nowMin } : {},
    );
    setEmailNote(null);
    // Owner's setting "Email everyone their day". Work out how many people
    // that is BEFORE saving: more than 3 needs the double confirm. If it
    // is declined, the day is still saved, with no emails.
    let emailCount = 0;
    let sendEmails = emailCrewOnSave(state.settings.planner);
    if (sendEmails) {
      emailCount = dayPlanEmailCount(date, applyPatches(state, patches).jobs, state.crew);
      if (needsDoubleConfirm(emailCount)) {
        setSaving(true);
        try {
          sendEmails = await confirmEmails(
            emailCount,
            "Everyone on this day's jobs gets an email with their day. The day is saved either way.",
          );
        } finally {
          setSaving(false);
        }
      }
    }
    // Once this save reaches the database, email everyone on the day their
    // plan (only when something changed).
    const savedDate = date;
    const confirmed = emailCount;
    const n = saveDayBoard(
      date,
      patches,
      snapshot,
      sendEmails
        ? (ok) => {
            if (!ok) return;
            void emailDayPlan(savedDate, confirmed).then((r) => setEmailNote(dayPlanEmailMessage(r)));
          }
        : undefined,
    );
    if (emailCrewOnSave(state.settings.planner) && !sendEmails) {
      setEmailNote(`Day saved. No emails were sent (you chose not to email ${emailCount} people).`);
    }
    setDraft(null);
    setSaved(n === 0 ? "Saved: nothing changed." : `Saved: ${n} job${n === 1 ? "" : "s"} updated. The crew see it now.`);
  };

  // ✨ Fill the next 6 days: plan in memory, show the preview, save only on Apply.
  const fillWeek = async () => {
    const today = todayStr();
    let working: AppState = state;
    const { plan: days, skipped } = fillSkippedDays(state, date, { today, boardDirty: dirty });
    if (days.length === 0) {
      setSaved("Every day in the next 6 working days with jobs is already planned.");
      return;
    }
    setWeekBusy(true);
    setSaved(null);
    setFillNote(null);
    try {
      const plans: FillDay[] = [];
      for (const d of days) {
        const di = await dayInput(working, d, shop);
        const plan = planFillDay(working, d, di.jobs, di.meet);
        if ("skip" in plan) {
          skipped.push({ day: d, why: plan.skip });
          continue;
        }
        plans.push(plan);
        working = applyPatches(working, plan.patches);
      }
      skipped.sort((a, b) => a.day.localeCompare(b.day));
      if (plans.length === 0) {
        setSaved(`Nothing to fill: ${skipped.map((x) => `${weekdayShort(x.day)} ${x.why}`).join("; ")}.`);
        return;
      }
      setFill({ base: state, days: plans, preview: fillPreview(state, plans, skipped) });
    } finally {
      setWeekBusy(false);
    }
  };

  const applyWeek = async () => {
    if (!fill || applying) return;
    setApplying(true);
    let check: Awaited<ReturnType<typeof checkFillApply>>;
    try {
      check = await checkFillApply(fill.base, fill.days, () => latestState.current, (total) =>
        confirmEmails(
          total,
          "Everyone on the filled days gets an email with their day. The days are saved either way.",
        ),
      );
    } finally {
      setApplying(false);
    }
    if (!check.ok) {
      setFill(null);
      setFillNote("A job in the preview changed meanwhile, so nothing was saved. Press Fill the next 6 days again.");
      return;
    }
    const { email, sendEmails } = check;
    // Snapshot of every job this fill touches, taken before saving (for Undo).
    const undo = fillUndoSnapshot(check.state, fill.days, Date.now(), sendEmails);
    let n = 0;
    for (const x of fill.days) {
      const count = email.perDay[x.day] ?? 0;
      n += saveDayBoard(
        x.day,
        x.patches,
        x.snapshot,
        sendEmails && count > 0
          ? (ok) => {
              if (!ok) return;
              void emailDayPlan(x.day, count).then((r) => setEmailNote(dayPlanEmailMessage(r)));
            }
          : undefined,
      );
    }
    const days = fill.days.length;
    setFill(null);
    setFillUndo(undo.jobs.length > 0 ? undo : null);
    setNow(Date.now());
    const text = `Filled ${days} day${days === 1 ? "" : "s"} (${n} job${n === 1 ? "" : "s"} updated). The crew see it now.`;
    setSaved(undo.jobs.length > 0 ? `${text} You can Undo for 10 minutes.` : text);
    if (email.on && !sendEmails && email.total > 0) {
      setEmailNote(`Days saved. No emails were sent (you chose not to email ${email.total} people).`);
    }
  };

  const undoWeek = () => {
    const u = getFillUndo();
    if (!u) return;
    const plan = planUndo(state, u, Date.now());
    setFillUndo(null);
    if (!plan) {
      setFillNote("Undo is no longer available (more than 10 minutes since Fill).");
      return;
    }
    let after: AppState = state;
    for (const [day, patches] of Object.entries(plan.byDay)) {
      after = { ...after, jobs: after.jobs.map((j) => boardPatchJob(after, j, patches[j.id], day) ?? j) };
    }
    let n = 0;
    for (const [day, patches] of Object.entries(plan.byDay)) n += saveDayBoard(day, patches, undoSnapshot(after, day));
    const parts = [`Undo: ${n} job${n === 1 ? "" : "s"} put back as they were.`];
    if (plan.skipped.length > 0)
      parts.push(`Left as they are: ${plan.skipped.map((x) => `${x.title} (${x.why})`).join("; ")}.`);
    if (plan.blocked.length > 0) parts.push(`${plan.blocked.join("; ")}.`);
    if (u.emailed) parts.push("The crew were already emailed the filled plan; Undo sends no emails, so tell them.");
    setSaved(null);
    setFillNote(parts.join(" "));
    showFlash(parts[0], { tone: plan.skipped.length > 0 ? "warn" : "ok" });
  };

  const placed = new Set(Object.keys(routes).filter((pid) => (routes[pid] ?? []).length > 0));
  // Usually off today (business rule): not auto-filled, listed in their
  // own group so they can be dragged on by hand; once on a job they show
  // with the others, with a small note.
  const usuallyOffNote = (id: string) => meet.people.find((x) => x.id === id)?.usuallyOff ?? null;
  const usuallyOffFree = meet.people.filter((x) => x.usuallyOff && !placed.has(x.id));
  const available = meet.people.filter((x) => !x.usuallyOff || placed.has(x.id));
  const notPlaced = available.filter((x) => !placed.has(x.id));
  // Office logins left off the board are normal (Auto-fill skips them).
  const fieldNotPlaced = notPlaced.filter((x) => isFieldCrew(state.crew.find((c) => c.id === x.id))).length;
  // Owner, manager and office logins (and Sales) not on a job are listed
  // in grey under "Office (not going out)", not as a red warning.
  const officeOnly = (id: string) =>
    !placed.has(id) && !isFieldCrew(state.crew.find((c) => c.id === id));
  const others = state.crew.filter(
    (c) => !available.some((a) => a.id === c.id) && (placed.has(c.id) || p.off.some((o) => o.crewId === c.id)),
  );
  const offReason = (id: string) => p.off.find((o) => o.crewId === id)?.reason ?? null;
  const coverage = coverageProblems(meet, sim);
  const noDriver = new Set(driverProblems(meet, routes));
  const finish = Math.max(...dayJobs.map((j) => sim.jobs[j.id]?.endMin ?? 0));
  const jobsSorted = [...dayJobs].sort(
    (a, b) =>
      (sim.jobs[a.id]?.startMin ?? 1e9) - (sim.jobs[b.id]?.startMin ?? 1e9) ||
      (meet.jobs.find((x) => x.id === b.id)?.work ?? 0) - (meet.jobs.find((x) => x.id === a.id)?.work ?? 0),
  );
  const changes = isToday && !dirty ? todayChanges(state, dayJobs, input.meet, p.off) : [];
  // Where each piece of equipment is on the board.
  const eqWhere = new Map<string, { jobId: string; driver: string | null }>();
  for (const j of dayJobs) {
    for (const id of equipment[j.id]?.equipmentIds ?? []) {
      if (!eqWhere.has(id)) eqWhere.set(id, { jobId: j.id, driver: equipment[j.id]?.drivers[id] ?? null });
    }
  }
  const fleet = state.equipment
    .filter((e) => e.status !== "retired")
    .sort((a, b) => Number(isTruck(b)) - Number(isTruck(a)) || a.name.localeCompare(b.name));

  const groupText = (g: { driverId: string | null; items: Equipment[] }) => {
    const [first, ...rest] = g.items;
    const who = g.driverId ? `(${name(g.driverId)})` : "(no driver)";
    const head = `${isTruck(first) ? "🛻 " : ""}${first.name} ${who}`;
    return [head, ...rest.map((e) => e.name)].join(" + ");
  };

  const personChip = (pid: string, from: string | null, extra?: string) => {
    const c = crewById.get(pid);
    const target = from != null && pickedEq != null;
    return (
      <span
        key={`${pid}:${from ?? "list"}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", JSON.stringify({ pid, from }));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={from ? (e) => e.preventDefault() : undefined}
        onDrop={
          from
            ? (e) => {
                try {
                  const d = JSON.parse(e.dataTransfer.getData("text/plain")) as { eq?: string };
                  if (d.eq) {
                    e.preventDefault();
                    e.stopPropagation();
                    setOver(null);
                    putEquipment(d.eq, from, pid);
                  }
                } catch {
                  // Not equipment: the job card handles it.
                }
              }
            : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          if (from && pickedEq) {
            putEquipment(pickedEq, from, pid);
            return;
          }
          setPicked(picked === pid ? null : pid);
        }}
        className={`inline-flex cursor-grab items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${
          picked === pid
            ? "border-emerald-700 bg-emerald-700 text-white"
            : target
              ? "border-sky-600 bg-sky-50 text-slate-800 ring-2 ring-sky-200"
              : "border-slate-300 bg-white text-slate-800"
        }`}
      >
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c?.color ?? "#999" }} />
        {name(pid)}
        {extra && <span className="font-normal opacity-80">{extra}</span>}
        {from && (
          <button
            type="button"
            aria-label={`Take ${name(pid)} off this job`}
            onClick={(e) => {
              e.stopPropagation();
              removeFrom(pid, from);
            }}
            className="ml-0.5 rounded px-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
          >
            ✕
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="mt-3 space-y-3">
      {confirmDialog}
      <PlanInsights date={date} />
      {changes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-amber-900">Today changed</p>
            <p className="text-xs text-amber-800">
              {changes.slice(0, 3).join(" · ")}
              {changes.length > 3 && ` · and ${changes.length - 3} more`}
            </p>
          </div>
          <button
            type="button"
            onClick={runReplan}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700"
          >
            ✨ Re-plan the rest of today
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
        <span className="font-semibold text-slate-900">
          {sim.unfinished.length > 0
            ? `${sim.unfinished.length} job${sim.unfinished.length === 1 ? "" : "s"} not covered`
            : `Day done about ${time12(finish)}`}{" "}
          · {sim.vehicleDriveMin} min driving
        </span>
        {fieldNotPlaced > 0 && (
          <span className="font-semibold text-red-700">· {fieldNotPlaced} available not on a job</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runAutoFill}
            className="rounded-lg border border-emerald-700 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            ✨ Auto-fill
          </button>
          {isToday && changes.length === 0 && (
            <button
              type="button"
              onClick={runReplan}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Re-plan the rest of today
            </button>
          )}
          <button
            type="button"
            onClick={() => void fillWeek()}
            disabled={weekBusy}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
          >
            {weekBusy ? "Working out the days…" : "✨ Fill the next 6 days"}
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700"
            >
              Undo changes
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
          >
            Save day
          </button>
        </div>
      </div>
      {undo && undoMinutesLeft(undo, now) > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm" role="status">
          <p className="min-w-0 flex-1 text-sky-900">
            <span className="font-semibold">Filled {undo.days.length} day{undo.days.length === 1 ? "" : "s"}</span> (
            {undo.jobs.length} job{undo.jobs.length === 1 ? "" : "s"}). Undo puts them back as they were · {undoMinutesLeft(undo, now)} min left
          </p>
          <button
            type="button"
            onClick={undoWeek}
            className="rounded-lg border border-sky-700 bg-white px-3 py-1.5 text-sm font-semibold text-sky-800 hover:bg-sky-100"
          >
            Undo
          </button>
        </div>
      )}
      {fillNote && <p className="text-sm font-semibold text-slate-800">{fillNote}</p>}
      {fill && (
        <FillPreviewPanel
          preview={fill.preview}
          email={fillEmail(state, fill.days)}
          busy={applying}
          onApply={() => void applyWeek()}
          onCancel={() => {
            setFill(null);
            setFillNote("Fill cancelled. Nothing was saved.");
          }}
        />
      )}
      {dirty && <p className="text-xs font-semibold text-amber-700">Not saved yet: the crew still see the old plan until you press Save day.</p>}
      {saved && <p className="text-sm font-semibold text-emerald-800">{saved}</p>}
      {emailNote && <p className="text-sm text-slate-700">✉️ {emailNote}</p>}
      {replan && (
        <p className="text-xs text-slate-600">
          Re-planned from {time12(replan.nowMin)}: people clocked in on a job stay there; everyone else leaves the shop now.
        </p>
      )}
      {suggested?.date === date && dirty && (
        <p className="text-xs text-slate-600">
          ✨ Auto-fill tried {suggested.fill.tried} ways to split the crew and kept the fastest day with the least driving,
          and picked a truck for each team leaving the shop. It only places field crew: owner, manager and office logins
          stay off unless you drag them on. Drag anyone or anything to change it.
        </p>
      )}
      {pickedEq && (
        <p className="text-xs font-semibold text-sky-800">
          Now tap the person on a job who takes {eqById.get(pickedEq)?.name ?? "it"}.{" "}
          <button type="button" className="underline" onClick={() => setPickedEq(null)}>
            Cancel
          </button>
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Jobs */}
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Jobs · drop people here</p>
          {jobsSorted.map((j) => {
            const mj = meet.jobs.find((x) => x.id === j.id);
            const tl = sim.jobs[j.id];
            const people = Object.keys(routes).filter((pid) => routes[pid].includes(j.id));
            // Group arrivals by time: "7:20 · Cal, Gus", "8:35 · Otto (after Elm trim)".
            const groups = new Map<number, string[]>();
            for (const pid of people) {
              const t = tl?.arrivals[pid];
              const k = t ?? -1;
              groups.set(k, [...(groups.get(k) ?? []), pid]);
            }
            const probs = coverage.filter((c) => c.jobId === j.id).map((c) => c.text);
            const late = tl?.endMin != null && tl.endMin > meet.dayEndMin;
            const customer = state.customers.find((c) => c.id === j.customerId);
            const eqGroups = equipmentGroups(state.equipment, equipment[j.id], people);
            const leavers = people.filter((pid) => routes[pid]?.[0] === j.id && !meet.startAt?.[pid]?.jobId);
            const noTruck =
              leavers.length > 0 &&
              !eqGroups.some((g) => g.driverId && leavers.includes(g.driverId) && g.items.some((e) => isTruck(e)));
            const inProgress = replan?.inProgress.includes(j.id) ?? false;
            return (
              <div
                key={j.id}
                role="button"
                tabIndex={0}
                aria-label={`Job ${j.title}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(j.id);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  try {
                    const d = JSON.parse(e.dataTransfer.getData("text/plain")) as { pid?: string; from: string | null };
                    if (d.pid) addTo(d.pid, j.id, d.from);
                  } catch {
                    // Not a person.
                  }
                }}
                onClick={() => {
                  if (picked) {
                    addTo(picked, j.id, null);
                    setPicked(null);
                  }
                }}
                className={`rounded-xl border bg-white p-3 shadow-sm ${
                  over === j.id || picked ? "border-emerald-600 ring-2 ring-emerald-200" : "border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {j.title}
                      {inProgress && <span className="ml-1.5 text-xs font-semibold text-sky-700">· in progress</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {customer ? `${customer.firstName} ${customer.lastName}`.trim() : ""} · {jobAddress(state, j)}
                    </p>
                  </div>
                  <div className="text-right text-xs text-slate-600">
                    <p className="font-semibold text-slate-900">
                      {money(Math.round(mj?.work ?? 0))} of work{inProgress ? " left" : ""}
                    </p>
                    <p>≈ {hrs(hoursFor(meet, mj?.work ?? 0, meet.fullSpeedCrew))} for {meet.fullSpeedCrew}</p>
                  </div>
                </div>
                <p className="mt-1 text-sm text-slate-800">
                  {tl?.startMin != null && tl.endMin != null
                    ? `${time12(tl.startMin)} – ${time12(tl.endMin)}`
                    : tl?.startMin != null
                      ? `${time12(tl.startMin)} – not finished today`
                      : "Nobody on it yet"}
                  {j.timePromised && (
                    <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-900">
                      🔒 {j.startTime} promised
                    </span>
                  )}
                </p>
                {planTimeNote(j.startTime, tl?.startMin) && (
                  <p className="mt-0.5 text-xs font-semibold text-amber-700">{planTimeNote(j.startTime, tl?.startMin)}</p>
                )}
                <div className="mt-1.5 space-y-1">
                  {[...groups.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([t, pids]) => {
                      const before = pids
                        .map((pid) => {
                          const r = routes[pid] ?? [];
                          const i = r.indexOf(j.id);
                          return i > 0 ? r[i - 1] : null;
                        })
                        .find((x) => x);
                      return (
                        <div key={t} className="flex flex-wrap items-center gap-1.5">
                          <span className="w-16 text-xs text-slate-500">{t >= 0 ? time12(t) : "—"}</span>
                          {pids.map((pid) => personChip(pid, j.id))}
                          {before && <span className="text-xs text-slate-500">after {jobTitle(before)}</span>}
                        </div>
                      );
                    })}
                </div>
                {people
                  .filter((pid) => usuallyOffNote(pid))
                  .map((pid) => (
                    <p key={pid} className="mt-1 text-xs text-slate-500">
                      {name(pid)}: {handAddedNote(usuallyOffNote(pid)!)}
                    </p>
                  ))}
                {eqGroups.length > 0 && (
                  <p className="mt-1.5 text-xs text-slate-700">{eqGroups.map(groupText).join(" · ")}</p>
                )}
                {noTruck && (
                  <p className="mt-1 text-xs text-amber-700">
                    No truck for the team leaving the shop yet: drag one from Equipment onto a driver.
                  </p>
                )}
                {j.endDate && j.endDate > j.date && (
                  <p className="mt-1 text-xs text-slate-500">
                    Runs {j.date} to {j.endDate}: crew changes here apply to every day of this job.
                  </p>
                )}
                {noDriver.has(j.id) && (
                  <p className="mt-1 text-xs font-semibold text-red-700">⚠ The people leaving the shop for this job have no licensed, insured driver.</p>
                )}
                {probs.map((t) => (
                  <p key={t} className="mt-1 text-xs font-semibold text-red-700">⚠ {t}</p>
                ))}
                {late && <p className="mt-1 text-xs font-semibold text-amber-700">Runs past {time12(meet.dayEndMin)}.</p>}
                {tl?.startMin != null && tl.endMin == null && (
                  <p className="mt-1 text-xs font-semibold text-amber-700">
                    {money(Math.round(tl.remaining))} of work left at the end of the day.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Crew */}
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Crew · drag onto a job</p>
          <div className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-3">
            {available.filter((x) => !officeOnly(x.id)).map((x) => {
              const r = routes[x.id] ?? [];
              const free = sim.freeAt[x.id];
              return (
                <div key={x.id} className={`rounded-lg p-1.5 ${r.length === 0 ? "bg-red-50" : ""}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {personChip(x.id, null, `${x.legalDriver ? " 🛻" : ""}${x.skills.includes("climbing") ? " 🧗" : ""}`)}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {r.length === 0 ? (
                      <span className="font-semibold text-red-700">Not on a job yet: everyone available goes out.</span>
                    ) : (
                      <>
                        {r.map(jobTitle).join(" → ")}
                        {free != null && ` · done ${time12(free)}`}
                        {x.usuallyOff && ` · ${handAddedNote(x.usuallyOff)}`}
                      </>
                    )}
                  </p>
                </div>
              );
            })}
            {available.some((x) => officeOnly(x.id)) && (
              <div className="border-t border-slate-200 pt-2">
                <p className="text-xs font-semibold text-slate-500">Office (not going out)</p>
                {available.filter((x) => officeOnly(x.id)).map((x) => (
                  <div key={x.id} className="mt-1 flex flex-wrap items-center gap-1.5 opacity-70">
                    {personChip(x.id, null)}
                    <span className="text-xs text-slate-500">drag onto a job if they go out today</span>
                  </div>
                ))}
              </div>
            )}
            {usuallyOffFree.length > 0 && (
              <div className="border-t border-slate-200 pt-2">
                <p className="text-xs font-semibold text-slate-500">Usually off today — drag to add</p>
                {usuallyOffFree.map((x) => (
                  <div key={x.id} className="mt-1 flex flex-wrap items-center gap-1.5">
                    {personChip(x.id, null, `${x.legalDriver ? " 🛻" : ""}${x.skills.includes("climbing") ? " 🧗" : ""}`)}
                    <span className="text-xs text-slate-500">{x.usuallyOff}; Auto-fill leaves them out</span>
                  </div>
                ))}
              </div>
            )}
            {others.length > 0 && (
              <div className="border-t border-slate-200 pt-2">
                <p className="text-xs font-semibold text-slate-500">Not available today</p>
                {others.map((c) => (
                  <div key={c.id} className="mt-1 flex flex-wrap items-center gap-1.5 opacity-70">
                    {personChip(c.id, null)}
                    <span className="text-xs text-slate-500">{offReason(c.id) ?? "not in the plan"}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="pt-1 text-xs text-slate-500">🛻 licensed and insured driver · 🧗 climber. On a phone: tap a person, then a job.</p>
          </div>

          {/* Equipment */}
          <p className="pt-1 text-xs font-bold uppercase tracking-wide text-slate-500">Equipment · drag onto a person on a job</p>
          <div className="space-y-1 rounded-xl border border-slate-200 bg-white p-3">
            {fleet.length === 0 && <p className="text-xs text-slate-500">No equipment yet (add it on the Equipment page).</p>}
            {fleet.map((e) => {
              const ok = usable(e);
              const where = eqWhere.get(e.id);
              return (
                <div key={e.id} className={`flex flex-wrap items-center gap-1.5 text-xs ${ok ? "" : "opacity-60"}`}>
                  <span
                    draggable={ok}
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData("text/plain", JSON.stringify({ eq: e.id }));
                      ev.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => ok && setPickedEq(pickedEq === e.id ? null : e.id)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${
                      ok ? "cursor-grab" : "cursor-not-allowed"
                    } ${pickedEq === e.id ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 bg-white text-slate-800"}`}
                  >
                    {isTruck(e) ? "🛻 " : ""}
                    {e.name}
                  </span>
                  <span className="text-slate-500">
                    {!ok
                      ? e.down
                        ? "down"
                        : "in the shop"
                      : where
                        ? `${jobTitle(where.jobId)}${where.driver ? ` (${name(where.driver)})` : ""}`
                        : "free"}
                  </span>
                  {where && (
                    <button
                      type="button"
                      aria-label={`Take ${e.name} off ${jobTitle(where.jobId)}`}
                      onClick={() => setEquipment(unplaceEquipment(equipment, where.jobId, e.id))}
                      className="rounded px-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
            <p className="pt-1 text-xs text-slate-500">On a phone: tap a piece, then the person on a job who takes it.</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
            <p>
              <span className="font-semibold text-slate-800">How times are worked out:</span> every{" "}
              {money(meet.dollarsPerHour)} of job value is 1 hour for a crew of up to {meet.fullSpeedCrew}; each
              extra person speeds it up the same share. Drive times are from the shop, then from job to job.
            </p>
            {isOwnerLike(role) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">
                  $ per hour
                  <input
                    type="number"
                    min={50}
                    step={50}
                    defaultValue={meet.dollarsPerHour}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 50 && v !== meet.dollarsPerHour) savePlannerSettings({ dollarsPerHour: v });
                    }}
                    className="w-20 rounded border border-slate-300 px-1.5 py-0.5"
                  />
                </label>
                <label className="flex items-center gap-1">
                  for up to
                  <input
                    type="number"
                    min={1}
                    max={12}
                    defaultValue={meet.fullSpeedCrew}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 1 && v !== meet.fullSpeedCrew) savePlannerSettings({ fullSpeedCrew: v });
                    }}
                    className="w-14 rounded border border-slate-300 px-1.5 py-0.5"
                  />
                  people
                </label>
                <label className="flex items-center gap-1">
                  smallest team
                  <input
                    type="number"
                    min={1}
                    max={6}
                    defaultValue={meet.minTeam}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 1 && v !== meet.minTeam) savePlannerSettings({ minTeam: v });
                    }}
                    className="w-14 rounded border border-slate-300 px-1.5 py-0.5"
                  />
                </label>
                <label className="flex w-full items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={emailCrewOnSave(state.settings.planner)}
                    onChange={(e) => savePlannerSettings({ emailCrewOnSave: e.target.checked })}
                  />
                  Email everyone their day when I press Save day
                </label>
              </div>
            )}
            {times && times.t.estimated > 0 && (
              <p className="mt-1 text-amber-700">
                {times.t.estimated} drive legs are straight-line estimates (the road-time service didn&apos;t answer).
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The Fill preview: day by day what Apply saves. Nothing is saved until Apply. */
function FillPreviewPanel({
  preview,
  email,
  busy,
  onApply,
  onCancel,
}: {
  preview: FillPreview;
  email: FillEmail;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  return (
    <section className="rounded-xl border-2 border-emerald-600 bg-white p-3 text-sm" aria-label="Fill preview">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-slate-900">Preview: fill the next 6 days</h3>
          <p className="text-xs text-slate-600">
            Nothing is saved yet. {preview.changedJobs} job{preview.changedJobs === 1 ? "" : "s"} would change. Apply saves
            it and the crew see it; you can Undo for 10 minutes.
          </p>
          <p className={`mt-1 text-xs font-semibold ${email.on ? "text-amber-800" : "text-slate-600"}`}>
            ✉️{" "}
            {!email.on
              ? "No emails: “Email everyone their day” is off."
              : email.total === 0
                ? "No one would be emailed."
                : `Apply emails ${people(email.total)} their day${email.needsConfirm ? " (you will be asked twice)" : ""}.`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={busy}
            className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        {preview.days.map((d) => (
          <div key={d.day}>
            <p className="font-semibold text-slate-900">
              {d.label} <span className="font-normal text-slate-500">· {d.summary}</span>
            </p>
            <ul className="mt-1 space-y-1">
              {d.jobs.map((j) => (
                <li key={j.jobId} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <p className="break-words">
                    <span className="font-semibold">{j.start}</span> · {j.title}
                    {j.continues && <span className="text-slate-500"> (continues, same crew)</span>}
                  </p>
                  <p className="break-words text-xs text-slate-700">
                    👷 {j.crew.length > 0 ? j.crew.join(", ") : "nobody"}
                    {j.equipment.length > 0 && <> · 🛻 {j.equipment.join(" + ")}</>}
                  </p>
                  {j.changes.length > 0 && (
                    <ul className="text-xs text-emerald-800">
                      {j.changes.map((c) => (
                        <li key={c} className="break-words">
                          • {c}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!j.continues && j.changes.length === 0 && <p className="text-xs text-slate-500">No change</p>}
                  {j.warnings.map((w) => (
                    <p key={w} className="break-words text-xs font-semibold text-amber-800">
                      ⚠️ {w}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {(preview.unplanned.length > 0 || preview.skipped.length > 0) && (
        <div className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          {preview.unplanned.length > 0 && (
            <>
              <p className="font-semibold">Left unplanned or not finished</p>
              <ul>
                {preview.unplanned.map((u) => (
                  <li key={u} className="break-words">
                    • {u}
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.skipped.length > 0 && (
            <>
              <p className="mt-1 font-semibold">Days Fill leaves alone</p>
              <ul>
                {preview.skipped.map((x) => (
                  <li key={x.day}>
                    • {x.label}: {x.why}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
