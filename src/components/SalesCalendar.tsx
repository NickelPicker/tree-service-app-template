import { useEffect, useMemo, useRef, useState } from "react";
import { clearHandoff, handedSalesBookings } from "../viewHandoff";
import { showFlash } from "../flash";
import { useStore } from "../store";
import { addDaysISO, fmtDate, fmtDateLong, money, todayStr } from "../utils";
import { estimateValue, monthCells, monthLabel } from "./Schedule";
import { primaryBtn, secondaryBtn } from "./ui";
import { bookingMatches, customerDisplayName, salesQueue } from "../salesQueue";
import {
  movedVisit,
  visitChipLabel,
  visitsByDay,
  visitsOnDay,
} from "../salesCalendar";
import DayMap from "./DayMap";
import { addressLine, bookedAddressDiffers, primaryAddress } from "../addresses";
import {
  customerCoords,
  fmtDayShort,
  formatVisitTime,
  suggestDay,
  suggestEstimateTime,
  visitSlotOptions,
  type SuggestedVisitTime,
} from "../scheduling";
import { federalHoliday, isWeekend } from "../holidays";
import type { BookingRequest, Estimate } from "../types";
import { MONTH_NAMES, phcServicesForMonth } from "../phcSchedule";
import { briefingKeyFor, PhcBriefingModal } from "./PhcBriefing";
import VisitPicker from "./VisitPicker";
import CreateEstimateForm from "./CreateEstimateForm";
import { MyRecentSuggestionsCard } from "./CustomerSuggestions";
import {
  defaultCalendarView,
  weekLabel,
  weekOf,
  type CalendarView,
} from "../scheduleWeek";
import { estimateStatusLabel } from "../estimateStatus";

/**
 * Sales tab — the Sales calendar (first sub-tab for the office and
 * owners; the Sales tab of anyone whose job title is "Sales", crew
 * login or not). It looks and works like the Schedule page's month
 * calendar, but holds the estimator's ESTIMATE VISITS only (owner
 * decision: visits are not on the Schedule calendar, crew
 * jobs are not here):
 * - month grid (Prev / Today / Next) with each day's visits as chips
 *   in time order ("9:30 · Smith — oak removal"), a count, today
 *   highlighted; phones start on a "This week" list like Schedule;
 * - "Create estimate" (header, each day, the day panel): type the
 *   customer's name — an existing customer autofills, a new one is
 *   filled in and added — optional visit day/time, then straight into
 *   writing the estimate (CreateEstimateForm);
 * - drag a chip to another day to move the visit (keep the time or
 *   pick another); tap a chip to open the estimate;
 * - a day panel with that day's visits in time order and the route map;
 * - folded under the calendar: "Needs a visit" (drafts with no visit,
 *   with a suggested slot) and online booking requests.
 * Data rules: src/salesCalendar.ts; slot rules: src/scheduling.ts.
 * The office, owners/managers and Sales people may add and move
 * visits (`canSell`; database: is_sales_person).
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_CHIPS = 3;

interface VisitSuggestion {
  date: string;
  time: SuggestedVisitTime | null;
}

/** "Move to …": keep the time, or pick another (the old one may be taken). */
function MoveVisitDialog({
  estimate,
  date,
  label,
  onClose,
}: {
  estimate: Estimate;
  date: string;
  label: string;
  onClose: () => void;
}) {
  const { state, setEstimateVisit } = useStore();
  const taken = new Set(
    state
      ? visitsOnDay(state.estimates, date)
          .filter((v) => v.id !== estimate.id)
          .map((v) => v.visitTime)
      : [],
  );
  const keepFree = !!estimate.visitTime && !taken.has(estimate.visitTime);
  const firstFree = visitSlotOptions().find((t) => !taken.has(t)) ?? "";
  const [time, setTime] = useState(keepFree ? (estimate.visitTime as string) : firstFree);
  const move = (t: string | null) => {
    const next = movedVisit(estimate, date, t);
    setEstimateVisit(estimate.id, next.visitDate, next.visitTime);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Move visit">
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 shadow-xl">
        <p className="text-base font-bold text-slate-900">Move visit</p>
        <p className="text-sm text-slate-700">
          {label} → <b>{fmtDateLong(date)}</b>
        </p>
        {keepFree ? (
          <button onClick={() => move(null)} className={`${primaryBtn()} w-full`}>
            Keep {formatVisitTime(estimate.visitTime as string)}
          </button>
        ) : (
          estimate.visitTime && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {formatVisitTime(estimate.visitTime)} is already booked that day — pick another time.
            </p>
          )
        )}
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm font-semibold text-slate-700">
            {keepFree ? "Or a new time" : "New time"}
            <select
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            >
              {visitSlotOptions().map((t) => (
                <option key={t} value={t} disabled={taken.has(t)}>
                  {formatVisitTime(t)}
                  {taken.has(t) ? " (booked)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => move(time)}
            disabled={!time || taken.has(time)}
            className={keepFree ? secondaryBtn() : primaryBtn()}
          >
            Move
          </button>
        </div>
        <button onClick={onClose} className={`${secondaryBtn()} w-full`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function SalesCalendar() {
  const {
    state,
    canEdit,
    canSell,
    openEstimate,
    decideBookingRequest,
    deleteBookingRequest,
    setEstimateVisit,
  } = useStore();
  const today = todayStr();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [calView, setCalView] = useState<CalendarView>(() =>
    defaultCalendarView(typeof window === "undefined" ? 1024 : window.innerWidth),
  );
  const [weekStart, setWeekStart] = useState(() => weekOf(today)[0]);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);
  // "Create estimate" form: open with this day as the visit day ("" = no day).
  const [createFor, setCreateFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; date: string } | null>(null);
  const [visitSuggestions, setVisitSuggestions] = useState<
    Record<string, VisitSuggestion>
  >({});
  const [manualPickId, setManualPickId] = useState<string | null>(null);
  const [changingVisitId, setChangingVisitId] = useState<string | null>(null);
  // The Dashboard To-do opens Sales with Booking requests open.
  const [bookingsOpen] = useState(() => handedSalesBookings());
  const bookingsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (bookingsOpen) bookingsRef.current?.scrollIntoView({ block: "start" });
    clearHandoff();
  }, [bookingsOpen]);

  const now = new Date();
  const thisMonth = now.getMonth() + 1;
  const phcThisMonth = useMemo(
    () => phcServicesForMonth(thisMonth),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const phcTreatCount = phcThisMonth.filter(
    (s) => s.kind === "chemical" && !s.doNotSell,
  ).length;

  // Morning PHC briefing: pop up once the first time the Sales page is
  // opened each day, so the estimator remembers which pests to quote this month.
  useEffect(() => {
    if (phcTreatCount === 0) return;
    try {
      const key = briefingKeyFor(today);
      if (localStorage.getItem(key) !== "shown") {
        setBriefingOpen(true);
      }
    } catch {
      // No localStorage (private mode, etc.) — show it anyway.
      setBriefingOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeBriefing = () => {
    try {
      localStorage.setItem(briefingKeyFor(today), "shown");
    } catch {
      // Ignore storage failures; the pop-up just shows again next visit.
    }
    setBriefingOpen(false);
  };

  const cells = useMemo(() => monthCells(cursor.y, cursor.m), [cursor]);
  const weekDays = useMemo(() => weekOf(weekStart), [weekStart]);
  const showMoney = useStore().showMoney;
  const queue = useMemo(() => (state ? salesQueue(state) : null), [state]);
  const needsVisit = useMemo(
    () => queue?.draftEstimates.filter((e) => !e.visitDate) ?? [],
    [queue],
  );
  const byDay = useMemo(
    () => (state ? visitsByDay(state.estimates, [...cells, ...weekDays]) : new Map<string, Estimate[]>()),
    [state, cells, weekDays],
  );
  const dayVisits = useMemo(
    () => (state ? visitsOnDay(state.estimates, selectedDate) : []),
    [state, selectedDate],
  );

  // Suggested day + half-hour time for every draft with no visit
  // booked (same async geocoding pattern as the Schedule page's rail).
  useEffect(() => {
    if (!state || needsVisit.length === 0) {
      setVisitSuggestions({});
      return;
    }
    let cancelled = false;
    (async () => {
      const out: Record<string, VisitSuggestion> = {};
      for (const e of needsVisit) {
        const cust = state.customers.find((c) => c.id === e.customerId);
        const coords = await customerCoords(cust);
        if (cancelled) return;
        const day = await suggestDay(state, estimateValue(e), coords);
        if (cancelled) return;
        if (!day) continue;
        let date = day.date;
        let time = await suggestEstimateTime(state, date, coords);
        if (cancelled) return;
        for (let k = 1; k <= 3 && !time; k++) {
          const d = addDaysISO(day.date, k);
          if (state.closedDays.some((x) => x.date === d)) continue;
          if ((state.settings.suggestSkipWeekends ?? true) && isWeekend(d))
            continue;
          if (
            (state.settings.suggestSkipHolidays ?? true) &&
            federalHoliday(d) !== null
          )
            continue;
          const t = await suggestEstimateTime(state, d, coords);
          if (cancelled) return;
          if (t) {
            date = d;
            time = t;
          }
        }
        out[e.id] = { date, time };
      }
      if (!cancelled) setVisitSuggestions(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [state, needsVisit]);

  if (!state || !queue) return null;

  const customerOf = (id: string) => state.customers.find((x) => x.id === id);
  const customerShort = (id: string) => {
    const c = customerOf(id);
    return c ? customerDisplayName(c) : "Unknown";
  };
  const chipLabel = (e: Estimate) => visitChipLabel(e, customerOf(e.customerId));

  /** Address a visit routes to: commercial job-site, else primary. */
  const estimateAddress = (e: Estimate): string | null => {
    const c = customerOf(e.customerId);
    if (!c) return null;
    if (c.type === "commercial" && c.jobSiteAddress) return c.jobSiteAddress;
    const primary = primaryAddress(c);
    if (!primary || primary.street.trim() === "") return null;
    return addressLine(primary);
  };

  const shift = (delta: number) => {
    if (calView === "week") {
      setWeekStart((w) => addDaysISO(w, delta * 7));
      return;
    }
    setCursor((p) => {
      const d = new Date(p.y, p.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };
  const goToday = () => {
    const d = new Date();
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setWeekStart(weekOf(today)[0]);
    setSelectedDate(today);
  };
  const openDay = (date: string) => {
    setSelectedDate(date);
    document
      .getElementById("sales-day-panel")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const dropOn = (date: string) => {
    const id = dragId;
    setDragId(null);
    setDropDate(null);
    if (!id || !canSell) return;
    const e = state.estimates.find((x) => x.id === id);
    if (!e || e.visitDate === date || !mayMoveVisit(e)) return;
    setMoving({ id, date });
  };
  const movingEstimate = moving
    ? state.estimates.find((e) => e.id === moving.id) ?? null
    : null;
  const pendingBookings = queue.bookingRequests.filter((r) => r.status === "pending");
  const matchesFor = (r: BookingRequest) =>
    r.status === "pending" && state ? bookingMatches(state.customers, r) : [];
  const accept = (r: BookingRequest, customerId?: string) => {
    const estimateId = decideBookingRequest(r.id, "accepted", customerId ? { customerId } : undefined);
    if (!estimateId) return;
    showFlash(`Draft estimate made for ${r.name || "the customer"}. They asked for ${fmtDate(r.date)}: book the visit under Needs a visit.`, {
      actions: [{ label: "Open estimate", run: () => openEstimate(estimateId) }],
    });
  };

  // A Sales crew login may only move visits on drafts (the database
  // refuses the rest); the office may move any open estimate's visit.
  const mayMoveVisit = (e: Estimate) => canSell && (canEdit || e.status === "draft");
  const visitChip = (e: Estimate) => (
    <div
      key={e.id}
      draggable={mayMoveVisit(e)}
      onDragStart={(ev) => {
        ev.stopPropagation();
        ev.dataTransfer.setData("text/plain", e.id);
        setDragId(e.id);
      }}
      onDragEnd={() => {
        setDragId(null);
        setDropDate(null);
      }}
      onClick={(ev) => {
        ev.stopPropagation();
        openEstimate(e.id);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") openEstimate(e.id);
      }}
      className={`truncate rounded-md border px-1.5 py-1 text-left text-xs font-semibold leading-tight shadow-sm ${
        mayMoveVisit(e) ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      } ${
        e.status === "draft"
          ? "border-slate-200 bg-white text-slate-900 hover:border-emerald-500"
          : "border-emerald-200 bg-emerald-50 text-emerald-900"
      }`}
      title={`${formatVisitTime(e.visitTime ?? "00:00")} · ${customerShort(e.customerId)} — ${e.title}${e.status !== "draft" ? ` (${estimateStatusLabel(e.status)})` : ""}${estimateAddress(e) ? ` · ${estimateAddress(e)}` : ""}`}
    >
      {chipLabel(e)}
    </div>
  );

  const addButton = (date: string, compact: boolean | "row") =>
    canSell && date >= today ? (
      <button
        onClick={(ev) => {
          ev.stopPropagation();
          setCreateFor(date);
        }}
        aria-label={`Add customer visit on ${fmtDateLong(date)}`}
        title="Add customer visit"
        className={
          compact === true
            ? "rounded px-1 text-sm font-bold leading-none text-emerald-700 hover:bg-emerald-100"
            : "min-h-11 min-w-11 rounded-lg border border-emerald-300 px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
        }
      >
        {compact === true ? "+" : compact === "row" ? "+ Add" : "+ Add customer visit"}
      </button>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur">
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Sales ·{" "}
          {calView === "month" ? monthLabel(cursor.y, cursor.m) : weekLabel(weekDays)}
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
            onClick={() => shift(-1)}
            aria-label={calView === "month" ? "Previous month" : "Previous week"}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-base font-bold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            ← Prev
          </button>
          <button onClick={goToday} className={`${secondaryBtn()} min-h-11`}>
            Today
          </button>
          <button
            onClick={() => shift(1)}
            aria-label={calView === "month" ? "Next month" : "Next week"}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-base font-bold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            Next →
          </button>
          {canSell && (
            <button onClick={() => setCreateFor("")} className={`${primaryBtn()} min-h-11`}>
              + Create estimate
            </button>
          )}
        </div>
      </div>

      {phcTreatCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 shadow-sm">
          <p className="text-sm text-emerald-900">
            <span className="font-bold">
              🌿 {MONTH_NAMES[thisMonth - 1]} PHC: {phcTreatCount} treatment
              {phcTreatCount === 1 ? "" : "s"} in season
            </span>{" "}
            — quote them while the window is open.
          </p>
          <button onClick={() => setBriefingOpen(true)} className={secondaryBtn()}>
            See today&apos;s briefing
          </button>
        </div>
      )}
      {briefingOpen && <PhcBriefingModal onClose={closeBriefing} />}

      {createFor !== null && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8" role="dialog" aria-label="Create estimate">
          <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-slate-900">
                Create estimate
                {createFor ? ` · visit ${fmtDateLong(createFor)}` : ""}
              </h2>
              <button onClick={() => setCreateFor(null)} aria-label="Close" className="rounded-lg px-2 py-1 text-lg font-bold text-slate-500 hover:bg-slate-100">
                ✕
              </button>
            </div>
            <CreateEstimateForm
              key={createFor}
              initialDate={createFor || null}
              onClose={() => setCreateFor(null)}
            />
          </div>
        </div>
      )}

      {movingEstimate && moving && (
        <MoveVisitDialog
          estimate={movingEstimate}
          date={moving.date}
          label={chipLabel(movingEstimate)}
          onClose={() => setMoving(null)}
        />
      )}

      {calView === "week" ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="This week">
          <ul className="divide-y divide-slate-100">
            {weekDays.map((day) => {
              const visits = byDay.get(day) ?? [];
              return (
                <li key={day} className={day === selectedDate ? "bg-emerald-50/50" : ""}>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                    <button onClick={() => openDay(day)} className="min-h-11 flex-1 text-left">
                      <span className="font-bold text-slate-900">
                        {fmtDateLong(day)}
                        {day === today && (
                          <span className="ml-2 rounded-full bg-emerald-700 px-2 py-0.5 text-xs font-bold text-white">
                            Today
                          </span>
                        )}
                      </span>
                      <span className="ml-2 text-sm text-slate-600">
                        {visits.length === 0
                          ? "No visits"
                          : `${visits.length} visit${visits.length === 1 ? "" : "s"}`}
                      </span>
                    </button>
                    {addButton(day, "row")}
                  </div>
                  {visits.length > 0 && (
                    <ul className="space-y-1 px-2 pb-2">
                      {visits.map((e) => (
                        <li key={e.id}>
                          <button
                            onClick={() => openEstimate(e.id)}
                            className="flex min-h-11 w-full items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-emerald-500"
                          >
                            <span className="w-16 shrink-0 text-sm font-bold text-slate-900">
                              {formatVisitTime(e.visitTime ?? "00:00")}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-slate-900">
                                {customerShort(e.customerId)}
                                {e.status !== "draft" ? ` · ${estimateStatusLabel(e.status)}` : ""}
                              </span>
                              <span className="block truncate text-sm text-slate-600">
                                {e.title}
                                {estimateAddress(e) ? ` · ${estimateAddress(e)}` : ""}
                              </span>
                            </span>
                          </button>
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
              <div key={d} className="px-1.5 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((date) => {
              const inMonth = parseInt(date.slice(5, 7), 10) === cursor.m + 1;
              const isToday = date === today;
              const visits = byDay.get(date) ?? [];
              const shown = visits.slice(0, MAX_CHIPS);
              const extra = visits.length - shown.length;
              const closed = state.closedDays.some((d) => d.date === date);
              const holiday = federalHoliday(date);
              return (
                <div
                  key={date}
                  data-date={date}
                  onClick={() => setSelectedDate(date)}
                  onDragOver={(e) => {
                    if (dragId) {
                      e.preventDefault();
                      setDropDate(date);
                    }
                  }}
                  onDragLeave={() => setDropDate(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(date);
                  }}
                  className={`group min-h-[104px] cursor-pointer border-b border-r border-slate-100 p-1 align-top ${
                    dropDate === date
                      ? "bg-emerald-50 ring-1 ring-inset ring-emerald-500"
                      : closed
                        ? "bg-slate-200/70"
                        : selectedDate === date
                          ? "bg-emerald-50/50"
                          : inMonth
                            ? "bg-white hover:bg-slate-50"
                            : "bg-slate-50/60"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="w-5">
                      {visits.length > 0 && (
                        <span className="rounded-full bg-emerald-700 px-1.5 text-[10px] font-bold text-white" title={`${visits.length} visit${visits.length === 1 ? "" : "s"}`}>
                          {visits.length}
                        </span>
                      )}
                    </span>
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                        isToday ? "bg-emerald-700 text-white" : inMonth ? "text-slate-800" : "text-slate-400"
                      }`}
                    >
                      {parseInt(date.slice(8, 10), 10)}
                    </span>
                    <span className="flex w-5 justify-end">{addButton(date, true)}</span>
                  </div>
                  {holiday && (
                    <div className="mb-1 truncate rounded-md bg-red-100 px-1.5 py-0.5 text-center text-[11px] font-bold text-red-800" title={`Federal holiday — ${holiday}`}>
                      {holiday}
                    </div>
                  )}
                  <div className="space-y-1">
                    {shown.map(visitChip)}
                    {extra > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openDay(date);
                        }}
                        className="block w-full truncate px-1.5 py-0.5 text-left text-[11px] font-semibold text-emerald-700 hover:underline"
                      >
                        +{extra} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="text-xs text-slate-500">
        Estimate visits only — crew jobs are on the Schedule page. Tap a
        visit to open the estimate{canSell ? ", drag it to another day to move it, or press + on a day to add a customer visit" : ""}.
      </p>

      {/* Day panel: the selected day's visits in time order + route map. */}
      <section id="sales-day-panel" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-slate-900">
            {fmtDateLong(selectedDate)}
            <span className="ml-2 text-sm font-medium text-slate-500">
              {dayVisits.length} visit{dayVisits.length === 1 ? "" : "s"}
            </span>
          </h2>
          {addButton(selectedDate, false)}
        </div>
        {dayVisits.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No estimate visits this day.</p>
        ) : (
          <>
            <ul className="mt-3 space-y-2">
              {dayVisits.map((e) => (
                <li key={e.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button onClick={() => openEstimate(e.id)} className="min-w-0 text-left" title="Open estimate">
                      <span className="block text-sm font-semibold text-slate-900 hover:underline">
                        {formatVisitTime(e.visitTime ?? "00:00")} · {customerShort(e.customerId)}
                        {e.status !== "draft" ? ` · ${estimateStatusLabel(e.status)}` : ""}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {e.title}
                        {estimateAddress(e) ? ` · ${estimateAddress(e)}` : ""}
                        {showMoney && estimateValue(e) > 0 ? ` · ${money(estimateValue(e))}` : ""}
                      </span>
                    </button>
                    {canSell && e.status === "draft" && (
                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => setChangingVisitId(changingVisitId === e.id ? null : e.id)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                          title="Change this visit's day and time"
                        >
                          {changingVisitId === e.id ? "Close" : "Change"}
                        </button>
                        <button
                          onClick={() => setEstimateVisit(e.id, null, null)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                          title="Clear this visit — back to Needs a visit"
                        >
                          Clear visit
                        </button>
                      </div>
                    )}
                  </div>
                  {changingVisitId === e.id && (
                    <VisitPicker
                      estimate={e}
                      initialDate={e.visitDate ?? null}
                      initialTime={e.visitTime ?? null}
                      onDone={() => setChangingVisitId(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <DayMap
                stops={dayVisits.map((e) => {
                  const c = customerOf(e.customerId);
                  return {
                    key: e.id,
                    label: customerShort(e.customerId),
                    sub: `${formatVisitTime(e.visitTime ?? "00:00")} · ${e.title}`,
                    lat: c?.mapLat ?? null,
                    lng: c?.mapLng ?? null,
                    address: estimateAddress(e),
                  };
                })}
                emptyText="No map locations yet — add an address to the customer."
                onOpenStop={(key) => openEstimate(key)}
                ordinals
                showList={false}
              />
            </div>
          </>
        )}
      </section>

      {/* Folded lists: drafts with no visit yet, and online booking requests. */}
      <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <summary className="cursor-pointer text-base font-bold text-slate-900">
          Needs a visit{" "}
          <span className="rounded-full bg-emerald-700 px-2 py-0.5 text-xs font-bold text-white">
            {needsVisit.length}
          </span>
        </summary>
        <p className="mt-1 text-xs text-slate-500">
          Draft estimates with no visit booked — two visits an hour, on the
          half hour, 8 AM–5 PM.
        </p>
        {needsVisit.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">All drafts have a visit booked.</p>
        ) : (
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {needsVisit.map((e) => {
              const sug = visitSuggestions[e.id];
              return (
                <li key={e.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <button onClick={() => openEstimate(e.id)} className="block w-full truncate text-left text-sm font-semibold text-slate-900 hover:underline">
                    {customerShort(e.customerId)}
                  </button>
                  <p className="truncate text-xs text-slate-600">
                    {e.title}
                    {showMoney ? ` · ${money(estimateValue(e))}` : ""}
                  </p>
                  {!sug ? (
                    <p className="mt-1 text-xs text-slate-500">Finding a time…</p>
                  ) : sug.time ? (
                    <>
                      <p className="mt-1 text-sm text-slate-800">
                        Suggested:{" "}
                        <span className="font-semibold">
                          {fmtDayShort(sug.date)}, {formatVisitTime(sug.time.time)}
                        </span>
                      </p>
                      {canSell && (
                        <button
                          onClick={() => setEstimateVisit(e.id, sug.date, sug.time!.time)}
                          className="mt-2 mr-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-800"
                        >
                          Schedule it
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-slate-500">
                      No free slot on {fmtDayShort(sug.date)} or the next few days.
                    </p>
                  )}
                  {canSell && (
                    <button
                      onClick={() => setManualPickId(manualPickId === e.id ? null : e.id)}
                      className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      {manualPickId === e.id ? "Close picker" : "Pick a day & time"}
                    </button>
                  )}
                  {manualPickId === e.id && (
                    <VisitPicker
                      estimate={e}
                      initialDate={sug?.date ?? null}
                      initialTime={sug?.time?.time ?? null}
                      onDone={() => setManualPickId(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </details>

      {queue.bookingRequests.length > 0 && (
        <details
          ref={bookingsRef}
          open={bookingsOpen || undefined}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <summary className="cursor-pointer text-base font-bold text-slate-900">
            Booking requests{" "}
            <span className="text-sm font-medium text-slate-500">({pendingBookings.length} waiting)</span>
          </summary>
          <ul className="mt-3 space-y-3">
            {queue.bookingRequests.map((r) => (
              <li key={r.id} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-slate-900">
                    {r.name} · {fmtDate(r.date)}
                    <span className="ml-2 text-sm font-medium text-slate-500">
                      {r.phone}
                      {r.email ? ` · ${r.email}` : ""}
                    </span>
                  </p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                      r.status === "pending"
                        ? "bg-amber-100 text-amber-800"
                        : r.status === "accepted"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {r.address}
                  {r.details ? ` — ${r.details}` : ""}
                </p>
                {r.status === "pending" && canEdit && matchesFor(r).length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
                    <p className="font-semibold">Looks like a customer you already have:</p>
                    <ul className="mt-1 space-y-1">
                      {matchesFor(r).map((m) => (
                        <li key={m.customer.id} className="flex flex-wrap items-center gap-2">
                          <span>
                            {customerDisplayName(m.customer)} ({m.reasons.join(", ")})
                            {bookedAddressDiffers(m.customer, r.address) && (
                              <span className="block text-xs">
                                On file: {primaryAddress(m.customer) ? addressLine(primaryAddress(m.customer)!) : "no address"}. Booked for: {r.address}.
                              </span>
                            )}
                          </span>
                          <button
                            onClick={() => accept(r, m.customer.id)}
                            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-800"
                          >
                            Accept for {customerDisplayName(m.customer)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.status === "pending" && canEdit && (
                    <>
                      <button
                        onClick={() => accept(r)}
                        className={
                          matchesFor(r).length > 0
                            ? "rounded-lg border border-emerald-300 px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                            : "rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-800"
                        }
                      >
                        {matchesFor(r).length > 0
                          ? "Accept as a new customer"
                          : "Accept — create customer + draft estimate"}
                      </button>
                      <button
                        onClick={() => decideBookingRequest(r.id, "declined")}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Decline
                      </button>
                    </>
                  )}
                  {r.status === "accepted" && r.estimateId && (
                    <button
                      onClick={() => openEstimate(r.estimateId!)}
                      className="rounded-lg border border-emerald-300 px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                    >
                      Open the draft estimate →
                    </button>
                  )}
                  {canEdit && (
                    <button
                      onClick={() => deleteBookingRequest(r.id)}
                      aria-label="Delete booking request"
                      className="rounded-lg px-2 py-1.5 text-sm font-bold text-slate-400 hover:bg-red-50 hover:text-red-700"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <MyRecentSuggestionsCard />
    </div>
  );
}
