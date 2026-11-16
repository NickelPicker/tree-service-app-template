import { routeCardSpot } from "../routeCard";
import { newJobDate, nextWorkingDay } from "../jobForm";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLoadedState, useStore } from "../store";
import PlanBoard, { type BoardDraft } from "./PlanBoard";
import { defaultCalendarView, weekLabel, weekOf, type CalendarView } from "../scheduleWeek";
import { emptyCompanyProfile } from "../company";
import type { CompanyProfile, DayCrew, Estimate, Job } from "../types";
import {
  isSchedulable,
  suggestDayCrews,
  dayCrewJobs,
  crewDayJobs,
} from "../crewSuggest";
import { jobValue } from "../jobValue";
import { crewPositionText } from "../liveProgress";
import { federalHoliday } from "../holidays";
import { estimateTotals } from "../email";
import { googleMapsPinLink } from "../splits";
import { CREW_CANNOT_MOVE_JOB, CREW_ONLY_THEIR_JOBS, canDecideTimeOff as mayDecideTimeOff, isOwnerLike, mayChangeJob, mayMoveJobToDate } from "../permissions";
import {
  unavailabilityOn,
} from "../unavailability";
import {
  compareByWorkOrder,
  customerCoords,
  fmtDayShort,
  jobAddress as sharedJobAddress,
  suggestDay,
  type SuggestedDay,
} from "../scheduling";
import {
  formatMiles,
  formatMinutes,
  resolveJobCoords,
  routeLeg,
  type LegResult,
} from "../routing";
import {
  fmtDate,
  fmtDateLong,
  isClosedDay,
  isTimeOffOn,
  money,
  todayStr,
  toISODate,
  addDaysISO,
} from "../utils";
import {
  secondaryBtn,
  primaryBtn,
  MoneyInput,
  StatusBadge,
} from "./ui";
import DayMap, { type DayStop } from "./DayMap";
import DayItinerary from "./DayItinerary";
import { CompanyProfileForm, geocodeCompanySites } from "./SetupWizard";
import { runSheetUrl } from "./RunSheet";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Chips shown in a day cell before the "+N more" overflow link. */
const MAX_CHIPS = 3;

function customerShort(
  state: NonNullable<ReturnType<typeof useStore>["state"]>,
  id: string,
): string {
  const c = state.customers.find((x) => x.id === id);
  return c ? `${c.firstName} ${c.lastName}` : "Unknown";
}

/**
 * From–to date picker for marking a crew member unavailable.
 * Prefilled with the day being viewed, both ends. Saving calls
 * the store (which merges overlapping spans for the same person)
 * and closes; an end before the start is refused with an error,
 * never saved.
 */
function UnavailabilityPickerModal({
  name,
  initialFrom,
  initialTo,
  onSave,
  onDone,
}: {
  name: string;
  initialFrom: string;
  initialTo: string;
  onSave: (from: string, to: string) => void;
  onDone: () => void;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!from || !to) {
      setError("Pick a start and an end date.");
      return;
    }
    if (to < from) {
      setError("The end date can't be before the start date.");
      return;
    }
    onSave(from, to);
    onDone();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onDone}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Mark ${name} unavailable`}
      >
        <p className="text-lg font-bold text-slate-900">
          Mark {name} unavailable
        </p>
        <p className="mt-1 text-sm text-slate-600">
          They won&apos;t be suggested for jobs on any day in this
          stretch. This takes effect right away — no approval needed.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal text-slate-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => e.target.value && setTo(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal text-slate-900"
            />
          </label>
        </div>
        {error && (
          <p className="mt-2 text-xs font-semibold text-red-700">{error}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            onClick={save}
            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-800"
          >
            Mark unavailable
          </button>
          <button onClick={onDone} className={secondaryBtn()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** 42 day cells (6 Sunday-start weeks) covering the given month. */
/**
 * One short line of help with a "?" that opens the full explanation,
 * instead of long paragraphs above the calendar.
 */
function Hint({ short, children }: { short: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm text-slate-600">
      <p className="flex flex-wrap items-center gap-2">
        <span>{short}</span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Hide help" : "How this works"}
          className="inline-flex h-8 min-w-8 items-center justify-center rounded-full border border-slate-300 bg-white px-2 text-sm font-bold text-slate-600 hover:bg-slate-100"
        >
          {open ? "✕" : "?"}
        </button>
      </p>
      {open && (
        <div className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
          {children}
        </div>
      )}
    </div>
  );
}

export function monthCells(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) =>
    toISODate(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    ),
  );
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function JobChip({
  job,
  value,
  showMoney,
  dimmed,
  highlighted,
  onSelect,
  onDragStart,
  onDragEnd,
  onCrewDrop,
  onCrewHover,
}: {
  job: Job;
  value: number | null;
  showMoney: boolean;
  dimmed?: boolean;
  highlighted?: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd?: () => void;
  /** Present only while an employee chip is being dragged. */
  onCrewDrop?: () => void;
  onCrewHover?: (id: string | null) => void;
}) {
  const { state } = useStore();
  if (!state) return null;
  const assignees = state.crew.filter((c) => job.crewIds.includes(c.id));
  const dotColor = assignees[0]?.color ?? "#94a3b8";
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onDragOver={(e) => {
        if (onCrewDrop) {
          e.preventDefault();
          e.stopPropagation();
          onCrewHover?.(job.id);
        }
      }}
      onDragLeave={() => onCrewHover?.(null)}
      onDrop={(e) => {
        if (onCrewDrop) {
          e.preventDefault();
          e.stopPropagation();
          onCrewDrop();
        }
      }}
      className={`cursor-grab truncate rounded-md border px-1.5 py-1 text-left shadow-sm active:cursor-grabbing ${
        highlighted
          ? "border-emerald-500 bg-emerald-50"
          : dimmed
            ? "border-slate-200 bg-slate-100 opacity-60"
            : "border-slate-200 bg-white hover:border-emerald-500"
      }`}
      title={`${job.title}${value !== null && showMoney ? ` — ${money(value)}` : ""}`}
    >
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="truncate text-xs font-semibold leading-tight text-slate-900">
          {job.title}
        </span>
      </span>
      {value !== null && showMoney && (
        <span className="block truncate pl-3 text-[11px] font-medium leading-tight text-slate-600">
          {money(value)}
        </span>
      )}
    </div>
  );
}

/**
 * Route view: the day's jobs in start-time order (the order the crew
 * drives them), each with its address or dropped pin, crew, and
 * equipment — plus a Google Maps directions link for the whole route.
 * The order is the schedule order, not a computed shortest path: the
 * crew reorders by dragging jobs, and the route follows.
 *
 * Between consecutive stops the view shows the drive distance and
 * estimated drive time for that leg, from the OSRM public demo
 * server (real driving distance). If OSRM is unreachable the leg
 * falls back to a straight-line distance, clearly labelled as the
 * crow flies. A leg with no coordinates on either end shows as
 * unknown — never a guessed distance. The header totals the day's
 * driving distance and drive time.
 */
function RouteView({ jobs }: { jobs: Job[] }) {
  const { state, openJob } = useStore();
  const [legs, setLegs] = useState<Array<LegResult | "loading">>([]);
  const dayKey = jobs.map((j) => j.id).join(",");
  // One shared rule (see scheduling.ts): the address picked for the
  // job, else the commercial job-site address, else the primary.
  const jobAddress = (j: Job): string | null =>
    state ? sharedJobAddress(state, j) : null;
  useEffect(() => {
    let cancelled = false;
    setLegs(jobs.map(() => "loading" as const));
    (async () => {
      const coords = await Promise.all(
        jobs.map((j) => resolveJobCoords(j, jobAddress(j))),
      );
      if (cancelled) return;
      const results: LegResult[] = [];
      for (let i = 0; i < jobs.length - 1; i++) {
        const from = coords[i];
        const to = coords[i + 1];
        results.push(
          from && to ? await routeLeg(from, to) : { status: "unknown" },
        );
        if (cancelled) return;
      }
      if (!cancelled) setLegs(results);
    })();
    return () => {
      cancelled = true;
    };
    // Recompute when the day's jobs change (ids, pins, or addresses),
    // or when the store finishes loading. jobAddress reads state, so
    // the boolean dep covers the null -> loaded transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey, state === null]);
  if (!state) return null;
  if (jobs.length === 0) {
    return (
      <p className="mt-3 text-sm text-slate-500">
        No jobs this day — nothing to route.
      </p>
    );
  }
  const knownLegs = legs.filter(
    (l): l is Extract<LegResult, { status: "driving" | "straight" }> =>
      l !== "loading" && l.status !== "unknown",
  );
  const unknownLegs = legs.filter(
    (l) => l !== "loading" && l.status === "unknown",
  ).length;
  const hasStraight = knownLegs.some((l) => l.status === "straight");
  const totalMiles = knownLegs.reduce((sum, l) => sum + l.miles, 0);
  const totalMinutes = knownLegs.reduce((sum, l) => sum + l.minutes, 0);
  const stops = jobs.map((j) => {
    if (j.lat !== null && j.lng !== null) return `${j.lat},${j.lng}`;
    return jobAddress(j) ?? "";
  });
  const directionsUrl = `https://www.google.com/maps/dir/${stops
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/")}`;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm text-slate-600">
        Route order follows the schedule — earliest start first. Pin-only
        jobs (no street address) route to their dropped pin.
      </p>
      {jobs.length > 1 && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
          {knownLegs.length > 0 ? (
            <>
              Total route: {formatMiles(totalMiles)} · ~
              {formatMinutes(totalMinutes)} driving
              {hasStraight && " (includes straight-line estimates)"}
              {unknownLegs > 0 &&
                ` · plus ${unknownLegs} leg${unknownLegs > 1 ? "s" : ""} with unknown distance`}
            </>
          ) : legs.some((l) => l === "loading") ? (
            "Calculating drive distances…"
          ) : (
            "Total route distance unknown — no pins or addresses to route between."
          )}
        </p>
      )}
      <ol className="space-y-2">
        {jobs.map((j, i) => {
          const c = state.customers.find((x) => x.id === j.customerId);
          const crew = j.crewIds
            .map((id) => state.crew.find((x) => x.id === id)?.name)
            .filter(Boolean);
          const equipment = (j.equipmentIds ?? [])
            .map((id) => state.equipment.find((e) => e.id === id)?.name)
            .filter(Boolean);
          const pinLink =
            j.lat !== null && j.lng !== null
              ? googleMapsPinLink(j.lat, j.lng)
              : null;
          const address = jobAddress(j) ?? "Unknown address";
          const leg = i < jobs.length - 1 ? legs[i] : null;
          return (
            <Fragment key={j.id}>
              <li className="flex gap-3 rounded-lg border border-slate-200 bg-white p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => openJob(j.id)}
                    className="text-left text-sm font-semibold text-slate-900 hover:text-emerald-700 hover:underline"
                  >
                    {j.startTime} — {j.title}
                  </button>
                  <p className="text-sm text-slate-600">
                    {c ? `${c.firstName} ${c.lastName}` : "Unknown customer"}
                    {j.lat !== null && j.lng !== null ? " · 📍 pin only" : ""}
                  </p>
                  <p className="text-sm text-slate-500">{address}</p>
                  <p className="text-xs text-slate-500">
                    Crew: {crew.length > 0 ? crew.join(", ") : "Unassigned"}
                    {equipment.length > 0 &&
                      ` · Equipment: ${equipment.join(", ")}`}
                    {j.endDate ? ` · Multi-day to ${fmtDate(j.endDate)}` : ""}
                    {j.recurring ? ` · Recurring: ${j.recurring}` : ""}
                  </p>
                  {pinLink && (
                    <a
                      href={pinLink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold text-emerald-700 underline"
                    >
                      Open pin in Google Maps →
                    </a>
                  )}
                </div>
                <StatusBadge status={j.status} />
              </li>
              {leg && (
                <li
                  aria-label="Drive to next stop"
                  className="flex items-center gap-2 pl-4 text-sm text-slate-600"
                >
                  <span aria-hidden="true">↓</span>
                  {leg === "loading" ? (
                    <span>Calculating drive distance…</span>
                  ) : leg.status === "driving" ? (
                    <span>
                      {formatMiles(leg.miles)} · ~
                      {formatMinutes(leg.minutes)} drive to next stop
                    </span>
                  ) : leg.status === "straight" ? (
                    <span>
                      ~{formatMiles(leg.miles)} as the crow flies · ~
                      {formatMinutes(leg.minutes)} drive (estimate — no
                      road routing available)
                    </span>
                  ) : (
                    <span>
                      Distance unknown — no pin or address for one of these
                      stops
                    </span>
                  )}
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
      <a
        href={directionsUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
      >
        Open full route in Google Maps →
      </a>
    </div>
  );
}

/** First and last hour shown in the day timetable. */
const TIMETABLE_START_HOUR = 6;
const TIMETABLE_END_HOUR = 18;

function hourLabel(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}

/** Discount-aware total for an estimate (accepted option's lines when one was accepted). */
export function estimateValue(e: Estimate): number {
  const option = (e.options ?? []).find((o) => o.id === e.acceptedOptionId);
  const lines = option ? option.lines : e.lines;
  return estimateTotals(lines, e.taxRate, e.discountType, e.discountValue)
    .total;
}

/**
 * "To schedule" rail: accepted estimates with no job yet. Drag a card
 * onto a day to create its job there; click a card to see the suggested
 * day the system thinks is best, with a one-tap "Schedule it" button.
 */
export function UnscheduledPanel({
  estimates,
  state,
  suggestions,
  showMoney,
  canEdit,
  dragEstimateId,
  expandedId,
  onToggle,
  onSchedule,
  onOpenEstimate,
  onDragStart,
  onDragEnd,
}: {
  estimates: Estimate[];
  state: NonNullable<ReturnType<typeof useStore>["state"]>;
  suggestions: Record<string, SuggestedDay | null>;
  showMoney: boolean;
  canEdit: boolean;
  dragEstimateId: string | null;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onSchedule: (id: string, date: string) => void;
  onOpenEstimate: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
        To schedule
        {estimates.length > 0 && (
          <span className="rounded-full bg-emerald-700 px-2 py-0.5 text-xs font-bold text-white">
            {estimates.length}
          </span>
        )}
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Accepted estimates with no job yet. Drag one onto a day to schedule
        it, or click it to see the suggested day.
      </p>
      {estimates.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          All accepted estimates are scheduled.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {estimates.map((e) => {
            const cust = state.customers.find((c) => c.id === e.customerId);
            const v = estimateValue(e);
            const sug = suggestions[e.id];
            const expanded = expandedId === e.id;
            return (
              <li
                key={e.id}
                className={`rounded-lg border bg-white ${
                  dragEstimateId === e.id
                    ? "border-emerald-500 opacity-50"
                    : "border-slate-200"
                }`}
              >
                <div
                  draggable={canEdit}
                  onDragStart={(ev) => {
                    ev.stopPropagation();
                    onDragStart(e.id);
                  }}
                  onDragEnd={onDragEnd}
                  onClick={() => onToggle(e.id)}
                  className="cursor-grab px-3 py-2 active:cursor-grabbing"
                  title="Drag onto a day to schedule, or click for the suggested day"
                >
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {cust ? `${cust.firstName} ${cust.lastName}` : "Unknown"}
                  </p>
                  <p className="truncate text-xs text-slate-600">{e.title}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-900">
                    {showMoney ? money(v) : "Accepted"}
                    <span className="float-right font-normal text-slate-400">
                      {expanded ? "▾" : "▸"} suggested day
                    </span>
                  </p>
                </div>
                {expanded && (
                  <div className="border-t border-slate-100 px-3 py-2">
                    {state.settings.suggestDays === false ? (
                      <p className="text-xs text-slate-500">
                        Day suggestions are off — turn on &ldquo;Suggest
                        days&rdquo; in Calendar settings to see the best day.
                      </p>
                    ) : sug ? (
                      <>
                        <p className="text-sm text-slate-800">
                          Suggested day:{" "}
                          <span className="font-semibold">
                            {fmtDayShort(sug.date)}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {sug.reason}
                        </p>
                        <button
                          onClick={() => onSchedule(e.id, sug.date)}
                          className={`${secondaryBtn()} mt-2`}
                        >
                          Schedule it {fmtDayShort(sug.date)}
                        </button>
                      </>
                    ) : (
                      <p className="text-xs text-slate-500">
                        Finding the best day…
                      </p>
                    )}
                    <button
                      onClick={() => onOpenEstimate(e.id)}
                      className="ml-2 mt-2 text-xs font-semibold text-emerald-700 hover:underline"
                    >
                      Open estimate
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Day timetable: one row per hour (6 AM–6 PM), each job sitting in the
 * row its start time falls in. Drag a job card onto another hour and its
 * start time snaps to that hour, on the hour. Click an empty row to add
 * a job at that hour; right-click a row or a card for the day menu.
 * Jobs before 6 AM or after 6 PM sit in the first / last row with their
 * real start time shown on the card.
 */
function Timetable({
  date,
  jobs,
  state,
  showMoney,
  canEdit,
  canCreate,
  dragJobId,
  dragEstimateId,
  dropHour,
  onDragStartJob,
  onDropAtTime,
  onHoverHour,
  onOpenJob,
  onCreateJobAt,
  onDayMenu,
  onDragEnd,
}: {
  date: string;
  jobs: Job[];
  state: NonNullable<ReturnType<typeof useStore>["state"]>;
  showMoney: boolean;
  /** May move jobs (crew Climbers included). */
  canEdit: boolean;
  /** May add jobs and schedule estimates (staff only). */
  canCreate: boolean;
  dragJobId: string | null;
  dragEstimateId: string | null;
  dropHour: number | null;
  onDragStartJob: (id: string) => void;
  onDropAtTime: (hour: number) => void;
  onHoverHour: (hour: number | null) => void;
  onDragEnd: () => void;
  onOpenJob: (id: string) => void;
  onCreateJobAt: (hour: number) => void;
  onDayMenu: (
    e: React.MouseEvent,
    date: string,
    hour?: number | null,
    focusJobId?: string | null,
  ) => void;
}) {
  const hours: number[] = [];
  for (let h = TIMETABLE_START_HOUR; h <= TIMETABLE_END_HOUR; h++)
    hours.push(h);
  const now = new Date();
  const nowHour = now.getHours();
  const nowMinutes = now.getMinutes();
  const isToday = date === todayStr();
  const jobsForHour = (h: number) =>
    jobs.filter((j) => {
      const startHour = parseInt(j.startTime.slice(0, 2), 10);
      const clamped = Math.max(
        TIMETABLE_START_HOUR,
        Math.min(TIMETABLE_END_HOUR, startHour),
      );
      return clamped === h;
    });
  return (
    <div className="mt-3">
      {hours.map((h) => {
        const hourJobs = jobsForHour(h);
        const isDropTarget =
          dropHour === h &&
          (dragJobId !== null || dragEstimateId !== null);
        const showNowLine =
          isToday && nowHour === h && nowMinutes >= 0 && nowMinutes < 60;
        return (
          <div key={h} className="flex">
            <div className="w-14 shrink-0 pt-2 pr-2 text-right text-xs font-semibold text-slate-500">
              {hourLabel(h)}
            </div>
            <div
              onDragOver={(e) => {
                if ((dragJobId && canEdit) || (dragEstimateId && canCreate)) {
                  e.preventDefault();
                  onHoverHour(h);
                }
              }}
              onDragLeave={() => onHoverHour(null)}
              onDrop={(e) => {
                e.preventDefault();
                onDropAtTime(h);
              }}
              onContextMenu={(e) => onDayMenu(e, date, h)}
              className={`relative min-h-[56px] flex-1 space-y-1 border-t border-slate-200 px-2 py-1.5 ${
                isDropTarget
                  ? "bg-emerald-50 ring-1 ring-inset ring-emerald-500"
                  : ""
              }`}
            >
              {showNowLine && (
                <div
                  className="pointer-events-none absolute right-0 left-0 z-10 border-t-2 border-red-500"
                  style={{ top: `${(nowMinutes / 60) * 100}%` }}
                  title="Now"
                >
                  <span className="absolute -top-2 right-1 rounded bg-red-500 px-1 text-[9px] font-bold text-white">
                    Now
                  </span>
                </div>
              )}
              {hourJobs.map((j) => {
                const v = jobValue(state, j);
                const assignees = state.crew.filter((c) =>
                  j.crewIds.includes(c.id),
                );
                const cust = state.customers.find(
                  (x) => x.id === j.customerId,
                );
                return (
                  <div
                    key={j.id}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      onDragStartJob(j.id);
                    }}
                    onDragEnd={onDragEnd}
                    onClick={() => onOpenJob(j.id)}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      onDayMenu(e, date, h, j.id);
                    }}
                    className={`cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 hover:border-emerald-500 ${
                      dragJobId === j.id ? "opacity-50" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">
                        {j.startTime} · {j.title}
                      </span>
                      <span className="flex items-center gap-2">
                        {v !== null && showMoney && (
                          <span className="text-sm font-semibold text-slate-900">
                            {money(v)}
                          </span>
                        )}
                        <StatusBadge status={j.status} />
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-600">
                      {cust
                        ? `${cust.firstName} ${cust.lastName}`
                        : "Unknown"}{" "}
                      · {j.serviceType}
                      {assignees.length > 0 &&
                        ` · ${assignees.map((c) => c.name.split(" ")[0]).join(", ")}`}
                      {assignees.length === 0 && " · Unassigned"}
                    </p>
                  </div>
                );
              })}
              {hourJobs.length === 0 && canCreate && (
                <button
                  onClick={() => onCreateJobAt(h)}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-400 hover:bg-slate-50 hover:text-emerald-700"
                >
                  + Add job at {hourLabel(h)}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <p className="mt-2 pl-14 text-xs text-slate-400">
        Drag a job to another hour to change its start time. Jobs before 6
        AM or after 6 PM sit in the first or last row.
      </p>
    </div>
  );
}

/**
 * One day crew on the Schedule day detail: rename, pick members
 * (schedulable only — plus anyone already on the crew, so nobody
 * vanishes silently if their status changed), delete, and its route
 * for the day. Editing is canEdit-only; crew viewers see their own
 * crew's card read-only, with only their own stops on the route.
 */
function DayCrewCard({
  crew,
  date,
  canEdit,
  fullRoute,
}: {
  crew: DayCrew;
  date: string;
  canEdit: boolean;
  fullRoute: boolean;
}) {
  const { state, viewerId, renameDayCrew, setDayCrewMembers, deleteDayCrew } =
    useStore();
  const [name, setName] = useState(crew.name);
  if (!state) return null;
  const saveName = () => {
    const next = name.trim();
    if (next && next !== crew.name) renameDayCrew(crew.id, next);
    else setName(crew.name);
  };
  const members = state.crew.filter(
    (m) => isSchedulable(m) || crew.memberIds.includes(m.id),
  );
  const stops = fullRoute
    ? dayCrewJobs(state, date, crew.memberIds)
    : crewDayJobs(state, date, viewerId);
  // Where this crew is right now, in plain words — from job status
  // only, never a guessed location.
  const position = crewPositionText(stops);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {canEdit ? (
          <input
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-semibold"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label="Crew name"
          />
        ) : (
          <p className="text-sm font-bold text-slate-900">{crew.name}</p>
        )}
        <a
          href={runSheetUrl(date, crew.id)}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs font-semibold text-emerald-700 underline"
        >
          🖨 Print run sheet
        </a>
        {canEdit && (
          <button
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${crew.name}? Jobs keep the crew they already have.`,
                )
              )
                deleteDayCrew(crew.id);
            }}
            className="text-xs font-semibold text-red-700 underline"
          >
            Delete
          </button>
        )}
      </div>
      {canEdit ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {members.map((m) => {
            const on = crew.memberIds.includes(m.id);
            return (
              <label
                key={m.id}
                className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${
                  on
                    ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                    : "border-slate-300 bg-white text-slate-600"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = on
                      ? crew.memberIds.filter((id) => id !== m.id)
                      : [...crew.memberIds, m.id];
                    setDayCrewMembers(crew.id, next);
                  }}
                  className="h-3.5 w-3.5 accent-emerald-700"
                />
                {m.name}
              </label>
            );
          })}
        </div>
      ) : (
        <p className="mt-1 text-sm text-slate-600">
          {crew.memberIds
            .map((id) => state.crew.find((c) => c.id === id)?.name)
            .filter(Boolean)
            .join(", ") || "No members yet"}
        </p>
      )}
      {position && (
        <p className="mt-1 text-sm font-semibold text-emerald-800">
          {position}
        </p>
      )}
      <div className="mt-2">
        <DayItinerary jobs={stops} showCrew={false} showStatus />
      </div>
    </div>
  );
}

/**
 * Company details, editable after setup (owner-only): the same form
 * the first-run wizard uses, with a Save button. Saving re-places
 * any changed shop/yard addresses on the map.
 */
function CompanySettingsSection() {
  const { state, setCalendarSettings } = useStore();
  const [draft, setDraft] = useState<CompanyProfile | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!state) return null;
  const value = draft ?? state.settings.company ?? emptyCompanyProfile();
  const save = async () => {
    if (!value.name.trim()) return;
    setSaving(true);
    const { sites, warnings: w } = await geocodeCompanySites(value.sites);
    setWarnings(w);
    setCalendarSettings({
      company: {
        ...value,
        name: value.name.trim(),
        phone: value.phone.trim(),
        email: value.email.trim(),
        smsNumber: value.smsNumber.trim(),
        ownerEmail: value.ownerEmail.trim(),
        sites,
        zelleNumber: value.zelleNumber.trim(),
        checkPayee: value.checkPayee.trim(),
        checkMailingAddress: value.checkMailingAddress.trim(),
      },
    });
    setDraft(null);
    setSaving(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
  };
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <p className="text-sm font-bold text-slate-900">Company</p>
      <p className="mt-0.5 text-xs text-slate-500">
        Business name, logo, contact details, shop/yard addresses for
        clock-in, and how customers pay. This is what the header,
        estimates, invoices, and texts show.
      </p>
      <div className="mt-3">
        <CompanyProfileForm
          value={value}
          onChange={(next) => {
            setDraft(next);
            setSaved(false);
          }}
          ownerEmailLocked
          siteWarnings={warnings}
          disabled={saving}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={saving || draft === null || !value.name.trim()}
          onClick={() => void save()}
          className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save company details"}
        </button>
        {saved && (
          <span className="text-sm font-semibold text-emerald-700">
            ✓ Saved
          </span>
        )}
      </div>
    </div>
  );
}

export default function Schedule(
  props: Parameters<typeof ScheduleLoaded>[0],
) {
  const { state } = useStore();
  if (!state) return null;
  return <ScheduleLoaded {...props} />;
}

function ScheduleLoaded({ crewId }: { crewId: string | null }) {  const {
    rescheduleJob,
    moveJob,
    jobFromEstimate,
    saveJob,
    role,
    viewer,
    canEdit,
    canEditJobs,
    canSeeAllJobs,
    viewerId,
    openJob,
    openEstimate,
    createJob,
    addDayCrew,
    deleteDayCrew,
    applyDayCrewToJob,
    addUnavailabilitySpan,
    deleteUnavailabilitySpan,
    setCalendarSettings,
    decideTimeOffRequest,
    deleteTimeOffRequest,
    setClosedDay,
    removeClosedDay,
    scheduleFocusDate,
    setScheduleFocusDate,
    schedulePlanFocus,
    clearSchedulePlanFocus,
    planDay,
  } = useStore();
  const state = useLoadedState();
  const isOwner = isOwnerLike(viewer?.appRole);
  const today = todayStr();
  const todayDate = new Date();
  const [monthCursor, setMonthCursor] = useState({
    y: todayDate.getFullYear(),
    m: todayDate.getMonth(),
  });
  const [detailDate, setDetailDate] = useState(today);
  // Jump from the Dashboard mini calendar: when a focus date is set,
  // move the month cursor there, open that day's timetable, and clear it.
  useEffect(() => {
    if (!scheduleFocusDate) return;
    const d = new Date(`${scheduleFocusDate}T12:00:00`);
    setMonthCursor({ y: d.getFullYear(), m: d.getMonth() });
    setDetailDate(scheduleFocusDate);
    setScheduleFocusDate(null);
    if (schedulePlanFocus) {
      // "Plan tomorrow": open the day's Plan board and bring it into view.
      clearSchedulePlanFocus();
      if (role !== "crew") setDetailMode("plan");
      window.setTimeout(() => {
        document.getElementById("day-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  }, [scheduleFocusDate, setScheduleFocusDate, schedulePlanFocus, clearSchedulePlanFocus, role]);
  const [dragJobId, setDragJobId] = useState<string | null>(null);
  const [dragEstimateId, setDragEstimateId] = useState<string | null>(null);
  const [dragCrewId, setDragCrewId] = useState<string | null>(null);
  const [hoverJobId, setHoverJobId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  // Short-lived notice when a closed day blocks a schedule action.
  const [closedNotice, setClosedNotice] = useState<string | null>(null);
  // Clicked-open estimate in the "To schedule" rail (shows its suggested day).
  const [expandedEstimateId, setExpandedEstimateId] = useState<string | null>(
    null,
  );
  // Suggested day per unscheduled accepted estimate (async: geocoding).
  const [estimateSuggestions, setEstimateSuggestions] = useState<
    Record<string, SuggestedDay | null>
  >({});
  // Month-shift hold timer: while a job/estimate is being dragged, holding
  // over a calendar corner for half a second shifts the month.
  const monthShiftTimer = useRef<number | null>(null);
  // A job or an estimate is being dragged (the only drags that can shift months).
  const monthShiftActive = dragJobId !== null || dragEstimateId !== null;
  // Admin focus person for the my-jobs filter. Crew viewers are always
  // focused on themselves; staff can pick any employee (or Everyone).
  const [focusId, setFocusId] = useState<string>("");
  // "mine" = only the focus person's jobs; "all" = focus person's jobs
  // plus everyone else's that day (others shown muted).
  const [showMode, setShowMode] = useState<"mine" | "all">("all");
  // Inline customer popover in the day-detail list (by job row).
  const [popoverJobId, setPopoverJobId] = useState<string | null>(null);
  // Day detail mode: timetable (default), job list, or the route view.
  const [detailMode, setDetailMode] = useState<
    "jobs" | "route" | "timetable" | "plan"
  >("timetable");
  // Hour row a dragged job is hovering over in the timetable.
  const [dropHour, setDropHour] = useState<number | null>(null);
  // Right-click menu: { x, y, date, hour?, focusJobId? } — null = closed.
  const [dayMenu, setDayMenu] = useState<{
    x: number;
    y: number;
    date: string;
    hour: number | null;
    focusJobId: string | null;
  } | null>(null);
  // Right-click menu on a roster chip (owner/manager only): mark a
  // crew member unavailable for a stretch of days, or clear the span
  // covering the day being viewed. Null = closed.
  const [rosterMenu, setRosterMenu] = useState<{
    x: number;
    y: number;
    crewId: string;
  } | null>(null);
  // From–to date picker opened from the roster menu. Null = closed.
  const [unavailPicker, setUnavailPicker] = useState<{
    crewId: string;
    from: string;
    to: string;
  } | null>(null);
  // Calendar settings panel (collapsed by default).
  const [showCalSettings, setShowCalSettings] = useState(false);
  // Day the mouse is hovering, for the route preview popup.
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  // Where the hovered day sits on screen, so its route card opens next to it.
  const [hoverAnchor, setHoverAnchor] = useState<{ left: number; right: number; top: number } | null>(null);
  // Day whose route panels are pinned open with "📌 Pin route" (closed
  // with its ✕ or "Unpin"). Clicking a day only selects it.
  const [pinnedDate, setPinnedDate] = useState<string | null>(null);
  // The Plan board's unsaved plan (after ✨ Auto-fill), so the pinned
  // route shows the new crew instead of the last saved one.
  const [boardDraft, setBoardDraft] = useState<BoardDraft>(null);
  // Month grid, or the "This week" list (the default on phones).
  const [calView, setCalView] = useState<CalendarView>(() =>
    defaultCalendarView(typeof window === "undefined" ? 1024 : window.innerWidth),
  );
  // Draft for the daily-target input — committed to settings on blur, so
  // typing doesn't save on every keystroke.
  const [targetDraft, setTargetDraft] = useState(0);
  // Drafts for the suggestion-rule inputs (same blur-to-save pattern).
  const [minutesDraft, setMinutesDraft] = useState(30);
  const [milesDraft, setMilesDraft] = useState(5);
  const [overDraft, setOverDraft] = useState(0);
  useEffect(() => {
    if (!showCalSettings) {
      setTargetDraft(state?.settings.dailyTarget ?? 0);
      setMinutesDraft(state?.settings.suggestMaxMinutes ?? 30);
      setMilesDraft(state?.settings.suggestMaxMiles ?? 5);
      setOverDraft(state?.settings.suggestMaxOver ?? 0);
    }
  }, [
    showCalSettings,
    state?.settings.dailyTarget,
    state?.settings.suggestMaxMinutes,
    state?.settings.suggestMaxMiles,
    state?.settings.suggestMaxOver,
  ]);
  // Guard so a roster drag-drop doesn't also toggle focus on click.
  const justDragged = useRef(false);

  const cells = useMemo(
    () => monthCells(monthCursor.y, monthCursor.m),
    [monthCursor],
  );

  const showMoney = useStore().showMoney;

  // Crew viewers never see money totals; staff do. (This rule is
  // unchanged by the edit-permission change.)

  // The focus person: admins pick anyone (or Everyone) to focus on;
  // everyone else is focused on themselves unless they picked someone
  // from the roster (climbers and admins can do that).
  const isAdmin = isOwnerLike(role);
  // Time off: owners, managers and the office approve or deny.
  const canDecideTimeOff = mayDecideTimeOff(role);
  const effectiveFocus =
    focusId !== "" ? focusId : isAdmin ? "" : (crewId ?? "");

  const visibleJobs = (date: string) =>
    state.jobs.filter((j) => {
      if (j.date !== date) return false;
      // Which jobs a login may see in full is decided by the database
      // (a crew member gets every job on the days they work); the rest
      // of the calendar comes from calendarOnly() below.
      if (showMode === "mine" && effectiveFocus) {
        return j.crewIds.includes(effectiveFocus);
      }
      return true;
    });

  /**
   * The rest of the calendar: jobs this login can't see in full (days
   * they don't work), with calendar details only. Read-only.
   */
  const calendarOnly = (date: string) =>
    (state.calendarJobs ?? [])
      .filter((c) => c.date === date)
      .sort(compareByWorkOrder);
  const crewNames = (ids: string[]) =>
    ids.map((id) => state.crew.find((c) => c.id === id)?.name).filter(Boolean).join(", ");

  /** Day-view dimming: jobs that are not the focus person's, shown muted. */
  const isDimmed = (j: Job) =>
    showMode === "all" &&
    effectiveFocus !== "" &&
    !j.crewIds.includes(effectiveFocus);

  const chipProps = (j: Job) => ({
    dimmed: isDimmed(j),
    highlighted: hoverJobId === j.id,
    onDragEnd: () => setDragJobId(null),
    onCrewDrop: dragCrewId ? () => assignDraggedCrew(j.id) : undefined,
    onCrewHover: dragCrewId ? setHoverJobId : undefined,
  });

  /** Whether this viewer may change this job (Climbers: only their own). */
  const mayChangeThisJob = (job: Job) =>
    mayChangeJob(job, viewerId, {
      canManage: canEdit,
      canEditJobs,
      dayCrews: state.dayCrews ?? [],
    });

  /** Add the dragged employee to a job's crew (admin palette drop). */
  const assignDraggedCrew = (jobId: string) => {
    if (!canEditJobs || !dragCrewId) return;
    const job = state.jobs.find((j) => j.id === jobId);
    // Add, never replace: a job can have several people on it. Crew
    // change only the jobs they are on (see all jobs is for looking).
    if (job && !job.crewIds.includes(dragCrewId) && mayChangeThisJob(job)) {
      saveJob({ ...job, crewIds: [...job.crewIds, dragCrewId] });
    }
    setDragCrewId(null);
    setHoverJobId(null);
  };

  const clearDragState = () => {
    setDragJobId(null);
    setDragEstimateId(null);
    setDropDate(null);
    setDropHour(null);
    cancelMonthShift();
  };

  const cancelMonthShift = () => {
    if (monthShiftTimer.current !== null) {
      window.clearTimeout(monthShiftTimer.current);
      monthShiftTimer.current = null;
    }
  };

  const startMonthShift = (delta: number) => {
    // Hold half a second on a calendar corner, then shift one month.
    // The timer clears itself when it fires, so the next dragOver
    // re-arms it — holding keeps advancing month after month.
    if (monthShiftTimer.current !== null) return;
    monthShiftTimer.current = window.setTimeout(() => {
      monthShiftTimer.current = null;
      shiftMonth(delta);
    }, 500);
  };

  // If the drag ends anywhere (drop outside a target, Esc), the hold
  // timer must die with it.
  useEffect(() => {
    if (!monthShiftActive) cancelMonthShift();
  }, [monthShiftActive]);

  const dropOnDay = (date: string) => {
    // Dropping on a day: a dragged job only changes date (crew stays
    // as-is); a dragged estimate creates its job on that day at 8 AM
    // (or moves its existing job there). Read-only viewers (groundsmen)
    // cannot move or schedule anything, and only staff schedule an
    // estimate (it creates a job). A closed day only blocks the
    // public booking page — the team can still schedule here when
    // needed, with a heads-up.
    if (dragEstimateId ? !canEdit : !canEditJobs) {
      clearDragState();
      return;
    }
    const draggedJob = dragJobId ? state?.jobs.find((j) => j.id === dragJobId) : undefined;
    if (draggedJob && !mayChangeThisJob(draggedJob)) {
      setClosedNotice(CREW_ONLY_THEIR_JOBS);
      clearDragState();
      return;
    }
    if (draggedJob && !mayMoveJobToDate(role, draggedJob.date, date)) {
      setClosedNotice(CREW_CANNOT_MOVE_JOB);
      clearDragState();
      return;
    }
    if (state && isClosedDay(state.closedDays, date)) {
      setClosedNotice(
        `${fmtDateLong(date)} is marked Business closed, so the public can't book it — but the job was still scheduled.`,
      );
    }
    if (dragEstimateId) jobFromEstimate(dragEstimateId, date, "08:00");
    else if (dragJobId) rescheduleJob(dragJobId, date);
    clearDragState();
  };

  const dropJobAtTime = (hour: number) => {
    // Drop a job on a timetable hour: it lands on the day being viewed
    // at that hour, on the hour. Time only — crew stays exactly as-is.
    // A dragged estimate creates its job here at that hour instead
    // (staff only). Read-only viewers (groundsmen) cannot move jobs.
    if (dragEstimateId ? !canEdit : !canEditJobs) {
      clearDragState();
      return;
    }
    const draggedJob = dragJobId ? state?.jobs.find((j) => j.id === dragJobId) : undefined;
    if (draggedJob && !mayChangeThisJob(draggedJob)) {
      setClosedNotice(CREW_ONLY_THEIR_JOBS);
      clearDragState();
      return;
    }
    if (draggedJob && !mayMoveJobToDate(role, draggedJob.date, detailDate)) {
      setClosedNotice(CREW_CANNOT_MOVE_JOB);
      clearDragState();
      return;
    }
    if (state && isClosedDay(state.closedDays, detailDate)) {
      setClosedNotice(
        `${fmtDateLong(detailDate)} is marked Business closed, so the public can't book it — but the job was still scheduled.`,
      );
    }
    const time = `${String(hour).padStart(2, "0")}:00`;
    if (dragEstimateId) jobFromEstimate(dragEstimateId, detailDate, time);
    else if (dragJobId) moveJob(dragJobId, detailDate, time);
    clearDragState();
  };

  const openDayMenu = (
    e: React.MouseEvent,
    date: string,
    hour: number | null = null,
    focusJobId: string | null = null,
  ) => {
    // Right-click menu for a day (or a timetable row / job): add a job,
    // or edit one of the day's jobs. Never the browser's menu.
    e.preventDefault();
    setDetailDate(date);
    setDayMenu({ x: e.clientX, y: e.clientY, date, hour, focusJobId });
  };

  // Escape closes the right-click menu.
  useEffect(() => {
    if (!dayMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDayMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dayMenu]);

  const shiftMonth = (delta: number) => {
    setMonthCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const goToday = () => {
    const d = new Date();
    setMonthCursor({ y: d.getFullYear(), m: d.getMonth() });
    setDetailDate(todayStr());
  };
  // Prev / Next: a month on the grid, a week on the week list.
  const shiftView = (delta: number) => {
    if (calView === "month") {
      shiftMonth(delta);
      return;
    }
    const next = addDaysISO(detailDate, 7 * delta);
    setDetailDate(next);
    setMonthCursor({ y: Number(next.slice(0, 4)), m: Number(next.slice(5, 7)) - 1 });
  };
  const weekDays = weekOf(detailDate);

  const detailJobs = [...visibleJobs(detailDate)].sort(compareByWorkOrder);

  // Named day crews for the day being viewed. A crew member sees
  // only the crews they are on (never another crew's jobs); owners
  // and office see every crew on the day.
  const dayCrews = (state.dayCrews ?? []).filter(
    (c) => c.date === detailDate,
  );
  const visibleDayCrews = canSeeAllJobs
    ? dayCrews
    : dayCrews.filter((c) => c.memberIds.includes(viewerId));

  // Fill in the day's crews from the suggestion: replace whatever
  // crews are set for this day with the proposed chains.
  const suggestCrewsForDay = () => {
    if (!state) return;
    const suggested = suggestDayCrews(state, detailDate);
    if (suggested.length === 0) return;
    if (
      dayCrews.length > 0 &&
      !window.confirm(
        `Replace the ${dayCrews.length} crew${dayCrews.length === 1 ? "" : "s"} for this day with the suggested ${suggested.length}?`,
      )
    )
      return;
    for (const c of dayCrews) deleteDayCrew(c.id);
    for (const s of suggested) addDayCrew(detailDate, s.name, s.memberIds);
  };

  // Who is off (approved time off) on the day being viewed, and the
  // requests waiting on an owner's decision.
  const detailOff = state.crew.filter((c) =>
    isTimeOffOn(state.timeOff, c.id, detailDate),
  );
  const detailClosedDay = state.closedDays.find(
    (d) => d.date === detailDate,
  );
  const pendingTimeOff = state.timeOff
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const decidedTimeOff = state.timeOff
    .filter((r) => r.status !== "pending")
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, 10);

  // Accepted estimates with no job yet — the "To schedule" rail. (An
  // estimate marked accepted by hand never creates a job; only the
  // proposal-accept flow does, so these are the ones still waiting.)
  const unscheduledEstimates = useMemo(() => {
    if (!state) return [];
    return state.estimates.filter(
      (e) =>
        e.status === "accepted" &&
        !state.jobs.some((j) => j.estimateId === e.id),
    );
  }, [state]);

  // Compute the suggested day for each unscheduled estimate (async:
  // geocoding), so clicking a card in the rail can show it at once.
  useEffect(() => {
    if (
      !state ||
      state.settings.suggestDays === false ||
      unscheduledEstimates.length === 0
    )
      return;
    let cancelled = false;
    (async () => {
      const out: Record<string, SuggestedDay | null> = {};
      for (const e of unscheduledEstimates) {
        const cust = state.customers.find((c) => c.id === e.customerId);
        const coords = await customerCoords(cust);
        if (cancelled) return;
        out[e.id] = await suggestDay(state, estimateValue(e), coords);
        if (cancelled) return;
      }
      if (!cancelled) setEstimateSuggestions(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [state, unscheduledEstimates]);

  // Route preview popup: hovering a day previews its route; clicking a
  // day pins the popup on that day until another day is clicked (or the
  // pin is closed). While hovering, the hovered day wins; when the mouse
  // leaves, the popup falls back to the pinned day.
  // Off unless switched on in Calendar settings: the card used to pop
  // up over the calendar and stay there after a drag.
  const previewDate =
    state?.settings.hoverRoute === true ? hoverDate : null;
  const popupDate = previewDate ?? pinnedDate;
  const popupJobs = popupDate
    ? [...visibleJobs(popupDate)]
        .map((j) => {
          const d = boardDraft?.date === popupDate ? boardDraft.jobs[j.id] : undefined;
          return d ? { ...j, crewIds: d.crewIds, startTime: d.startTime ?? j.startTime } : j;
        })
        .sort(compareByWorkOrder)
    : [];
  /** Job address for the route map: the one shared rule (see scheduling.ts) — the picked address, else the commercial job-site address, else the primary. Null when there is no street address, so a bare "city, ZIP" never pins a stop in the wrong place. */
  const jobAddressFor = (j: Job): string | null =>
    state ? sharedJobAddress(state, j) : null;
  const isPinnedView =
    popupDate !== null && popupDate === pinnedDate && previewDate === null;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur">
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          {calView === "month"
            ? monthLabel(monthCursor.y, monthCursor.m)
            : weekLabel(weekDays)}
        </h1>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label="Calendar view">
            <button
              onClick={() => setCalView("week")}
              aria-pressed={calView === "week"}
              className={`min-h-10 rounded-md px-3 text-sm font-semibold ${calView === "week" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
            >
              This week
            </button>
            <button
              onClick={() => setCalView("month")}
              aria-pressed={calView === "month"}
              className={`min-h-10 rounded-md px-3 text-sm font-semibold ${calView === "month" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
            >
              Month
            </button>
          </div>
          <button
            onClick={() => shiftView(-1)}
            aria-label={calView === "month" ? "Previous month" : "Previous week"}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-base font-bold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            ← Prev
          </button>
          <button onClick={goToday} className={`${secondaryBtn()} min-h-11`}>
            Today
          </button>
          <button
            onClick={() => shiftView(1)}
            aria-label={calView === "month" ? "Next month" : "Next week"}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-base font-bold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            Next →
          </button>
          {canEdit && role !== "crew" && (
            <button
              onClick={() => planDay(nextWorkingDay(todayStr(), state?.closedDays ?? []))}
              className={`${secondaryBtn()} min-h-11`}
            >
              ✨ Plan tomorrow
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => {
                createJob(newJobDate(detailDate, todayStr(), state?.closedDays ?? []));
              }}
              className={`${primaryBtn()} min-h-11`}
            >
              + New job
            </button>
          )}
        </div>
      </div>

      {canDecideTimeOff && pendingTimeOff.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900">
          <span>
            🕓 {pendingTimeOff.length} time-off request
            {pendingTimeOff.length === 1 ? "" : "s"} waiting for you
          </span>
          <button
            onClick={() =>
              document
                .getElementById("time-off-requests")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className="min-h-11 rounded-lg bg-amber-600 px-4 text-sm font-bold text-white hover:bg-amber-700"
          >
            Review
          </button>
        </div>
      )}

      <Hint
        short={
          canEdit && role !== "crew"
            ? "Tap a job to edit · drag it to another day to move it"
            : "Tap a day to see its jobs · tap a job for details"
        }
      >
        Click a job chip to edit it in the side panel, click a day to see
        its timetable below, and click a customer name in the day list for
        their details.
        {canEdit &&
          role !== "crew" &&
          " Drag a job chip to another day to reschedule it, or to another hour in the timetable to change its start time. Right-click a day for add and edit options. Accepted estimates with no job yet sit in the To schedule list — drag one onto a day to schedule it. While dragging a job, hold it on the top-left corner for the previous month or the bottom-right corner for the next month."}{" "}
        A day holds as many jobs as needed, and a job can have several
        people on it. Use “📌 Pin route” on a day to keep its route on
        screen.
      </Hint>

      {closedNotice && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
          <span>{closedNotice}</span>
          <button
            onClick={() => setClosedNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded px-2 py-0.5 font-bold hover:bg-amber-100"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-4">
      {canEditJobs && (
        <section
          className={`${calView === "week" ? "hidden sm:block" : ""} rounded-xl border border-slate-200 bg-white p-3 shadow-sm`}
        >
          <Hint short="Team — drag a name onto a job to add them">
            Click an employee to focus the schedule on their jobs (click
            again to clear). Dropping an employee on a job adds them to
            that job&apos;s crew — a job can have several people on it.
            To remove someone, open the job and uncheck them.
            {isOwner &&
              " Right-click a name to mark someone unavailable for a stretch of days — they won't be suggested for jobs on those days. Right-click again on a day they're out to mark them available."}
          </Hint>
          <div className="mt-2 flex flex-wrap gap-2">
            {state.crew.filter(isSchedulable).map((c) => {
              // Unavailability is anchored to the day being viewed:
              // the tag follows the day, so flipping days re-marks
              // the roster for that day.
              const covering = unavailabilityOn(
                state.unavailability,
                c.id,
                detailDate,
              )[0];
              const unavailable = covering != null;
              return (
              <div
                key={c.id}
                draggable
                onDragStart={() => {
                  justDragged.current = true;
                  setDragCrewId(c.id);
                  setDragJobId(null);
                }}
                onDragEnd={() => {
                  setDragCrewId(null);
                  setHoverJobId(null);
                  window.setTimeout(() => {
                    justDragged.current = false;
                  }, 0);
                }}
                onClick={() => {
                  if (justDragged.current) {
                    justDragged.current = false;
                    return;
                  }
                  setFocusId((f) => (f === c.id ? "" : c.id));
                }}
                onContextMenu={
                  isOwner
                    ? (e) => {
                        // Owner/manager only: right-click marks
                        // someone unavailable for a stretch of
                        // days (or clears the span covering the day
                        // being viewed). Crew right-click gets no
                        // menu for this — nothing happens.
                        e.preventDefault();
                        setRosterMenu({
                          x: e.clientX,
                          y: e.clientY,
                          crewId: c.id,
                        });
                      }
                    : undefined
                }
                className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold shadow-sm ${
                  unavailable ? "opacity-50" : ""
                } ${
                  focusId === c.id
                    ? "border-emerald-600 bg-emerald-50 ring-2 ring-emerald-500"
                    : dragCrewId === c.id
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-slate-300 bg-white hover:border-emerald-500"
                }`}
                title={
                  unavailable
                    ? `${c.name} is unavailable ${fmtDate(covering.startDate)} – ${fmtDate(covering.endDate)} — right-click to mark them available again`
                    : `Click to focus on ${c.name}'s jobs; drag onto a job to assign ${c.name}${isOwner ? "; right-click to mark unavailable" : ""}`
                }
              >
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                {c.name} · {c.role}
                {unavailable && (
                  <span className="text-xs font-bold text-amber-700">
                    🚫 Unavailable
                  </span>
                )}
              </div>
              );
            })}
          </div>
        </section>
      )}

      {(isAdmin || effectiveFocus !== "" || focusId !== "") && (
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        {isAdmin && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <span className="font-semibold">Focus person</span>
            <select
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={focusId}
              onChange={(e) => setFocusId(e.target.value)}
            >
              <option value="">Everyone</option>
              {state.crew.filter(isSchedulable).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {effectiveFocus !== "" && (
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
            <button
              onClick={() => setShowMode("mine")}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${showMode === "mine" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
            >
              My jobs only
            </button>
            <button
              onClick={() => setShowMode("all")}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${showMode === "all" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
            >
              My jobs + others that day
            </button>
          </div>
        )}
        {effectiveFocus !== "" && showMode === "all" && (
          <p className="text-xs text-slate-500">
            Your jobs show in full color; everyone else&apos;s jobs that
            day are muted gray.
          </p>
        )}
        {focusId !== "" && (
          <button onClick={() => setFocusId("")} className={secondaryBtn()}>
            Clear focus
          </button>
        )}
      </section>
      )}

      {calView === "week" ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="This week">
          <ul className="divide-y divide-slate-100">
            {weekDays.map((day) => {
              const jobs = [...visibleJobs(day)].sort(compareByWorkOrder);
              const others = calendarOnly(day);
              const off = state.crew
                .filter((c) => isTimeOffOn(state.timeOff, c.id, day))
                .map((c) => c.name);
              const closed = state.closedDays.some((d) => d.date === day);
              return (
                <li key={day} className={day === detailDate ? "bg-emerald-50/50" : ""}>
                  <button
                    onClick={() => {
                      setDetailDate(day);
                      document
                        .getElementById("day-panel")
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 px-4 py-2 text-left"
                  >
                    <span className="font-bold text-slate-900">
                      {fmtDateLong(day)}
                      {day === today && (
                        <span className="ml-2 rounded-full bg-emerald-700 px-2 py-0.5 text-xs font-bold text-white">
                          Today
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-slate-600">
                      {closed
                        ? "Closed"
                        : jobs.length + others.length === 0
                          ? "No jobs"
                          : `${jobs.length + others.length} job${jobs.length + others.length === 1 ? "" : "s"}`}
                    </span>
                  </button>
                  {off.length > 0 && (
                    <p className="px-4 pb-1 text-sm text-amber-800">Off: {off.join(", ")}</p>
                  )}
                  {(jobs.length > 0 || others.length > 0) && (
                    <ul className="space-y-1 px-2 pb-2">
                      {jobs.map((j) => (
                        <li key={j.id}>
                          <button
                            onClick={() => openJob(j.id)}
                            className={`flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2 text-left ${
                              isDimmed(j) || j.status === "done"
                                ? "border-slate-200 bg-slate-100 opacity-70"
                                : "border-slate-200 bg-white hover:border-emerald-500"
                            }`}
                          >
                            <span className="w-12 shrink-0 text-sm font-bold text-slate-900">
                              {j.startTime}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-slate-900">
                                {j.title}
                                {j.status === "done" ? " · Done" : ""}
                              </span>
                              <span className="block truncate text-sm text-slate-600">
                                {customerShort(state, j.customerId)}
                                {j.crewIds.length > 0 ? ` · ${crewNames(j.crewIds)}` : " · No crew yet"}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                      {others.map((c) => (
                        <li
                          key={c.id}
                          className="flex min-h-11 items-start gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
                        >
                          <span className="w-12 shrink-0 font-bold">{c.startTime}</span>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{c.title}</span>
                            <span className="block truncate text-slate-500">
                              {c.crewIds.length ? crewNames(c.crewIds) : "No crew yet"}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
      <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="px-1.5 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((date) => {
            const inMonth =
              parseInt(date.slice(5, 7), 10) === monthCursor.m + 1;
            const isToday = date === today;
            const jobs = visibleJobs(date);
            const shown = jobs.slice(0, MAX_CHIPS);
            const extra = jobs.length - shown.length;
            const dayNum = parseInt(date.slice(8, 10), 10);
            const dayTotal = jobs.reduce(
              (s, j) => s + (jobValue(state, j) ?? 0),
              0,
            );
            const target = state.settings.dailyTarget ?? 0;
            const dayFull = target > 0 && dayTotal >= target;
            const closedDay = state.closedDays.find((d) => d.date === date);
            const closed = closedDay !== undefined;
            const offNames = state.crew
              .filter((c) => isTimeOffOn(state.timeOff, c.id, date))
              .map((c) => c.name);
            return (
              <div
                key={date}
                onClick={() => setDetailDate(date)}
                onContextMenu={(e) => openDayMenu(e, date)}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setHoverAnchor({ left: r.left, right: r.right, top: r.top });
                  setHoverDate(date);
                }}
                onMouseLeave={() => setHoverDate(null)}
                onDragOver={(e) => {
                  if (dragJobId || dragEstimateId) {
                    e.preventDefault();
                    setDropDate(date);
                  }
                }}
                onDragLeave={() => setDropDate(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setHoverDate(null);
                  dropOnDay(date);
                }}
                className={`min-h-[104px] cursor-pointer border-b border-r border-slate-100 p-1 align-top last:border-r-0 ${
                  dropDate === date
                    ? "bg-emerald-50 ring-1 ring-inset ring-emerald-500"
                    : closed
                      ? "bg-slate-200/70"
                      : detailDate === date
                        ? "bg-emerald-50/50"
                        : inMonth
                          ? "bg-white hover:bg-slate-50"
                          : "bg-slate-50/60"
                }`}
              >
                <div className="mb-1 flex justify-center">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      isToday
                        ? "bg-emerald-700 text-white"
                        : inMonth
                          ? "text-slate-800"
                          : "text-slate-400"
                    }`}
                  >
                    {dayNum}
                  </span>
                </div>
                {closed && (
                  <div
                    className="mb-1 truncate rounded-md bg-slate-700 px-1.5 py-0.5 text-center text-[11px] font-bold text-white"
                    title={
                      closedDay?.reason
                        ? `Business closed — ${closedDay.reason}`
                        : "Business closed"
                    }
                  >
                    🚫 Business closed
                  </div>
                )}
                {(() => {
                  const holiday = federalHoliday(date);
                  return holiday ? (
                    <div
                      className="mb-1 truncate rounded-md bg-red-100 px-1.5 py-0.5 text-center text-[11px] font-bold text-red-800"
                      title={`Federal holiday — ${holiday}`}
                    >
                      🇺🇸 {holiday}
                    </div>
                  ) : null;
                })()}
                <div className="space-y-1">
                  {shown.map((j) => (
                    <JobChip
                      key={j.id}
                      job={j}
                      value={jobValue(state, j)}
                      showMoney={showMoney}
                      {...chipProps(j)}
                      onSelect={() => openJob(j.id)}
                      onDragStart={() => setDragJobId(j.id)}
                      onDragEnd={clearDragState}
                    />
                  ))}
                  {calendarOnly(date)
                    .slice(0, Math.max(0, MAX_CHIPS - shown.length))
                    .map((c) => (
                      <div
                        key={c.id}
                        title={`${c.startTime} ${c.title} · ${c.serviceType}${c.crewIds.length ? ` · ${crewNames(c.crewIds)}` : ""}${c.area ? ` · ${c.area}` : ""}`}
                        className="truncate rounded-md border border-dashed border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500"
                      >
                        {c.startTime} {c.title}
                      </div>
                    ))}
                  {extra + Math.max(0, calendarOnly(date).length - Math.max(0, MAX_CHIPS - shown.length)) > 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailDate(date);
                      }}
                      className="block w-full truncate px-1.5 py-0.5 text-left text-[11px] font-semibold text-emerald-700 hover:underline"
                    >
                      +{extra + Math.max(0, calendarOnly(date).length - Math.max(0, MAX_CHIPS - shown.length))} more
                    </button>
                  )}
                </div>
                {offNames.length > 0 && (
                  <div className="mt-1 truncate px-1.5 text-[11px] font-semibold text-amber-700">
                    🏖️ {offNames.join(", ")} off
                  </div>
                )}
                {state.settings.showDayTotals !== false &&
                  showMoney &&
                  jobs.length > 0 && (
                    <div
                      className={`mt-1 border-t border-slate-100 pt-1 text-center text-[11px] ${
                        dayFull
                          ? "font-bold text-red-600"
                          : "font-semibold text-slate-500"
                      }`}
                    >
                      {money(dayTotal)}
                      {dayFull ? " · Full" : ""}
                    </div>
                  )}
              </div>
            );
          })}
        </div>
        {monthShiftActive && (
          <>
            <div
              className="absolute left-0 top-0 z-30 flex h-20 w-20 items-center justify-center rounded-br-2xl bg-emerald-700/90 text-center text-xs font-bold text-white shadow-lg"
              onDragOver={(e) => {
                e.preventDefault();
                startMonthShift(-1);
              }}
              onDragLeave={cancelMonthShift}
              onDrop={(e) => {
                e.preventDefault();
                clearDragState();
              }}
              title="Hold a dragged job here half a second to go to the previous month"
            >
              <span>
                <span className="block">‹ Prev</span>
                <span className="block">month</span>
              </span>
            </div>
            <div
              className="absolute bottom-0 right-0 z-30 flex h-20 w-20 items-center justify-center rounded-tl-2xl bg-emerald-700/90 text-center text-xs font-bold text-white shadow-lg"
              onDragOver={(e) => {
                e.preventDefault();
                startMonthShift(1);
              }}
              onDragLeave={cancelMonthShift}
              onDrop={(e) => {
                e.preventDefault();
                clearDragState();
              }}
              title="Hold a dragged job here half a second to go to the next month"
            >
              <span>
                <span className="block">Next</span>
                <span className="block">month ›</span>
              </span>
            </div>
          </>
        )}
      </div>
      )}

      <section id="day-panel" className="scroll-mt-24 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-slate-900">
            {fmtDateLong(detailDate)}
            {detailDate === today && " · Today"}
          </h2>
          <div className="flex flex-wrap gap-2">
            <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
              <button
                onClick={() => setDetailMode("timetable")}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${detailMode === "timetable" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
              >
                Timetable
              </button>
              <button
                onClick={() => setDetailMode("jobs")}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${detailMode === "jobs" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
              >
                Jobs
              </button>
              <button
                onClick={() => setDetailMode("route")}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${detailMode === "route" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
              >
                Route
              </button>
              {role !== "crew" && (
                <button
                  onClick={() => setDetailMode("plan")}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${detailMode === "plan" ? "bg-emerald-700 text-white" : "text-slate-700"}`}
                >
                  ✨ Plan
                </button>
              )}
            </div>
            {detailJobs.length > 0 && (
              <button
                onClick={() =>
                  setPinnedDate((p) => (p === detailDate ? null : detailDate))
                }
                aria-pressed={pinnedDate === detailDate}
                className={`${secondaryBtn()} hidden lg:inline-block`}
                title="Keep this day's route and map on screen while you work"
              >
                {pinnedDate === detailDate ? "📌 Unpin route" : "📌 Pin route"}
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => {
                  createJob(detailDate);
                }}
                className={secondaryBtn()}
              >
                + New job this day
              </button>
            )}
          </div>
        </div>
        {detailOff.length > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Off this day: {detailOff.map((c) => c.name).join(", ")} — approved
            time off. Don&apos;t schedule them here.
          </p>
        )}
        {detailClosedDay && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-white">
            <span>
              🚫 Business closed
              {detailClosedDay.reason ? ` — ${detailClosedDay.reason}` : ""}.
              The public can&apos;t book this day — the team can still
              schedule here when needed.
            </span>
            {isOwner && (
              <button
                onClick={() => removeClosedDay(detailDate)}
                className="rounded-md bg-white px-3 py-1 text-sm font-bold text-slate-800 hover:bg-slate-100"
              >
                Reopen this day
              </button>
            )}
          </div>
        )}
        {(() => {
          const holiday = federalHoliday(detailDate);
          return holiday ? (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">
              🇺🇸 {holiday} — federal holiday. Suggestions skip this day.
            </p>
          ) : null;
        })()}
        {detailMode === "plan" && role !== "crew" ? (
          <PlanBoard date={detailDate} onDraft={setBoardDraft} />
        ) : detailMode === "timetable" ? (
          <Timetable
            date={detailDate}
            jobs={detailJobs}
            state={state}
            showMoney={showMoney}
            canEdit={canEditJobs}
            canCreate={canEdit}
            dragJobId={dragJobId}
            dragEstimateId={dragEstimateId}
            dropHour={dropHour}
            onDragStartJob={(id) => setDragJobId(id)}
            onDropAtTime={dropJobAtTime}
            onHoverHour={setDropHour}
            onOpenJob={openJob}
            onCreateJobAt={(h) =>
              createJob(detailDate, `${String(h).padStart(2, "0")}:00`)
            }
            onDayMenu={openDayMenu}
            onDragEnd={clearDragState}
          />
        ) : detailMode === "route" ? (
          <div className="mt-3 space-y-3">
            <RouteView jobs={detailJobs} />
            {/* The map, in the page flow so it shows on phones too — the
                pinned panel on the right is desktop-only. */}
            <DayMap
              stops={detailJobs.map((j) => ({
                key: j.id,
                label: customerShort(state, j.customerId),
                sub: `${j.startTime} · ${j.title}`,
                lat: j.lat,
                lng: j.lng,
                address: jobAddressFor(j),
              }))}
              emptyText="No map locations yet — add an address to the customer or drop a pin on the job."
              onOpenStop={(key) => openJob(key)}
              ordinals
              showList={false}
            />
          </div>
        ) : detailJobs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No jobs this day. {canEdit && "Add one with the button above."}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {detailJobs.map((j) => {
              const v = jobValue(state, j);
              const assignees = state.crew.filter((c) =>
                j.crewIds.includes(c.id),
              );
              const cust = state.customers.find(
                (x) => x.id === j.customerId,
              );
              return (
                <li
                  key={j.id}
                  className={`rounded-lg border hover:border-emerald-500 ${
                    // Done jobs stay visible, dimmed, so the office
                    // can see what is finished and what is left.
                    isDimmed(j) || j.status === "done"
                      ? "border-slate-200 bg-slate-100 opacity-70"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  <button
                    onClick={() => openJob(j.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-3 pt-2 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">
                        {j.startTime} · {j.title}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {v !== null && showMoney && (
                        <span className="text-sm font-semibold text-slate-900">
                          {money(v)}
                        </span>
                      )}
                      <StatusBadge status={j.status} />
                    </span>
                  </button>
                  <p className="truncate px-3 pb-2 text-xs text-slate-600">
                    <button
                      onClick={() =>
                        setPopoverJobId((p) => (p === j.id ? null : j.id))
                      }
                      className="font-semibold text-emerald-700 hover:underline"
                      title="Show customer details"
                    >
                      {customerShort(state, j.customerId)}
                    </button>
                    {" · "}
                    {j.serviceType} ·{" "}
                    {assignees.length === 0
                      ? "Unassigned"
                      : assignees.map((c) => c.name).join(", ")}
                  </p>
                  {canEditJobs && visibleDayCrews.length > 0 && mayChangeThisJob(j) && (
                    <div className="px-3 pb-2">
                      <label className="flex items-center gap-2 text-xs text-slate-600">
                        Apply crew:
                        <select
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800"
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              applyDayCrewToJob(j.id, e.target.value);
                          }}
                        >
                          <option value="">Choose a crew…</option>
                          {visibleDayCrews.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.memberIds.length})
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {popoverJobId === j.id && cust && (
                    <div className="mx-3 mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-sm font-bold text-slate-900">
                        {cust.firstName} {cust.lastName}
                        {cust.company ? ` · ${cust.company}` : ""}
                      </p>
                      <p className="mt-1 text-sm text-slate-700">
                        {cust.phone || "No phone on file"}
                      </p>
                      <p className="text-sm text-slate-700">
                        {cust.address}, {cust.city} {cust.zip}
                      </p>
                      {cust.gateCode && (
                        <p className="text-sm text-slate-700">
                          Gate code: {cust.gateCode}
                        </p>
                      )}
                      {cust.propertyNotes && (
                        <p className="mt-1 text-sm text-slate-600">
                          {cust.propertyNotes}
                        </p>
                      )}
                      <div className="mt-3">
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Current + upcoming jobs
                        </p>
                        {(() => {
                          const custJobs = state.jobs
                            .filter(
                              (x) =>
                                x.customerId === cust.id &&
                                (x.date >= today || x.status === "in_progress"),
                            )
                            .sort(
                              (a, b) =>
                                a.date.localeCompare(b.date) ||
                                a.startTime.localeCompare(b.startTime),
                            );
                          if (custJobs.length === 0) {
                            return (
                              <p className="text-sm text-slate-500">
                                No current jobs.
                              </p>
                            );
                          }
                          return (
                            <ul className="space-y-1">
                              {custJobs.map((x) => {
                                const xv = jobValue(state, x);
                                return (
                                  <li key={x.id}>
                                    <button
                                      onClick={() => {
                                        setPopoverJobId(null);
                                        openJob(x.id);
                                      }}
                                      className="flex w-full items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-left text-sm hover:border-emerald-500"
                                    >
                                      <span className="min-w-0">
                                        <span className="block truncate font-semibold text-slate-900">
                                          {x.title}
                                        </span>
                                        <span className="text-xs text-slate-500">
                                          {fmtDate(x.date)} · {x.startTime} ·{" "}
                                          {x.serviceType}
                                        </span>
                                      </span>
                                      {xv !== null && showMoney && (
                                        <span className="shrink-0 font-semibold text-slate-900">
                                          {money(xv)}
                                        </span>
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          );
                        })()}
                      </div>
                      <button
                        onClick={() => setPopoverJobId(null)}
                        className="mt-2 text-xs font-semibold text-emerald-700 hover:underline"
                      >
                        Close details
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {calendarOnly(detailDate).length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <h3 className="text-sm font-bold text-slate-900">Other jobs this day</h3>
            <p className="text-xs text-slate-500">
              Calendar view: full details (customer, address, notes) appear on days you work.
            </p>
            <ul className="mt-2 space-y-1.5">
              {calendarOnly(detailDate).map((c) => (
                <li
                  key={c.id}
                  className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
                >
                  <span className="font-semibold">
                    {c.startTime} {c.title}
                  </span>{" "}
                  · {c.serviceType}
                  {c.area ? ` · ${c.area}` : ""}
                  <span className="block text-xs text-slate-500">
                    {c.crewIds.length ? `Crew: ${crewNames(c.crewIds)}` : "No crew assigned yet"}
                    {c.status !== "scheduled" ? ` · ${c.status === "in_progress" ? "In progress" : "Done"}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The old crew groups; the Plan board replaces them on the Plan tab. */}
        {detailMode !== "plan" && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-900">
              Crews — who goes where today
            </h3>
            {canEdit && (
              <span className="flex gap-2">
                <button
                  onClick={suggestCrewsForDay}
                  className={secondaryBtn()}
                >
                  ✨ Suggest crews
                </button>
                <button
                  onClick={() =>
                    addDayCrew(detailDate, `Crew ${dayCrews.length + 1}`, [])
                  }
                  className={secondaryBtn()}
                >
                  + New crew
                </button>
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Crews are groups for the day — applying a crew to a job sets
            that job&apos;s crew to the group&apos;s members.
          </p>
          {visibleDayCrews.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No crews set for this day yet.
              {canEdit &&
                " Tap “Suggest crews” to split the day into two routes, or add one by hand."}
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {visibleDayCrews.map((c) => (
                <DayCrewCard
                  key={c.id}
                  crew={c}
                  date={detailDate}
                  canEdit={canEdit}
                  fullRoute={canSeeAllJobs}
                />
              ))}
            </div>
          )}
        </div>
        )}
      </section>

      {/* Company settings: owners and managers only (the database
          refuses settings changes from anyone else). */}
      {isOwner && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <button
            onClick={() => setShowCalSettings((s) => !s)}
            className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
          >
            <span className="text-sm font-bold text-slate-900">
              Calendar settings
              <span className="ml-2 font-normal text-slate-500">
                {state.settings.dailyTarget > 0
                  ? `Daily target ${money(state.settings.dailyTarget)}`
                  : "No daily target set"}
                {state.settings.suggestDays !== false
                  ? " · Suggesting days"
                  : " · Suggestions off"}
              </span>
            </span>
            <span className="text-sm font-semibold text-emerald-700">
              {showCalSettings ? "Hide ▲" : "Show ▼"}
            </span>
          </button>
          {showCalSettings && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-semibold text-slate-700">
                  Daily target — booked $ per day
                </label>
                <div
                  className="mt-1"
                  onBlur={() => {
                    if (targetDraft !== (state.settings.dailyTarget ?? 0)) {
                      setCalendarSettings({ dailyTarget: targetDraft });
                    }
                  }}
                >
                  <MoneyInput
                    value={targetDraft}
                    onChange={setTargetDraft}
                    placeholder="3000"
                  />
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Once a day&apos;s booked total reaches this, the total at
                  the bottom of the day turns red — the day is full. Leave
                  it at $0 for no target.
                </p>
              </div>
              <div className="space-y-3">
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={state.settings.suggestDays !== false}
                    onChange={(e) =>
                      setCalendarSettings({ suggestDays: e.target.checked })
                    }
                  />
                  <span>
                    <span className="font-semibold">
                      Suggest days for approved estimates
                    </span>
                    <br />
                    <span className="text-xs text-slate-500">
                      When an estimate is approved, suggest the best day by
                      room under the daily target and driving distance to
                      the other jobs that day.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={state.settings.hoverRoute === true}
                    onChange={(e) =>
                      setCalendarSettings({ hoverRoute: e.target.checked })
                    }
                  />
                  <span>
                    <span className="font-semibold">
                      Hover a day to preview its route
                    </span>
                    <br />
                    <span className="text-xs text-slate-500">
                      Shows the day&apos;s route next to the day while the
                      mouse is over it.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={state.settings.showDayTotals !== false}
                    onChange={(e) =>
                      setCalendarSettings({ showDayTotals: e.target.checked })
                    }
                  />
                  <span>
                    <span className="font-semibold">
                      Show the booked total at the bottom of each day
                    </span>
                    <br />
                    <span className="text-xs text-slate-500">
                      Turn off to hide the $ totals from the calendar cells.
                    </span>
                  </span>
                </label>
              </div>
              {state.settings.suggestDays !== false && (
              <div className="mt-4 border-t border-slate-100 pt-3 sm:col-span-2">
                <p className="text-sm font-semibold text-slate-700">
                  Suggestion rules — a day only counts when all three hold
                </p>
                <div className="mt-2 space-y-2">
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={
                        state.settings.suggestSkipWeekends !== false
                      }
                      onChange={(e) =>
                        setCalendarSettings({
                          suggestSkipWeekends: e.target.checked,
                        })
                      }
                    />
                    <span>
                      <span className="font-semibold">
                        Never suggest a weekend
                      </span>
                      <br />
                      <span className="text-xs text-slate-500">
                        Saturdays and Sundays are skipped when picking a day.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={
                        state.settings.suggestSkipHolidays !== false
                      }
                      onChange={(e) =>
                        setCalendarSettings({
                          suggestSkipHolidays: e.target.checked,
                        })
                      }
                    />
                    <span>
                      <span className="font-semibold">
                        Never suggest a federal holiday
                      </span>
                      <br />
                      <span className="text-xs text-slate-500">
                        Federal holidays are skipped too, and marked 🇺🇸 on
                        the calendar.
                      </span>
                    </span>
                  </label>
                </div>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="text-sm text-slate-700">
                      Within{" "}
                      <span className="font-semibold">__ minutes</span>{" "}
                      drive of another job that day
                    </label>
                    <input
                      type="number"
                      min={0}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                      value={minutesDraft}
                      onChange={(e) =>
                        setMinutesDraft(
                          Math.max(0, Number(e.target.value) || 0),
                        )
                      }
                      onBlur={() => {
                        if (
                          minutesDraft !==
                          (state.settings.suggestMaxMinutes ?? 30)
                        ) {
                          setCalendarSettings({
                            suggestMaxMinutes: minutesDraft,
                          });
                        }
                      }}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      0 = no drive-time limit.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700">
                      Within{" "}
                      <span className="font-semibold">__ miles</span> of
                      another job that day
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                      value={milesDraft}
                      onChange={(e) =>
                        setMilesDraft(
                          Math.max(0, Number(e.target.value) || 0),
                        )
                      }
                      onBlur={() => {
                        if (
                          milesDraft !==
                          (state.settings.suggestMaxMiles ?? 5)
                        ) {
                          setCalendarSettings({
                            suggestMaxMiles: milesDraft,
                          });
                        }
                      }}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      0 = no distance limit. Road miles, not as-the-crow-flies.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-slate-700">
                      May exceed the daily target by up to{" "}
                      <span className="font-semibold">$__</span>
                    </label>
                    <div
                      className="mt-1"
                      onBlur={() => {
                        if (
                          overDraft !== (state.settings.suggestMaxOver ?? 0)
                        ) {
                          setCalendarSettings({ suggestMaxOver: overDraft });
                        }
                      }}
                    >
                      <MoneyInput
                        value={overDraft}
                        onChange={setOverDraft}
                        placeholder="0"
                      />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      $0 = the target is a hard cap.
                    </p>
                  </div>
                </div>
              </div>
              )}
              {isAdmin && <CompanySettingsSection />}
            </div>
          )}
        </section>
      )}

      {canDecideTimeOff && state.timeOff.length > 0 && (
        <section
          id="time-off-requests"
          className="scroll-mt-24 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <h2 className="text-base font-bold text-slate-900">
            Time off requests
          </h2>
          {pendingTimeOff.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">
              No requests waiting on a decision.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {pendingTimeOff.map((r) => {
                const person = state.crew.find((c) => c.id === r.crewId);
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
                  >
                    <span className="text-sm text-slate-800">
                      <span className="font-semibold">
                        {person?.name ?? "Crew"}
                      </span>
                      {" · "}
                      {fmtDateLong(r.startDate)}
                      {r.endDate !== r.startDate &&
                        ` – ${fmtDateLong(r.endDate)}`}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </span>
                    <span className="flex gap-2">
                      <button
                        onClick={() =>
                          decideTimeOffRequest(r.id, "approved")
                        }
                        className={primaryBtn()}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() =>
                          decideTimeOffRequest(r.id, "denied")
                        }
                        className={secondaryBtn()}
                      >
                        Deny
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {decidedTimeOff.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3">
              {decidedTimeOff.map((r) => {
                const person = state.crew.find((c) => c.id === r.crewId);
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
                  >
                    <span className="text-sm text-slate-700">
                      <span className="font-semibold">
                        {person?.name ?? "Crew"}
                      </span>
                      {" · "}
                      {fmtDate(r.startDate)}
                      {r.endDate !== r.startDate &&
                        ` – ${fmtDate(r.endDate)}`}
                      {" · "}
                      <span
                        className={
                          r.status === "approved"
                            ? "font-semibold text-emerald-700"
                            : "font-semibold text-red-700"
                        }
                      >
                        {r.status === "approved" ? "Approved" : "Denied"}
                      </span>
                      {r.decidedBy ? ` by ${r.decidedBy}` : ""}
                    </span>
                    <span className="flex gap-2">
                      {r.status === "approved" && (
                        <button
                          onClick={() =>
                            decideTimeOffRequest(r.id, "denied")
                          }
                          className="text-xs font-semibold text-slate-500 underline"
                        >
                          Revoke approval
                        </button>
                      )}
                      {r.status === "denied" && (
                        <button
                          onClick={() => deleteTimeOffRequest(r.id)}
                          className="text-xs font-semibold text-slate-500 underline"
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}


        </div>

        {/* The "To schedule" rail is office work, not crew work: crew
            members never see the list of accepted estimates waiting
            for a job. Owners and office (including the estimator) keep it. */}
        {role !== "crew" && (
          <aside className="w-full shrink-0 self-start lg:sticky lg:top-4 lg:w-80">
            <UnscheduledPanel
              estimates={unscheduledEstimates}
              state={state}
              suggestions={estimateSuggestions}
              showMoney={showMoney}
              canEdit={canEdit}
              dragEstimateId={dragEstimateId}
              expandedId={expandedEstimateId}
              onToggle={(id) =>
                setExpandedEstimateId((p) => (p === id ? null : id))
              }
              onSchedule={(id, date) => jobFromEstimate(id, date, "08:00")}
              onOpenEstimate={openEstimate}
              onDragStart={setDragEstimateId}
              onDragEnd={clearDragState}
            />
          </aside>
        )}
      </div>

      {popupDate && popupJobs.length > 0 && (
        <div
          style={
            !isPinnedView && hoverAnchor
              ? routeCardSpot(hoverAnchor, window.innerWidth, window.innerHeight)
              : undefined
          }
          className={`fixed left-4 top-24 z-40 max-h-[70vh] w-[min(92vw,380px)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl ${
            isPinnedView ? "pointer-events-auto" : "pointer-events-none"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-bold text-slate-900">
              Route · {fmtDayShort(popupDate)}
              {isPinnedView && " · Pinned"}
              {boardDraft?.date === popupDate && " · unsaved plan"}
            </p>
            {isPinnedView && (
              <button
                onClick={() => setPinnedDate(null)}
                aria-label="Close pinned route"
                className="shrink-0 rounded-md px-2 py-0.5 text-sm font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                ✕
              </button>
            )}
          </div>
          <RouteView jobs={popupJobs} />
        </div>
      )}

      {isPinnedView && popupDate && popupJobs.length > 0 && (
        <div className="fixed right-4 top-24 z-40 hidden w-[min(92vw,440px)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl lg:block">
          <div className="mb-3 flex items-start justify-between gap-2">
            <p className="text-sm font-bold text-slate-900">
              Route map · {fmtDayShort(popupDate)}
            </p>
            <button
              onClick={() => setPinnedDate(null)}
              aria-label="Close route map"
              className="shrink-0 rounded-md px-2 py-0.5 text-sm font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              ✕
            </button>
          </div>
          <DayMap
            stops={
              popupJobs.map((j): DayStop => ({
                key: j.id,
                label: j.title,
                sub: `${j.startTime} · ${
                  state ? customerShort(state, j.customerId) : "Unknown"
                }`,
                lat: j.lat,
                lng: j.lng,
                address: jobAddressFor(j),
              })) as DayStop[]
            }
            emptyText="No jobs this day — nothing to map."
            onOpenStop={(key) => openJob(key)}
            ordinals
            showList={false}
          />
        </div>
      )}

      {dayMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setDayMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setDayMenu(null);
            }}
          />
          <div
            className="fixed z-50 w-64 rounded-xl border border-slate-200 bg-white py-1 shadow-2xl"
            style={{
              left: Math.min(dayMenu.x, window.innerWidth - 272),
              top: Math.min(dayMenu.y, window.innerHeight - 240),
            }}
            role="menu"
          >
            <p className="border-b border-slate-100 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {fmtDateLong(dayMenu.date)}
            </p>
            {canEdit && (
              <button
                onClick={() => {
                  setDayMenu(null);
                  createJob(
                    dayMenu.date,
                    dayMenu.hour !== null
                      ? `${String(dayMenu.hour).padStart(2, "0")}:00`
                      : undefined,
                  );
                }}
                className="block w-full px-3 py-2 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
              >
                + Add job
                {dayMenu.hour !== null
                  ? ` at ${hourLabel(dayMenu.hour)}`
                  : ""}
              </button>
            )}
            {isOwner && (
              <>
                {isClosedDay(state.closedDays, dayMenu.date) ? (
                  <button
                    onClick={() => {
                      removeClosedDay(dayMenu.date);
                      setDayMenu(null);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    ↺ Reopen this day
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setClosedDay(dayMenu.date, null);
                      setDayMenu(null);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    🚫 Mark business closed
                  </button>
                )}
              </>
            )}
            {visibleJobs(dayMenu.date)
              .sort(compareByWorkOrder)
              .map((j) => (
                <button
                  key={j.id}
                  onClick={() => {
                    setDayMenu(null);
                    openJob(j.id);
                  }}
                  className={`block w-full truncate px-3 py-2 text-left text-sm text-slate-800 hover:bg-slate-50 ${
                    dayMenu.focusJobId === j.id ? "font-bold" : ""
                  }`}
                >
                  Edit · {j.startTime} {j.title}
                </button>
              ))}
            {visibleJobs(dayMenu.date).length === 0 && (
              <p className="px-3 py-2 text-sm text-slate-500">
                No jobs this day.
              </p>
            )}
          </div>
        </>
      )}

      {rosterMenu &&
        (() => {
          const member = state.crew.find(
            (c) => c.id === rosterMenu.crewId,
          );
          if (!member) return null;
          // The span covering the day being viewed, if any — the
          // menu is anchored to that day, so "Mark available"
          // clears exactly the span that day sits in (the whole
          // span, not just that day).
          const covering = unavailabilityOn(
            state.unavailability,
            member.id,
            detailDate,
          )[0];
          return (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setRosterMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRosterMenu(null);
                }}
              />
              <div
                className="fixed z-50 w-64 rounded-xl border border-slate-200 bg-white py-1 shadow-2xl"
                style={{
                  left: Math.min(rosterMenu.x, window.innerWidth - 272),
                  top: Math.min(rosterMenu.y, window.innerHeight - 240),
                }}
                role="menu"
              >
                <p className="border-b border-slate-100 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {member.name}
                </p>
                {covering ? (
                  <>
                    <p className="px-3 py-2 text-sm text-slate-600">
                      Unavailable {fmtDate(covering.startDate)} –{" "}
                      {fmtDate(covering.endDate)}
                    </p>
                    <button
                      onClick={() => {
                        deleteUnavailabilitySpan(covering.id);
                        setRosterMenu(null);
                      }}
                      className="block w-full px-3 py-2 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                    >
                      ✅ Mark available
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setUnavailPicker({
                        crewId: member.id,
                        from: detailDate,
                        to: detailDate,
                      });
                      setRosterMenu(null);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    🚫 Mark unavailable…
                  </button>
                )}
              </div>
            </>
          );
        })()}

      {unavailPicker &&
        (() => {
          const member = state.crew.find(
            (c) => c.id === unavailPicker.crewId,
          );
          if (!member) return null;
          return (
            <UnavailabilityPickerModal
              name={member.name}
              initialFrom={unavailPicker.from}
              initialTo={unavailPicker.to}
              onSave={(from, to) =>
                addUnavailabilitySpan(member.id, from, to)
              }
              onDone={() => setUnavailPicker(null)}
            />
          );
        })()}

    </div>
  );
}
