import { useEffect, useState } from "react";
import { isSchedulable } from "../crewSuggest";
import { useStore } from "../store";
import type {
  Equipment,
  EquipmentKind,
  EquipmentNote,
  EquipmentStatus,
} from "../types";
import { isEquipmentDown } from "../types";
import {
  defaultTasksForKind,
  overdueTasks,
  taskDue,
} from "../maintenance";
import { fmtDate, todayStr, uid } from "../utils";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";
import { markEquipmentNotesSeen } from "../equipmentNotesSeen";
import { unresolvedFor } from "../equipmentProblems";
import { MachineProblems, OpenProblemsCard } from "./EquipmentProblems";
import { isOwnerLike } from "../permissions";

const KIND_OPTIONS: EquipmentKind[] = [
  "Truck",
  "Chipper",
  "Dump trailer",
  "Equipment trailer",
  "Trailer",
  "Mini skid",
  "Stump grinder",
  "Other",
];
/** Kinds a truck can tow behind it. */
const TOWABLE: EquipmentKind[] = [
  "Chipper",
  "Dump trailer",
  "Equipment trailer",
  "Trailer",
  "Stump grinder",
];
const numOrNull = (v: string): number | null => {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n);
};
const STATUS_OPTIONS: EquipmentStatus[] = ["available", "in_shop", "retired"];
const STATUS_LABEL: Record<EquipmentStatus, string> = {
  available: "Available",
  in_shop: "In the shop",
  retired: "Retired",
};

function statusPill(status: EquipmentStatus) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        status === "available"
          ? "bg-emerald-100 text-emerald-800"
          : status === "in_shop"
            ? "bg-amber-100 text-amber-800"
            : "bg-slate-100 text-slate-500"
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Add / edit equipment form. Owners only. */
function EquipmentForm({
  existing,
  onDone,
}: {
  existing: Equipment | null;
  onDone: () => void;
}) {
  const { state, saveEquipment, saveMaintenanceTask } = useStore();
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<EquipmentKind>(existing?.kind ?? "Chipper");
  const [details, setDetails] = useState(existing?.details ?? "");
  const [status, setStatus] = useState<EquipmentStatus>(
    existing?.status ?? "available",
  );
  const [addStandard, setAddStandard] = useState(true);
  // Fleet details the scheduler uses.
  const [tows, setTows] = useState<string[] | null>(existing?.tows ?? null);
  const [seats, setSeats] = useState(existing?.seats != null ? String(existing.seats) : "");
  const [weight, setWeight] = useState(
    existing?.weightLbs != null ? String(existing.weightLbs) : "",
  );
  const [homeSite, setHomeSite] = useState<string>(existing?.homeSite ?? "");
  const [weeklyLimit, setWeeklyLimit] = useState(
    existing?.weeklyDriverLimit != null ? String(existing.weeklyDriverLimit) : "",
  );
  if (!state) return null;
  const towable = state.equipment.filter(
    (e) => TOWABLE.includes(e.kind) && e.id !== existing?.id && e.status !== "retired",
  );
  const defaults = defaultTasksForKind(kind);
  const save = () => {
    if (!name.trim()) return;
    const id = existing?.id ?? uid();
    saveEquipment({
      id,
      name: name.trim(),
      kind,
      details: details.trim(),
      status,
      // Editing must not wipe the status-board flag.
      down: existing?.down ?? null,
      tows: kind === "Truck" ? tows : null,
      seats: kind === "Truck" ? numOrNull(seats) : null,
      weightLbs: numOrNull(weight),
      weeklyDriverLimit: kind === "Truck" ? numOrNull(weeklyLimit) : null,
      homeSite: homeSite || null,
    });
    // New equipment gets its kind's standard maintenance tasks, so
    // the crew can start logging right away. Intervals are starting
    // points — change them in the Settings tab.
    if (!existing && addStandard) {
      for (const d of defaults) {
        saveMaintenanceTask({
          id: uid(),
          equipmentId: id,
          name: d.name,
          intervalDays: d.intervalDays,
        });
      }
    }
    onDone();
  };
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">
        {existing ? `Edit ${existing.name}` : "Add equipment"}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>Name</label>
          <input
            className={inputCls()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 15XP chipper"
          />
        </div>
        <div>
          <label className={labelCls()}>Kind</label>
          <select
            className={inputCls()}
            value={kind}
            onChange={(e) => setKind(e.target.value as EquipmentKind)}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls()}>Details</label>
          <input
            className={inputCls()}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="e.g. Bandit 15XP, 2021"
          />
        </div>
        <div>
          <label className={labelCls()}>Status</label>
          <select
            className={inputCls()}
            value={status}
            onChange={(e) => setStatus(e.target.value as EquipmentStatus)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm font-bold text-slate-900">For the scheduler</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(state.settings.company?.sites ?? []).length > 0 && (
            <div>
              <label className={labelCls()}>Parked at</label>
              <select className={inputCls()} value={homeSite} onChange={(e) => setHomeSite(e.target.value)}>
                <option value="">Not set</option>
                {(state.settings.company?.sites ?? []).map((site) => (
                  <option key={site.address} value={site.address}>
                    {site.label || site.address}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls()}>
              {kind === "Truck" ? "Weight rating (GVWR, lb)" : "Loaded weight (lb)"}
            </label>
            <input
              className={inputCls()}
              inputMode="numeric"
              value={weight}
              onChange={(e) => setWeight(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="e.g. 14000"
            />
          </div>
          {kind === "Truck" && (
            <>
              <div>
                <label className={labelCls()}>Seats</label>
                <input
                  className={inputCls()}
                  inputMode="numeric"
                  value={seats}
                  onChange={(e) => setSeats(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="e.g. 3"
                />
              </div>
              <div>
                <label className={labelCls()}>Max drives per person per week</label>
                <input
                  className={inputCls()}
                  inputMode="numeric"
                  value={weeklyLimit}
                  onChange={(e) => setWeeklyLimit(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="Blank = no limit (Big Truck: 1)"
                />
              </div>
            </>
          )}
        </div>
        {kind === "Truck" && (
          <div>
            <p className="text-sm font-semibold text-slate-800">Can tow</p>
            <p className="text-xs text-slate-500">
              A truck always goes out with one of these. Combined weight
              over 26,001 lb needs a CDL Class A driver.
            </p>
            {towable.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">
                Add the chipper and trailers first, then tick what this truck can tow.
              </p>
            ) : (
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={tows === null}
                    onChange={(e) => setTows(e.target.checked ? null : [])}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  Not set yet (can tow any of them)
                </label>
                {towable.map((t) => {
                  const on = tows !== null && tows.includes(t.id);
                  return (
                    <label
                      key={t.id}
                      className={`flex items-center gap-2 text-sm ${tows === null ? "text-slate-400" : "cursor-pointer text-slate-800"}`}
                    >
                      <input
                        type="checkbox"
                        disabled={tows === null}
                        checked={on}
                        onChange={() =>
                          setTows(on ? (tows ?? []).filter((x) => x !== t.id) : [...(tows ?? []), t.id])
                        }
                        className="h-4 w-4 accent-emerald-700"
                      />
                      {t.name} · {t.kind}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {!existing && defaults.length > 0 && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={addStandard}
            onChange={(e) => setAddStandard(e.target.checked)}
            className="h-4 w-4 accent-emerald-700"
          />
          Add the standard maintenance tasks for a {kind} (
          {defaults.map((d) => `${d.name} every ${d.intervalDays} days`).join(", ")}
          )
        </label>
      )}
      <div className="flex gap-2">
        <button onClick={save} disabled={!name.trim()} className={primaryBtn()}>
          {existing ? "Save changes" : "Add equipment"}
        </button>
        <button onClick={onDone} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Inline form to log one service for a task. */
function LogForm({
  taskId,
  onDone,
}: {
  taskId: string;
  onDone: () => void;
}) {
  const { state, viewer, logMaintenance } = useStore();
  const [date, setDate] = useState(todayStr());
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [doneBy, setDoneBy] = useState(viewer?.id ?? "");
  if (!state) return null;
  const save = () => {
    if (!date) return;
    logMaintenance({
      id: uid(),
      taskId,
      date,
      hours: hours.trim() === "" ? null : Number(hours),
      notes: notes.trim(),
      doneBy: doneBy || null,
    });
    onDone();
  };
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={labelCls()}>Date done</label>
          <input
            type="date"
            className={inputCls()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls()}>Hour meter (optional)</label>
          <input
            type="number"
            min={0}
            step="0.1"
            className={inputCls()}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="e.g. 1,240"
          />
        </div>
        <div>
          <label className={labelCls()}>Done by</label>
          <select
            className={inputCls()}
            value={doneBy}
            onChange={(e) => setDoneBy(e.target.value)}
          >
            <option value="">—</option>
            {state.crew
              .filter(isSchedulable)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div>
        <label className={labelCls()}>Notes (optional)</label>
        <input
          className={inputCls()}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. New blades, greased bearings"
        />
      </div>
      <div className="flex gap-2">
        <button onClick={save} disabled={!date} className={primaryBtn()}>
          Log it
        </button>
        <button onClick={onDone} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Notes on one machine, shown like a text thread under the equipment
 * card — newest at the bottom. Anyone on the team can leave a note
 * (groundsmen included); the author and time stay on each note, and
 * a note can be removed by its author or a manager.
 */
function EquipmentNotes({
  equipmentId,
  notes,
  viewerId,
  canManage,
  onAdd,
  onDelete,
}: {
  equipmentId: string;
  notes: EquipmentNote[];
  viewerId: string;
  /** Managers (and owners) may delete any note; anyone may delete their own. */
  canManage: boolean;
  onAdd: (text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const sorted = [...notes].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const fmtWhen = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };
  const send = () => {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  };
  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <p className="text-sm font-bold text-slate-900">
        Notes {sorted.length > 0 && `(${sorted.length})`}
      </p>
      {sorted.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">
          Nothing here yet — if something looks or sounds off, leave a
          note so the next person sees it.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {sorted.map((n) => (
            <li
              key={n.id}
              className="rounded-lg bg-slate-50 px-3 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">
                  {n.authorName}
                  <span className="ml-2 font-normal text-slate-400">
                    {fmtWhen(n.createdAt)}
                  </span>
                </span>
                {(canManage || n.authorId === viewerId) && (
                  <button
                    onClick={() => onDelete(n.id)}
                    aria-label="Delete note"
                    className="rounded px-1.5 py-0.5 text-xs font-bold text-slate-400 hover:bg-red-50 hover:text-red-700"
                  >
                    ✕
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-slate-700">
                {n.text}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Leave a note on this machine…"
          aria-label={`Note on ${equipmentId}`}
          className={inputCls()}
        />
        <button
          onClick={send}
          disabled={!draft.trim()}
          className="shrink-0 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-800 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * Shorthand status board — one compact row per machine, green =
 * operational, red = down. Only managers can flip a machine's status
 * (see setEquipmentDown): the crew report problems by leaving a
 * comment on the machine instead. Marking a machine down changes
 * nothing else — it stays in the list and stays assignable to jobs;
 * this board is a field report, not a scheduling rule.
 */
export default function EquipmentPage() {
  const {
    state,
    viewer,
    canEdit,
    deleteEquipment,
    setEquipmentDown,
    saveMaintenanceTask,
    deleteMaintenanceTask,
    deleteMaintenanceRecord,
    addEquipmentNote,
    deleteEquipmentNote,
  } = useStore();
  const [tab, setTab] = useState<"equipment" | "settings">("equipment");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Equipment | null>(null);
  // Which machine is opened up in the list (tap a row to open it).
  const [openEqId, setOpenEqId] = useState<string | null>(null);
  const [confirmDeleteEq, setConfirmDeleteEq] = useState<string | null>(null);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<string | null>(null);
  const [loggingTaskId, setLoggingTaskId] = useState<string | null>(null);
  // Which task's full log is expanded. The one-line summary (last
  // done / next due / overdue flag) is always visible.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const toggleTask = (taskId: string) => {
    if (openTaskId === taskId) {
      setOpenTaskId(null);
      setLoggingTaskId((cur) => (cur === taskId ? null : cur));
    } else {
      setOpenTaskId(taskId);
    }
  };
  const [newTaskEq, setNewTaskEq] = useState("");
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskInterval, setNewTaskInterval] = useState(90);
  // Opening this page marks the equipment comments seen for this
  // person — the nav badge counts only comments left after that.
  // (Before the `if (!state)` return: hooks must run on every render.)
  useEffect(() => {
    if (viewer?.id) markEquipmentNotesSeen(viewer.id);
  }, [viewer?.id]);
  if (!state) return null;
  const today = todayStr();
  const isOwner = isOwnerLike(viewer?.appRole);
  const overdue = overdueTasks(state, today);
  const crewName = (id: string | null) =>
    id ? (state.crew.find((c) => c.id === id)?.name ?? "Unknown") : "—";
  const upcomingJobsFor = (eqId: string) =>
    state.jobs
      .filter((j) => j.date >= today && (j.equipmentIds ?? []).includes(eqId))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Equipment</h1>
        <div className="flex gap-2">
          {(["equipment", "settings"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-3 py-1 text-sm font-semibold ${
                tab === t
                  ? "bg-emerald-700 text-white"
                  : "border border-slate-300 bg-white text-slate-700"
              }`}
            >
              {t === "equipment" ? "Equipment" : "Maintenance settings"}
            </button>
          ))}
        </div>
      </div>

      {overdue.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <p className="font-bold text-red-800">
            ⚠ Maintenance overdue — {overdue.length} task
            {overdue.length === 1 ? "" : "s"} past due
          </p>
          <ul className="mt-2 space-y-1 text-sm text-red-700">
            {overdue.map((o) => (
              <li key={o.task.id}>
                {o.task.name} — {o.equipment.name} · {o.daysOverdue} day
                {o.daysOverdue === 1 ? "" : "s"} overdue
                {o.lastDone ? ` (last done ${fmtDate(o.lastDone)})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "equipment" && (
        <>
          <OpenProblemsCard />
          {isOwner && !showForm && (
            <button
              onClick={() => setShowForm(true)}
              className={primaryBtn()}
            >
              + Add equipment
            </button>
          )}
          {showForm && (
            <EquipmentForm existing={null} onDone={() => setShowForm(false)} />
          )}

          {state.equipment.length === 0 ? (
            <p className="text-sm text-slate-500">
              No equipment yet — add the fleet above and each piece gets
              its standard maintenance tasks.
            </p>
          ) : (
            <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold text-slate-900">All equipment</h2>
                <p className="text-sm font-semibold">
                  <span className="text-emerald-700">
                    {state.equipment.filter((e) => !isEquipmentDown(e)).length} operational
                  </span>
                  {" · "}
                  <span className="text-red-700">
                    {state.equipment.filter((e) => isEquipmentDown(e)).length} down
                  </span>
                </p>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                Tap a machine to see everything about it: maintenance, notes, jobs it&apos;s booked on
                {isOwner ? ", and to edit it or mark it down." : "."}
              </p>
              <ul className="mt-2 space-y-1.5">
                {state.equipment.map((eq) => {
                const tasks = state.maintenanceTasks.filter(
                  (t) => t.equipmentId === eq.id,
                );
                const upcoming = upcomingJobsFor(eq.id);
                const down = isEquipmentDown(eq);
                const open = openEqId === eq.id;
                const overdueCount = overdue.filter((o) => o.equipment.id === eq.id).length;
                const noteCount = (state.equipmentNotes ?? []).filter((n) => n.equipmentId === eq.id).length;
                const problemCount = unresolvedFor(state.equipmentProblems, eq.id).length;
                const parkedAt = eq.homeSite
                  ? (state.settings.company?.sites ?? []).find((x) => x.address === eq.homeSite)?.label || eq.homeSite
                  : null;
                return (
                  <li
                    key={eq.id}
                    className={`rounded-lg border ${
                      down ? "border-red-200 bg-red-50" : "border-emerald-100 bg-emerald-50/60"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setOpenEqId(open ? null : eq.id);
                        if (open && editing?.id === eq.id) setEditing(null);
                      }}
                      aria-expanded={open}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
                    >
                      <span
                        className={`h-3 w-3 shrink-0 rounded-full ${down ? "bg-red-600" : "bg-emerald-500"}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-slate-900">{eq.name}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {eq.kind}
                          {eq.details ? ` · ${eq.details}` : ""}
                          {parkedAt ? ` · at ${parkedAt}` : ""}
                        </span>
                      </span>
                      {overdueCount > 0 && (
                        <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                          ⚠ {overdueCount} overdue
                        </span>
                      )}
                      {problemCount > 0 && (
                        <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                          ⚠ {problemCount} problem{problemCount === 1 ? "" : "s"}
                        </span>
                      )}
                      {noteCount > 0 && (
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                          💬 {noteCount}
                        </span>
                      )}
                      {eq.status !== "available" && statusPill(eq.status)}
                      <span className={`shrink-0 text-xs font-bold ${down ? "text-red-700" : "text-emerald-700"}`}>
                        {down ? "Down" : "Operational"}
                      </span>
                      <span className="shrink-0 text-xs text-slate-400" aria-hidden>
                        {open ? "▾" : "▸"}
                      </span>
                    </button>

                    {open && (
                      <div className="border-t border-slate-200 bg-white px-3 pb-3 pt-2">
                        {editing?.id === eq.id ? (
                          <EquipmentForm existing={eq} onDone={() => setEditing(null)} />
                        ) : (
                          <>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="text-sm text-slate-600">
                                {eq.details && <p>{eq.details}</p>}
                                <p className="text-xs text-slate-500">
                                  {upcoming.length > 0
                                    ? `Booked: ${upcoming
                                        .slice(0, 3)
                                        .map((j) => `${j.title} · ${fmtDate(j.date)}`)
                                        .join(" · ")}`
                                    : "Not booked on any upcoming job"}
                                </p>
                                {eq.kind === "Truck" && (eq.seats != null || eq.weeklyDriverLimit != null) && (
                                  <p className="text-xs text-slate-500">
                                    {eq.seats != null ? `${eq.seats} seats` : ""}
                                    {eq.seats != null && eq.weeklyDriverLimit != null ? " · " : ""}
                                    {eq.weeklyDriverLimit != null
                                      ? `max ${eq.weeklyDriverLimit} drive${eq.weeklyDriverLimit === 1 ? "" : "s"} per person per week`
                                      : ""}
                                  </p>
                                )}
                              </div>
                              {isOwner && (
                                <div className="flex flex-wrap items-center gap-2">
                                  <button
                                    onClick={() => setEquipmentDown(eq.id, !down)}
                                    className={`rounded-lg px-2 py-1 text-sm font-semibold ${
                                      down
                                        ? "bg-emerald-700 text-white hover:bg-emerald-800"
                                        : "border border-red-200 text-red-700 hover:bg-red-50"
                                    }`}
                                  >
                                    {down ? "Back up" : "Mark down"}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditing(eq);
                                      setShowForm(false);
                                    }}
                                    className="rounded-lg border border-slate-300 px-2 py-1 text-sm font-semibold text-slate-700 hover:border-emerald-500"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (confirmDeleteEq === eq.id) {
                                        deleteEquipment(eq.id);
                                        setConfirmDeleteEq(null);
                                        setOpenEqId(null);
                                      } else {
                                        setConfirmDeleteEq(eq.id);
                                      }
                                    }}
                                    className="rounded-lg border border-red-200 px-2 py-1 text-sm font-semibold text-red-700 hover:bg-red-50"
                                  >
                                    {confirmDeleteEq === eq.id ? "Confirm delete?" : "Delete"}
                                  </button>
                                </div>
                              )}
                            </div>

                    {tasks.length === 0 ? (
                      <p className="mt-3 text-sm text-slate-500">
                        No maintenance tasks yet — add them in Maintenance
                        settings.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {tasks.map((t) => {
                          const d = taskDue(t, state.maintenanceRecords, today);
                          const records = state.maintenanceRecords
                            .filter((r) => r.taskId === t.id)
                            .sort((a, b) => b.date.localeCompare(a.date));
                          return (
                            <li
                              key={t.id}
                              className="rounded-lg border border-slate-100 bg-slate-50/60 p-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => toggleTask(t.id)}
                                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                  aria-expanded={openTaskId === t.id}
                                >
                                  <span
                                    className="shrink-0 text-xs text-slate-400"
                                    aria-hidden
                                  >
                                    {openTaskId === t.id ? "▾" : "▸"}
                                  </span>
                                  <span className="truncate text-sm font-semibold text-slate-900">
                                    {t.name}
                                  </span>
                                  <span className="shrink-0 text-xs font-medium text-slate-500">
                                    every {t.intervalDays}d
                                  </span>
                                </button>
                                <div className="flex items-center gap-2">
                                  {d.status === "overdue" && (
                                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                                      Overdue {d.daysOverdue}d
                                    </span>
                                  )}
                                  {d.status === "due-soon" && (
                                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                                      Due {d.due ? fmtDate(d.due) : ""}
                                    </span>
                                  )}
                                  {d.status === "ok" && (
                                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
                                      Due {d.due ? fmtDate(d.due) : ""}
                                    </span>
                                  )}
                                  {d.status === "never" && (
                                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-600">
                                      No record yet
                                    </span>
                                  )}
                                  {canEdit && (
                                    <button
                                      onClick={() => {
                                        setOpenTaskId(t.id);
                                        setLoggingTaskId(
                                          loggingTaskId === t.id ? null : t.id,
                                        );
                                      }}
                                      className="rounded-lg bg-emerald-700 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-800"
                                    >
                                      Log maintenance
                                    </button>
                                  )}
                                </div>
                              </div>
                              <p className="mt-0.5 text-xs text-slate-600">
                                Last done:{" "}
                                {d.lastDone ? fmtDate(d.lastDone) : "never logged"}
                                {d.due && d.status !== "never"
                                  ? ` · Next due: ${fmtDate(d.due)}`
                                  : ""}
                              </p>
                              {openTaskId === t.id && (
                                <>
                                  {loggingTaskId === t.id && (
                                    <LogForm
                                      taskId={t.id}
                                      onDone={() => setLoggingTaskId(null)}
                                    />
                                  )}
                                  {records.length > 0 && (
                                <ul className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-sm text-slate-600">
                                  {records.slice(0, 3).map((r) => (
                                    <li
                                      key={r.id}
                                      className="flex items-center justify-between gap-2"
                                    >
                                      <span>
                                        {fmtDate(r.date)} · {crewName(r.doneBy)}
                                        {r.hours !== null
                                          ? ` · ${r.hours} hrs`
                                          : ""}
                                        {r.notes ? ` — ${r.notes}` : ""}
                                      </span>
                                      {canEdit && (
                                        <button
                                          onClick={() =>
                                            deleteMaintenanceRecord(r.id)
                                          }
                                          aria-label="Delete record"
                                          className="rounded px-1.5 py-0.5 text-xs font-bold text-slate-400 hover:bg-red-50 hover:text-red-700"
                                        >
                                          ✕
                                        </button>
                                      )}
                                    </li>
                                  ))}
                                    </ul>
                                  )}
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {/* Problem reports: anyone reports one (text + photo);
                        the office marks it fixed or sends it to the shop. */}
                    <MachineProblems equipment={eq} />

                    {/* Notes on this machine, like texts on it — anyone
                        on the team can leave one, groundsmen included.
                        The author and time stay on the note. */}
                    <EquipmentNotes
                      equipmentId={eq.id}
                      notes={(state.equipmentNotes ?? []).filter(
                        (n) => n.equipmentId === eq.id,
                      )}
                      viewerId={viewer?.id ?? ""}
                      canManage={isOwner}
                      onAdd={(text) => addEquipmentNote(eq.id, text)}
                      onDelete={deleteEquipmentNote}
                    />
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
              </ul>
            </section>
          )}
        </>
      )}

      {tab === "settings" && (
        <section className="space-y-4">
          {!isOwner ? (
            <p className="text-sm text-slate-500">
              Maintenance intervals are set by an owner or manager.
              Everyone can see the schedules on the Equipment tab.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                How often each task comes due, in days. Change a number and
                the next-due dates update everywhere. The chipper's
                "100-hour service" is tracked in days here — log the
                hour-meter reading with each service and adjust the interval
                to match how fast the hours pile up.
              </p>
              {state.equipment.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Add equipment first, then its maintenance tasks appear here.
                </p>
              ) : (
                <ul className="space-y-4">
                  {state.equipment.map((eq) => {
                    const tasks = state.maintenanceTasks.filter(
                      (t) => t.equipmentId === eq.id,
                    );
                    return (
                      <li
                        key={eq.id}
                        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                      >
                        <p className="font-bold text-slate-900">{eq.name}</p>
                        {tasks.length === 0 ? (
                          <p className="mt-2 text-sm text-slate-500">
                            No tasks — add one below.
                          </p>
                        ) : (
                          <ul className="mt-2 space-y-2">
                            {tasks.map((t) => (
                              <li
                                key={t.id}
                                className="flex flex-wrap items-center gap-2 text-sm"
                              >
                                <input
                                  className={`${inputCls()} w-48`}
                                  defaultValue={t.name}
                                  onBlur={(e) => {
                                    const v = e.target.value.trim();
                                    if (v && v !== t.name) {
                                      saveMaintenanceTask({ ...t, name: v });
                                    }
                                  }}
                                  aria-label="Task name"
                                />
                                <label className="flex items-center gap-1 text-slate-600">
                                  every
                                  <input
                                    type="number"
                                    min={1}
                                    className={`${inputCls()} w-20`}
                                    defaultValue={t.intervalDays}
                                    onBlur={(e) => {
                                      const v = Number(e.target.value);
                                      if (
                                        Number.isFinite(v) &&
                                        v >= 1 &&
                                        v !== t.intervalDays
                                      ) {
                                        saveMaintenanceTask({
                                          ...t,
                                          intervalDays: Math.round(v),
                                        });
                                      }
                                    }}
                                    aria-label="Interval in days"
                                  />
                                  days
                                </label>
                                <button
                                  onClick={() => {
                                    if (confirmDeleteTask === t.id) {
                                      deleteMaintenanceTask(t.id);
                                      setConfirmDeleteTask(null);
                                    } else {
                                      setConfirmDeleteTask(t.id);
                                    }
                                  }}
                                  className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                                >
                                  {confirmDeleteTask === t.id
                                    ? "Confirm delete?"
                                    : "Delete"}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-base font-bold text-slate-900">
                  Add a maintenance task
                </h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className={labelCls()}>Equipment</label>
                    <select
                      className={inputCls()}
                      value={newTaskEq}
                      onChange={(e) => setNewTaskEq(e.target.value)}
                    >
                      <option value="">Pick equipment…</option>
                      {state.equipment.map((eq) => (
                        <option key={eq.id} value={eq.id}>
                          {eq.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls()}>Task name</label>
                    <input
                      className={inputCls()}
                      value={newTaskName}
                      onChange={(e) => setNewTaskName(e.target.value)}
                      placeholder="e.g. Grease bearings"
                    />
                  </div>
                  <div>
                    <label className={labelCls()}>Every (days)</label>
                    <input
                      type="number"
                      min={1}
                      className={inputCls()}
                      value={newTaskInterval}
                      onChange={(e) => setNewTaskInterval(Number(e.target.value))}
                    />
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (!newTaskEq || !newTaskName.trim() || !(newTaskInterval >= 1))
                      return;
                    saveMaintenanceTask({
                      id: uid(),
                      equipmentId: newTaskEq,
                      name: newTaskName.trim(),
                      intervalDays: Math.round(newTaskInterval),
                    });
                    setNewTaskName("");
                    setNewTaskInterval(90);
                  }}
                  disabled={
                    !newTaskEq || !newTaskName.trim() || !(newTaskInterval >= 1)
                  }
                  className={`${primaryBtn()} mt-3`}
                >
                  Add task
                </button>
              </section>
            </>
          )}
        </section>
      )}
    </div>
  );
}
