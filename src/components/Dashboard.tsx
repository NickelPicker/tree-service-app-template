import { useEffect, useState, type ReactNode } from "react";
import { jobInvoicePricing, okToInvoiceWithOpenClock, okToMakeZeroInvoice } from "../invoiceMaking";
import { useLoadedState, useStore } from "../store";
import type { Job } from "../types";
import { jobValue, stillToInvoiceJobs } from "../jobValue";
import {
  currentJobFor,
  formatAge,
  lastLocationFor,
  openRequestsFor,
} from "../location";
import { addressLine, primaryAddress } from "../addresses";
import { federalHoliday } from "../holidays";
import { isOwnerLike } from "../permissions";
import { entryHoursNow } from "../crewDay";
import {
  addDaysISO,
  fmtDate,
  isClosedDay,
  isTimeOffOn,
  mondayOf,
  money,
  todayStr,
  weekDates,
} from "../utils";
import {
  isGenerallyAvailable,
  isSchedulable,
  weekdayOf,
  WEEKDAY_FULL,
  handAddedNote,
} from "../crewSuggest";
import {
  loadCollapsedPanels,
  saveCollapsedPanels,
  toggleCollapsedPanel,
  type CollapsedPanels,
} from "../collapsedPanels";
import { overdueTasks } from "../maintenance";
import { isUnavailableOn } from "../unavailability";
import DayMap, { type DayStop } from "./DayMap";
import TodoCard from "./TodoCard";
import SetupChecklistCard from "./SetupChecklistCard";
import {
  estimateValue,
  monthCells,
  monthLabel,
} from "./Schedule";
import { linkCls, primaryBtn, secondaryBtn, StatusBadge } from "./ui";
import { nextWorkingDay } from "../jobForm";

/** One dashboard square, with its move controls when the layout is being customized. */
function LayoutPanel({
  title,
  order,
  first,
  last,
  customizing,
  onMove,
  isDragging,
  isDropTarget,
  onGripDragStart,
  onGripDragEnd,
  onDragOverPanel,
  onDropOnPanel,
  children,
}: {
  title: string;
  order: number;
  first: boolean;
  last: boolean;
  customizing: boolean;
  onMove: (dir: -1 | 1) => void;
  isDragging: boolean;
  isDropTarget: boolean;
  onGripDragStart: (e: React.DragEvent) => void;
  onGripDragEnd: () => void;
  onDragOverPanel: (e: React.DragEvent) => void;
  onDropOnPanel: (e: React.DragEvent) => void;
  children: ReactNode;
}) {
  return (
    <div
      style={{ order }}
      onDragOver={customizing ? onDragOverPanel : undefined}
      onDrop={customizing ? onDropOnPanel : undefined}
      className={
        isDropTarget
          ? "rounded-xl ring-2 ring-emerald-500 ring-offset-2"
          : isDragging
            ? "opacity-40"
            : undefined
      }
    >
      {customizing && (
        <div className="mb-2 flex items-center gap-2">
          <span
            draggable
            onDragStart={onGripDragStart}
            onDragEnd={onGripDragEnd}
            title="Drag to move this square"
            className="cursor-grab touch-none rounded-md border border-slate-300 bg-white px-2 py-0.5 text-sm font-bold text-slate-500 hover:border-emerald-500 active:cursor-grabbing"
          >
            ⋮⋮
          </span>
          <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
            {title}
          </span>
          <button
            onClick={() => onMove(-1)}
            disabled={first}
            aria-label={`Move ${title} up`}
            className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-sm font-bold text-slate-700 hover:border-emerald-500 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={last}
            aria-label={`Move ${title} down`}
            className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-sm font-bold text-slate-700 hover:border-emerald-500 disabled:opacity-30"
          >
            ↓
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Header row for one dashboard panel: title, an optional extra
 * control (e.g. Ping crew, month nav), and the collapse chevron. A
 * real button, not hover-only, so it works on a phone.
 */
function PanelHead({
  title,
  collapsed,
  onToggle,
  extra,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-bold text-slate-900">{title}</h2>
      <span className="flex shrink-0 items-center gap-1">
        {extra}
        <button
          onClick={onToggle}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          aria-expanded={!collapsed}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm font-bold text-slate-700 hover:border-emerald-500"
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </span>
    </div>
  );
}

/**
 * Small month calendar: day number plus a green box (day not full) or a
 * red box (day full — its job value hit the daily target). Tap a day to
 * jump to it on the Schedule. No dollar amounts shown, so crew can use
 * it too — the box is a workload signal, not a price.
 */
function MiniCalendar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { state, setView, setScheduleFocusDate } = useStore();
  const now = new Date();
  const [cursor, setCursor] = useState({
    y: now.getFullYear(),
    m: now.getMonth(),
  });
  const showMoney = useStore().showMoney;
  if (!state) return null;
  const today = todayStr();
  const cells = monthCells(cursor.y, cursor.m);
  const target = state.settings.dailyTarget ?? 0;
  const shift = (dir: 1 | -1) => {
    const m = cursor.m + dir;
    setCursor({
      y: cursor.y + Math.floor(m / 12),
      m: ((m % 12) + 12) % 12,
    });
  };
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <PanelHead
        title={monthLabel(cursor.y, cursor.m)}
        collapsed={collapsed}
        onToggle={onToggle}
        extra={
          <span className="flex gap-1">
            <button
              onClick={() => shift(-1)}
              aria-label="Previous month"
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm font-bold text-slate-700 hover:border-emerald-500"
            >
              ‹
            </button>
            <button
              onClick={() => shift(1)}
              aria-label="Next month"
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm font-bold text-slate-700 hover:border-emerald-500"
            >
              ›
            </button>
          </span>
        }
      />
      {collapsed ? (
        <p className="text-sm text-slate-500">
          Tap a day to jump to it on the Schedule.
        </p>
      ) : (
        <>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-slate-500">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((date) => {
          const inMonth = parseInt(date.slice(5, 7), 10) === cursor.m + 1;
          const dayNum = parseInt(date.slice(8, 10), 10);
          const dayTotal = inMonth
            ? state.jobs
                .filter((j) => j.date === date)
                .reduce((s, j) => s + (jobValue(state, j) ?? 0), 0)
            : 0;
          const full = target > 0 && dayTotal >= target;
          const isToday = date === today;
          const closed = isClosedDay(state.closedDays, date);
          const holiday = inMonth ? federalHoliday(date) : null;
          return (
            <button
              key={date}
              disabled={!inMonth}
              onClick={() => {
                setScheduleFocusDate(date);
                setView("schedule");
              }}
              title={
                inMonth
                  ? holiday
                    ? `Federal holiday — ${holiday}`
                    : closed
                      ? "Business closed"
                      : full
                        ? `Full day${showMoney ? ` — ${money(dayTotal)}` : ""}`
                        : `Open day${showMoney ? ` — ${money(dayTotal)}` : ""}`
                  : ""
              }
              className={`flex flex-col items-center rounded-md py-1 ${
                isToday ? "ring-2 ring-emerald-600" : ""
              } ${inMonth ? "hover:bg-slate-100" : "opacity-40"}`}
            >
              <span className="text-xs font-semibold text-slate-900">
                {dayNum}
              </span>
              {inMonth && (
                <span
                  className={`mt-0.5 h-2.5 w-2.5 rounded-sm ${
                    closed
                      ? "bg-slate-500"
                      : full
                        ? "bg-red-500"
                        : "bg-emerald-500"
                  }`}
                />
              )}
              {holiday && (
                <span
                  className="mt-0.5 text-[9px] leading-none"
                  title={`Federal holiday — ${holiday}`}
                >
                  🇺🇸
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        <span className="mr-3">
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500 align-middle" />{" "}
          Open day
        </span>
        <span>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-red-500 align-middle" />{" "}
          Full day
        </span>
        {target <= 0 &&
          " — set a daily target in Schedule → Calendar settings to mark full days red."}
      </p>
        </>
      )}
    </section>
  );
}

/**
 * Quick assigner for one Dashboard job row. Owners and managers only
 * (app role owner or manager). Each checkbox saves immediately, so the row
 * underneath updates live; closing the picker (✕, click outside,
 * Escape) just closes it. People on approved time off that day show an
 * amber "— off" tag — a warning, not a block.
 */
function AssignPicker({
  job,
  onClose,
}: {
  job: Job;
  onClose: () => void;
}) {
  const { state, setJobCrew, setJobEquipment } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!state) return null;
  const activeCrew = state.crew.filter(isSchedulable);
  const availableEq = state.equipment.filter(
    (e) => e.status === "available",
  );
  const assignedEq = (job.equipmentIds ?? []).length;
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-slate-900">
            Assign crew — {job.title}
          </p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-sm font-bold text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {activeCrew.map((c) => {
            const checked = job.crewIds.includes(c.id);
            const off = isTimeOffOn(state.timeOff, c.id, job.date);
            const unavailable = isUnavailableOn(
              state.unavailability,
              c.id,
              job.date,
            );
            const generallyOff = !isGenerallyAvailable(
              c,
              weekdayOf(job.date),
            );
            return (
              <li key={c.id}>
                <label
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                    !checked && (off || unavailable)
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    // Time off / marked unavailable can't be added (business rule); someone already on the job can still be
                    // taken off. Usually off that weekday can be added by hand.
                    disabled={!checked && (off || unavailable)}
                    onChange={() => {
                      const next = checked
                        ? job.crewIds.filter((id) => id !== c.id)
                        : [...job.crewIds, c.id];
                      setJobCrew(job.id, next);
                    }}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  <span className="font-medium text-slate-900">{c.name}</span>
                  <span className="text-slate-500">· {c.role}</span>
                  {off && (
                    <span className="text-xs font-semibold text-amber-700">
                      — off
                    </span>
                  )}
                  {unavailable && (
                    <span className="text-xs font-semibold text-amber-700">
                      — unavailable
                    </span>
                  )}
                  {!off && !unavailable && generallyOff && (
                    <span className="text-xs font-semibold text-amber-700">
                      — {checked
                        ? handAddedNote(`usually off ${WEEKDAY_FULL[weekdayOf(job.date)]}s`)
                        : `usually off ${WEEKDAY_FULL[weekdayOf(job.date)]}s`}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className="text-sm font-bold text-slate-900">Equipment</p>
          {availableEq.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">
              No equipment available — add it on the Equipment tab.
            </p>
          ) : (
            <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
              {availableEq.map((e) => {
                const checked = (job.equipmentIds ?? []).includes(e.id);
                return (
                  <li key={e.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const prev = job.equipmentIds ?? [];
                          const next = checked
                            ? prev.filter((id) => id !== e.id)
                            : [...prev, e.id];
                          setJobEquipment(job.id, next);
                        }}
                        className="h-4 w-4 accent-emerald-700"
                      />
                      <span className="font-medium text-slate-900">
                        {e.name}
                      </span>
                      <span className="text-slate-500">· {e.kind}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {job.crewIds.length === 0
            ? "Nobody assigned yet."
            : `${job.crewIds.length} crew assigned.`}{" "}
          {assignedEq > 0 && `${assignedEq} equipment assigned. `}Changes
          save as you tap.
        </p>
      </div>
    </>
  );
}

export default function Dashboard(
  props: Parameters<typeof DashboardLoaded>[0],
) {
  const { state } = useStore();
  if (!state) return null;
  return <DashboardLoaded {...props} />;
}

function DashboardLoaded({ crewId }: { crewId: string | null }) {
  const {
    role,
    viewer,
    setView,
    openJob,
    openEmployee,
    openCustomer,
    openEstimate,
    requestLocations,
    invoiceFromJob,
    openInvoice,
    canEdit,
    planDay,
  } = useStore();
  const state = useLoadedState();
  // Quick-assign is for owners and managers only (app role
  // owner or manager).
  const isOwner = isOwnerLike(viewer?.appRole);
  // Crew viewers see a trimmed Dashboard: their own jobs + route +
  // calendar only — no "Where is my crew", no "Hours this week",
  // no Plant Health Care panel (see the render gates below).
  const isCrew = role === "crew";
  const [assignJobId, setAssignJobId] = useState<string | null>(null);
  const showMoney = useStore().showMoney;
  const today = todayStr();
  const week = weekDates(mondayOf(today));

  const todaysJobs = state.jobs
    .filter((j) => j.date === today)
    .filter((j) => (role === "crew" && crewId ? j.crewIds.includes(crewId) : true))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Accounts waiting for approval, expiring licences and overdue
  // maintenance are lines in the To-do card (TodoCard, src/todo.ts);
  // crew still get the maintenance banner below.
  const todaysEstimates = state.estimates
    .filter((e) => e.createdDate === today)
    .sort((a, b) => b.title.localeCompare(a.title));
  const needsDay = state.estimates.filter(
    (e) =>
      e.status === "accepted" &&
      !state.jobs.some((j) => j.estimateId === e.id),
  );

  const weekHours = state.timesheets
    .filter((t) => week.includes(t.date))
    .reduce((sum, t) => sum + entryHoursNow(t), 0);

  const hoursByCrew = state.crew.map((c) => ({
    crew: c,
    hours: state.timesheets
      .filter((t) => t.crewId === c.id && week.includes(t.date))
      .reduce((sum, t) => sum + entryHoursNow(t), 0),
  }));

  const customerName = (id: string) => {
    const c = state.customers.find((x) => x.id === id);
    return c ? `${c.firstName} ${c.lastName}` : "Unknown customer";
  };
  const customerAddress = (id: string): string | null => {
    const c = state.customers.find((x) => x.id === id);
    if (!c) return null;
    if (c.type === "commercial" && c.jobSiteAddress) return c.jobSiteAddress;
    // No street address, no pin — a bare "city, ZIP" would land the
    // stop in the wrong place, so the stop stays unlocated.
    const p = primaryAddress(c);
    if (!p || !p.street.trim()) return null;
    return addressLine(p);
  };
  const assignees = (ids: string[]) =>
    ids
      .map((id) => state.crew.find((x) => x.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
  const equipmentNames = (ids: string[]) =>
    ids
      .map((id) => state.equipment.find((e) => e.id === id)?.name)
      .filter((n): n is string => Boolean(n));

  const overdue = overdueTasks(state, today);

  // Plant Health Care — renewals & due visits.
  const renewingPhc = state.phcPrograms.filter(
    (p) =>
      p.status === "active" &&
      p.renewalDate !== null &&
      p.renewalDate <= addDaysISO(today, 30),
  );
  const duePhc = state.phcPrograms.filter((p) => {
    if (p.status !== "active") return false;
    const next = state.phcVisits
      .filter((v) => v.programId === p.id && v.status === "scheduled")
      .map((v) => v.date)
      .sort()[0];
    return next !== undefined && next <= addDaysISO(today, 14);
  });

  const crewStops: DayStop[] = todaysJobs.map((j) => ({
    key: j.id,
    label: j.title,
    sub: `${j.startTime} · ${customerName(j.customerId)}`,
    lat: j.lat,
    lng: j.lng,
    address: customerAddress(j.customerId),
  }));
  const salesStops: DayStop[] = todaysEstimates.map((e) => ({
    key: e.id,
    label: e.title,
    sub: customerName(e.customerId),
    lat: null,
    lng: null,
    address: customerAddress(e.customerId),
  }));

  // "Still to invoice": done jobs from before today with no invoice
  // linked, oldest first, with the overdue flag (past the next
  // business day after the job date — a Friday job is overdue on
  // Monday). Rendered as a full-width section, not a draggable
  // square: it is a work queue, and it only shows for people who
  // can see money.
  const toInvoice = stillToInvoiceJobs(state, today);

  // "Where is my crew": everyone assigned to a job today, with their
  // last shared point (one tap = one point, never continuous
  // tracking) and the job they are on. Crew members see only their
  // own row and pin — todaysJobs is already filtered to their jobs.
  const crewTodayIds = [...new Set(todaysJobs.flatMap((j) => j.crewIds))];
  const crewLocationRows = crewTodayIds
    .map((id) => state.crew.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => {
      const last = lastLocationFor(state, c.id);
      const job = currentJobFor(state, c.id, today);
      const waiting = openRequestsFor(state, c.id).length > 0;
      return { member: c, last, job, waiting };
    });
  const crewLocationStops: DayStop[] = crewLocationRows
    .filter((r) => r.last !== null)
    .map((r) => ({
      key: r.member.id,
      label: r.member.name,
      sub:
        r.last !== null
          ? `${formatAge(r.last.recordedAt)}${r.job ? ` · On site at ${r.job.title}` : ""}`
          : "",
      lat: r.last?.lat ?? null,
      lng: r.last?.lng ?? null,
      address: null,
    }));

  // One-line summaries shown on a panel's title bar when it is collapsed.
  const todayValue = todaysJobs.reduce(
    (s, j) => s + (jobValue(state, j) ?? 0),
    0,
  );
  const salesValue = todaysEstimates.reduce(
    (s, e) => s + estimateValue(e),
    0,
  );
  const toInvoiceTotal = toInvoice.reduce(
    (s, { job }) => s + (jobValue(state, job) ?? 0),
    0,
  );
  const crewLocationShared = crewLocationRows.filter(
    (r) => r.last !== null,
  ).length;
  const phcDueCount = duePhc.filter(
    (p) => !renewingPhc.some((r) => r.id === p.id),
  ).length;

  // ---- Dashboard layout: each square can be moved, per user. ----
  // The order lives in this browser's local storage, keyed by the
  // signed-in person, so each person's layout is their own.
  // The app's shared state has no per-person settings table, so the
  // layout stays on the device.
  type PanelId =
    | "crewToday"
    | "crewLocation"
    | "salesToday"
    | "hoursWeek"
    | "crewRoute"
    | "salesStops"
    | "miniCalendar"
    | "phc";
  const PANEL_TITLES: Record<PanelId, string> = {
    crewToday: role === "crew" ? "My jobs today" : "Crew today",
    crewLocation: "Where is my crew",
    salesToday: "Sales today",
    hoursWeek: "Hours this week",
    crewRoute: "Crew route today",
    salesStops: "Sales stops today",
    miniCalendar: "Calendar",
    phc: "Plant Health Care",
  };
  const defaultLayout = (staff: boolean): PanelId[] =>
    staff
      ? [
          "crewToday",
          "crewLocation",
          "salesToday",
          "crewRoute",
          "salesStops",
          "miniCalendar",
          "phc",
        ]
      : // Crew see only their own jobs + route + calendar: no
        // "Where is my crew", no "Hours this week", no PHC panel.
        // Anyone else without money (e.g. office with money hidden)
        // keeps the old non-staff layout.
        role === "crew"
        ? ["crewToday", "crewRoute", "miniCalendar"]
        : [
            "crewToday",
            "crewLocation",
            "hoursWeek",
            "crewRoute",
            "miniCalendar",
            "phc",
          ];
  const layoutKey = `dashboard-layout-${viewer?.id ?? "shared"}`;
  const loadLayout = (staff: boolean): PanelId[] => {
    const fallback = defaultLayout(staff);
    try {
      const raw = localStorage.getItem(layoutKey);
      if (!raw) return fallback;
      const saved = JSON.parse(raw) as PanelId[];
      if (!Array.isArray(saved)) return fallback;
      const kept = saved.filter((id) => fallback.includes(id));
      for (const id of fallback) if (!kept.includes(id)) kept.push(id);
      return kept;
    } catch {
      return fallback;
    }
  };
  const [layout, setLayout] = useState<PanelId[]>(() =>
    loadLayout(showMoney),
  );
  const [customizing, setCustomizing] = useState(false);
  // Collapsed panels: same per-person localStorage as the layout
  // order, so a collapse sticks on this device, just for you.
  const collapsedKey = `dashboard-collapsed-${viewer?.id ?? "shared"}`;
  const [collapsed, setCollapsed] = useState<CollapsedPanels>(() =>
    loadCollapsedPanels(localStorage, collapsedKey),
  );
  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = toggleCollapsedPanel(prev, id);
      saveCollapsedPanels(localStorage, collapsedKey, next);
      return next;
    });
  };
  useEffect(() => {
    setLayout(loadLayout(showMoney));
    setCollapsed(loadCollapsedPanels(localStorage, collapsedKey));
    // Reload the layout when the signed-in person changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer?.id]);
  const saveLayout = (next: PanelId[]) => {
    setLayout(next);
    try {
      localStorage.setItem(layoutKey, JSON.stringify(next));
    } catch {
      // Private mode etc. — the order just won't stick.
    }
  };
  const movePanel = (id: PanelId, dir: -1 | 1) => {
    const i = layout.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= layout.length) return;
    const next = [...layout];
    [next[i], next[j]] = [next[j], next[i]];
    saveLayout(next);
  };
  // Drag and drop: the square being dragged, and the square it is over.
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const [dropId, setDropId] = useState<PanelId | null>(null);
  const movePanelTo = (id: PanelId, targetId: PanelId) => {
    if (id === targetId) return;
    const next = layout.filter((x) => x !== id);
    const idx = next.indexOf(targetId);
    if (idx < 0) return;
    next.splice(idx, 0, id);
    saveLayout(next);
  };
  const panelProps = (id: PanelId) => ({
    title: PANEL_TITLES[id],
    order: layout.indexOf(id),
    first: layout.indexOf(id) <= 0,
    last: layout.indexOf(id) === layout.length - 1,
    customizing,
    onMove: (dir: -1 | 1) => movePanel(id, dir),
    isDragging: dragId === id,
    isDropTarget: dropId === id && dragId !== null && dragId !== id,
    onGripDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      setDragId(id);
    },
    onGripDragEnd: () => {
      setDragId(null);
      setDropId(null);
    },
    onDragOverPanel: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropId(id);
    },
    onDropOnPanel: (e: React.DragEvent) => {
      e.preventDefault();
      const dragged =
        (e.dataTransfer.getData("text/plain") as PanelId) || dragId;
      if (dragged) movePanelTo(dragged, id);
      setDragId(null);
      setDropId(null);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-slate-900">
          {role === "crew" ? "My day" : "Today at a glance"}
        </h1>
        <div className="flex flex-wrap gap-2">
          {canEdit && !isCrew && (
            <button
              onClick={() => planDay(nextWorkingDay(today, state.closedDays))}
              className={`${primaryBtn()} min-h-11`}
            >
              ✨ Plan tomorrow
            </button>
          )}
          {customizing && (
            <button
              onClick={() => saveLayout(defaultLayout(showMoney))}
              className={secondaryBtn()}
            >
              Reset layout
            </button>
          )}
          <button
            onClick={() => setCustomizing((c) => !c)}
            className={secondaryBtn()}
          >
            {customizing ? "Done" : "⚙️ Customize layout"}
          </button>
        </div>
      </div>
      {/* Office staff: one To-do list gathering every attention item
          (invoice reviews, jobs with no value, accepted online, suggested
          customer changes, crew price changes, equipment problems, time
          off, week approval, held emails, overdue invoices, licences,
          overdue maintenance, accounts waiting); "Show all" opens the
          working cards. */}
      <TodoCard />
      {/* Owners and managers: "Finish setting up" (ticks itself, hides when done). */}
      <SetupChecklistCard />
      {customizing && (
        <p className="text-sm text-slate-500">
          Drag a square by its ⋮⋮ grip to move it, or use the ↑ ↓ buttons
          (the buttons also work on a phone, where dragging doesn&apos;t).
          Your layout is saved on this device, just for you.
        </p>
      )}

      {isCrew && overdue.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <p className="text-sm font-semibold text-red-800">
            ⚠ Equipment maintenance overdue: {overdue[0].task.name} —{" "}
            {overdue[0].equipment.name}
            {overdue.length > 1 ? ` + ${overdue.length - 1} more` : ""}
          </p>
          <button
            onClick={() => setView("equipment")}
            className="text-sm font-bold text-red-800 underline"
          >
            Open Equipment →
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <LayoutPanel {...panelProps("crewToday")}>
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <PanelHead
            title={role === "crew" ? "My jobs today" : "Crew today"}
            collapsed={!!collapsed.crewToday}
            onToggle={() => toggleCollapse("crewToday")}
          />
          {collapsed.crewToday ? (
            <p className="text-sm text-slate-500">
              {todaysJobs.length} job{todaysJobs.length === 1 ? "" : "s"}{" "}
              today
              {showMoney && todayValue > 0 ? ` · ${money(todayValue)}` : ""}
            </p>
          ) : (
            <>
              {todaysJobs.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing scheduled for today.
            </p>
          ) : (
            <ul className="space-y-3">
              {todaysJobs.map((j) => (
                <li key={j.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => openJob(j.id)}
                      className={`text-left font-semibold text-slate-900 hover:text-emerald-700 hover:underline`}
                    >
                      {j.title}
                    </button>
                    <span className="flex items-center gap-2">
                      {(() => {
                        const v = jobValue(state, j);
                        return v !== null && showMoney ? (
                          <span className="text-sm font-semibold text-slate-900">
                            {money(v)}
                          </span>
                        ) : null;
                      })()}
                      <StatusBadge status={j.status} />
                    </span>
                  </div>
                  <p className="text-sm text-slate-600">
                    {j.startTime} ·{" "}
                    <button
                      onClick={() => openCustomer(j.customerId)}
                      className={linkCls()}
                    >
                      {customerName(j.customerId)}
                    </button>{" "}
                    · {j.serviceType}
                  </p>
                  {isOwner ? (
                    <div className="relative">
                      <button
                        onClick={() =>
                          setAssignJobId(assignJobId === j.id ? null : j.id)
                        }
                        className="w-full rounded-lg px-1 py-0.5 text-left text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                        title="Tap to assign crew"
                      >
                        Assigned to:{" "}
                        {assignees(j.crewIds).length === 0 ? (
                          <span className="font-semibold text-amber-700">
                            Unassigned — tap to assign ✎
                          </span>
                        ) : (
                          <>
                            {assignees(j.crewIds).map((c, i) => (
                              <span key={c.id}>
                                {i > 0 && ", "}
                                {c.name}
                              </span>
                            ))}{" "}
                            <span className="text-slate-400">✎</span>
                          </>
                        )}
                      </button>
                      {assignJobId === j.id && (
                        <AssignPicker
                          job={j}
                          onClose={() => setAssignJobId(null)}
                        />
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">
                      Assigned to:{" "}
                      {assignees(j.crewIds).length === 0
                        ? "Unassigned"
                        : assignees(j.crewIds).map((c, i) => (
                            <span key={c.id}>
                              {i > 0 && ", "}
                              <button
                                onClick={() => openEmployee(c.id)}
                                className={linkCls()}
                              >
                                {c.name}
                              </button>
                            </span>
                          ))}
                    </p>
                  )}
                  {(j.equipmentIds ?? []).length > 0 && (
                    <p className="text-sm text-slate-500">
                      Equipment: {equipmentNames(j.equipmentIds ?? []).join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {showMoney && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-500">
              Crew hours this week:{" "}
              <span className="font-semibold text-slate-900">
                {weekHours.toFixed(1)} h
              </span>{" "}
              ·{" "}
              <button
                onClick={() => setView("timesheets")}
                className={linkCls()}
              >
                View timesheets →
              </button>
            </p>
          )}
            </>
          )}
        </section>
        </LayoutPanel>

        {!isCrew && (
        <LayoutPanel {...panelProps("crewLocation")}>
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <PanelHead
            title="Where is my crew"
            collapsed={!!collapsed.crewLocation}
            onToggle={() => toggleCollapse("crewLocation")}
            extra={
              showMoney && crewLocationRows.length > 0 ? (
                <button
                  onClick={() => requestLocations()}
                  className={secondaryBtn()}
                >
                  📍 Ping crew
                </button>
              ) : undefined
            }
          />
          {collapsed.crewLocation ? (
            <p className="text-sm text-slate-500">
              {crewLocationRows.length} crew · {crewLocationShared} shared
            </p>
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-500">
                A ping is a request, not live tracking — it shows here when
                they open the app and tap Share. One tap = one location
                point + time.
              </p>
              {crewLocationRows.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nobody is assigned to a job today.
            </p>
          ) : (
            <>
              <div className="dashboard-map relative z-0 isolate">
                <DayMap
                  stops={crewLocationStops}
                  emptyText="No locations shared yet — ping the crew and it shows here when they share."
                />
              </div>
              <ul className="mt-3 space-y-2">
                {crewLocationRows.map(({ member, last, job, waiting }) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0"
                  >
                    <span>
                      <button
                        onClick={() => openEmployee(member.id)}
                        className={linkCls()}
                      >
                        {member.name}
                      </button>
                      <span className="text-slate-500">
                        {" · "}
                        {last
                          ? `${formatAge(last.recordedAt)}${job ? ` · On site at ${job.title}` : " · No job today"}`
                          : waiting
                            ? "Pinged — waiting for them to share"
                            : "No location yet"}
                      </span>
                    </span>
                    {showMoney && (
                      <button
                        onClick={() => requestLocations([member.id])}
                        className="shrink-0 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-bold text-slate-700 hover:border-emerald-500"
                      >
                        Ping
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
            </>
          )}
        </section>
        </LayoutPanel>
        )}

        {showMoney ? (
          <LayoutPanel {...panelProps("salesToday")}>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <PanelHead
              title="Sales today"
              collapsed={!!collapsed.salesToday}
              onToggle={() => toggleCollapse("salesToday")}
            />
            {collapsed.salesToday ? (
              <p className="text-sm text-slate-500">
                {todaysEstimates.length} estimate
                {todaysEstimates.length === 1 ? "" : "s"}
                {salesValue > 0 ? ` · ${money(salesValue)}` : ""}
              </p>
            ) : (
              <>
                {todaysEstimates.length === 0 ? (
              <p className="text-sm text-slate-500">
                No estimates written today.
              </p>
            ) : (
              <ul className="space-y-2">
                {todaysEstimates.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2 last:border-0 last:pb-0"
                  >
                    <button
                      onClick={() => openEstimate(e.id)}
                      className="text-left"
                    >
                      <span className="block font-semibold text-slate-900 hover:text-emerald-700 hover:underline">
                        {e.title}
                      </span>
                      <span className="text-sm text-slate-500">
                        {customerName(e.customerId)} · {e.status}
                      </span>
                    </button>
                    <span className="shrink-0 text-sm font-bold text-slate-900">
                      {money(estimateValue(e))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {needsDay.length > 0 && (
              <button
                onClick={() => setView("schedule")}
                className="mt-3 text-sm font-semibold text-amber-700 hover:underline"
              >
                {needsDay.length} accepted estimate
                {needsDay.length === 1 ? "" : "s"} still need
                {needsDay.length === 1 ? "s" : ""} a day →
              </button>
            )}
              </>
            )}
          </section>
          </LayoutPanel>
        ) : !isCrew ? (
          <LayoutPanel {...panelProps("hoursWeek")}>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <PanelHead
              title="Hours this week"
              collapsed={!!collapsed.hoursWeek}
              onToggle={() => toggleCollapse("hoursWeek")}
            />
            {collapsed.hoursWeek ? (
              <p className="text-sm text-slate-500">
                {weekHours.toFixed(1)} h this week
              </p>
            ) : (
              <>
            <ul className="space-y-2">
              {hoursByCrew.map(({ crew, hours }) => (
                <li key={crew.id} className="flex justify-between text-sm">
                  <span className="text-slate-700">
                    <button
                      onClick={() => openEmployee(crew.id)}
                      className={linkCls()}
                    >
                      {crew.name}
                    </button>{" "}
                    · {crew.role}
                  </span>
                  <span className="font-semibold text-slate-900">
                    {hours.toFixed(1)} h
                  </span>
                </li>
              ))}
            </ul>
              </>
            )}
          </section>
          </LayoutPanel>
        ) : null}

        <LayoutPanel {...panelProps("crewRoute")}>
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <PanelHead
            title="Crew route today"
            collapsed={!!collapsed.crewRoute}
            onToggle={() => toggleCollapse("crewRoute")}
          />
          {collapsed.crewRoute ? (
            <p className="text-sm text-slate-500">
              {crewStops.length} stop{crewStops.length === 1 ? "" : "s"}
            </p>
          ) : (
            <>
          <div className="dashboard-map relative z-0 isolate">
            <DayMap
              stops={crewStops}
              emptyText="No crew jobs today — nothing to map."
              onOpenStop={(key) => openJob(key)}
            />
          </div>
            </>
          )}
        </section>
        </LayoutPanel>
        {showMoney ? (
          <LayoutPanel {...panelProps("salesStops")}>
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <PanelHead
              title="Sales stops today"
              collapsed={!!collapsed.salesStops}
              onToggle={() => toggleCollapse("salesStops")}
            />
            {collapsed.salesStops ? (
              <p className="text-sm text-slate-500">
                {salesStops.length} stop{salesStops.length === 1 ? "" : "s"}
              </p>
            ) : (
              <>
            <div className="dashboard-map relative z-0 isolate">
              <DayMap
                stops={salesStops}
                emptyText="No sales stops today."
                onOpenStop={(key) => openEstimate(key)}
              />
            </div>
              </>
            )}
          </section>
          </LayoutPanel>
        ) : (
          <LayoutPanel {...panelProps("miniCalendar")}>
          <MiniCalendar
            collapsed={!!collapsed.miniCalendar}
            onToggle={() => toggleCollapse("miniCalendar")}
          />
          </LayoutPanel>
        )}

        {showMoney && (
          <LayoutPanel {...panelProps("miniCalendar")}>
          <MiniCalendar
            collapsed={!!collapsed.miniCalendar}
            onToggle={() => toggleCollapse("miniCalendar")}
          />
          </LayoutPanel>
        )}
        {!isCrew && (
        <LayoutPanel {...panelProps("phc")}>
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <PanelHead
            title="Plant Health Care — renewals & due visits"
            collapsed={!!collapsed.phc}
            onToggle={() => toggleCollapse("phc")}
          />
          {collapsed.phc ? (
            <p className="text-sm text-slate-500">
              {renewingPhc.length === 0 && phcDueCount === 0
                ? "Nothing due"
                : `${renewingPhc.length} renewal${renewingPhc.length === 1 ? "" : "s"} · ${phcDueCount} visit${phcDueCount === 1 ? "" : "s"} due`}
            </p>
          ) : (
            <>
          {renewingPhc.length === 0 && duePhc.length === 0 ? (
            <p className="text-sm text-slate-500">
              No PHC renewals in the next 30 days and no visits due in the
              next 14 days.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {renewingPhc.slice(0, 4).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2"
                >
                  <button
                    onClick={() => setView("phc")}
                    className="text-left text-slate-700 hover:text-emerald-700 hover:underline"
                  >
                    {p.name} — {customerName(p.customerId)}
                  </button>
                  <span className="shrink-0 font-semibold text-slate-900">
                    Renews {p.renewalDate ? fmtDate(p.renewalDate) : "—"}
                  </span>
                </li>
              ))}
              {duePhc
                .filter((p) => !renewingPhc.some((r) => r.id === p.id))
                .slice(0, 3)
                .map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <button
                      onClick={() => setView("phc")}
                      className="text-left text-slate-700 hover:text-emerald-700 hover:underline"
                    >
                      {p.name} — {customerName(p.customerId)}
                    </button>
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                      Visit due
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <button
            onClick={() => setView("phc")}
            className="mt-3 text-sm font-semibold text-emerald-700 underline"
          >
            Open Plant Health Care →
          </button>
            </>
          )}
        </section>
        </LayoutPanel>
        )}
      </div>

      {showMoney && toInvoice.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
          <PanelHead
            title="Still to invoice"
            collapsed={!!collapsed.stillToInvoice}
            onToggle={() => toggleCollapse("stillToInvoice")}
          />
          {collapsed.stillToInvoice ? (
            <p className="text-sm text-slate-500">
              {toInvoice.length} job{toInvoice.length === 1 ? "" : "s"} ·{" "}
              {money(toInvoiceTotal)} outstanding
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-slate-500">
                Done jobs from before today with no invoice yet — oldest
                first. A job is overdue once the next business day after it
                has passed (a Friday job is overdue on Monday).
              </p>
              <ul className="space-y-2">
                {toInvoice.map(({ job, daysSince, overdue }) => (
                  <li
                    key={job.id}
                    className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                      overdue
                        ? "border-amber-300 bg-amber-50"
                        : "border-slate-200"
                    }`}
                  >
                    <button
                      onClick={() => openJob(job.id)}
                      className="text-left"
                    >
                      <span className="block font-semibold text-slate-900 hover:text-emerald-700 hover:underline">
                        {job.title}
                      </span>
                      <span className="text-sm text-slate-500">
                        {customerName(job.customerId)} · {fmtDate(job.date)} ·{" "}
                        {daysSince} day{daysSince === 1 ? "" : "s"} since done
                        {overdue ? " · overdue" : ""}
                      </span>
                    </button>
                    <span className="flex items-center gap-3">
                      {(() => {
                        const v = jobValue(state, job);
                        return v !== null ? (
                          <span className="text-sm font-semibold text-slate-900">
                            {money(v)}
                          </span>
                        ) : null;
                      })()}
                      {!isCrew && (
                        <button
                          onClick={() => {
                            if (!okToInvoiceWithOpenClock(state, job) || !okToMakeZeroInvoice(jobInvoicePricing(state, job).total)) return;
                            const id = invoiceFromJob(job.id);
                            if (id) openInvoice(id);
                          }}
                          className={secondaryBtn()}
                        >
                          Create invoice
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
