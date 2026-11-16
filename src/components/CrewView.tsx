import { useState } from "react";
import { useStore } from "../store";
import type { Job } from "../types";
import { crewDayJobs, dayCrewJobs } from "../crewSuggest";
import { canMarkJobDone, crewPositionText } from "../liveProgress";
import { formatAge, lastLocationFor, openRequestsFor } from "../location";
import DayItinerary, { formatLegText, useRouteLegs } from "./DayItinerary";
import NavigateButton from "./NavigateButton";
import { JobStatusButtons } from "./LiveProgress";
import { runSheetUrl } from "./RunSheet";
import { fmtDate, fmtDateLong, todayStr, uid } from "../utils";
import { isOwnerLike } from "../permissions";
import { jobAddress, jobsOnDay } from "../scheduling";
import { inputCls, labelCls, StatusBadge } from "./ui";
import JobSheet, { bigPrimary, bigSecondary, PriceList } from "./JobSheet";
import { arrivalLabel, shouldOfferClockOut, whereLine } from "../fieldDay";
import {
  clashingTimes,
  clock12,
  closedAt8Entries,
  jobCoversDay,
  runningEntries,
  liveEntryHours,
  myStopOrder,
  myWeek,
  nextStopFor,
  overlappingEntryIds,
} from "../crewDay";
import { dismissTooOldTap, fieldQueueSummary, sendableFieldOps, useFieldQueue } from "../fieldQueue";
import { useCrewPrices } from "../crewPrices";
import { climberNewPrice } from "../priceChange";
import { AFTER_8PM_TEXT, pastClockDayEnd } from "../clockTime";
import { TodayProblemButton } from "./EquipmentProblems";

/**
 * Today view (crew landing page): a phone-first sheet for TODAY only.
 * One card per stop, in the person's own route order (plan-board arrival
 * time, else start time) — the big Navigate button, the stop numbers and
 * the drive legs all use that one order. Each card: Arrived/Done (anyone
 * on the job; groundsmen confirm Done with a second tap), Navigate, Clock
 * in / Switch to this job, and a read-only Job sheet (JobSheet.tsx). Done stops fold to one line. Climbers
 * see the price of each part of the job; groundsmen see no prices. "My
 * hours" shows this week's entries and total. Clock in/out, Arrived and
 * Done made without signal are kept on the phone and sent later (see
 * fieldQueue.ts). The checklist is stored on this phone only.
 */

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "No signal — will send…" / "Not saved — tap to retry", from the field queue. */
function FieldQueueStatus() {
  const all = useFieldQueue();
  const { retryFieldQueue } = useStore();
  // Taps the database refused as too old: shown until the person has
  // told the office (they are never sent again, never dropped by a save).
  const tooOld = all.filter((q) => q.tooOld);
  const queue = sendableFieldOps(all);
  const summary = fieldQueueSummary(queue);
  const oldList =
    tooOld.length > 0 ? (
      <div role="alert" className="mt-3 space-y-2 rounded-lg border-2 border-red-600 bg-red-50 p-3">
        {tooOld.map((q) => (
          <div key={q.op.id}>
            <p className="text-base font-bold text-red-900">⚠ {q.label}: not saved</p>
            <p className="text-base text-red-900">{q.tooOld}</p>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Have you told the office the time you tapped? This takes the note off your phone."))
                  dismissTooOldTap(q.op.id);
              }}
              className="mt-1 min-h-11 rounded-lg border border-red-700 bg-white px-4 font-semibold text-red-800"
            >
              I told the office
            </button>
          </div>
        ))}
      </div>
    ) : null;
  if (!summary) return oldList;
  if (summary.tone === "failed") {
    return (
      <>
      {oldList}
      <button
        type="button"
        onClick={retryFieldQueue}
        className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-base font-bold text-white"
      >
        ⚠ {summary.text}
      </button>
      </>
    );
  }
  return (
    <>
    {oldList}
    <p role="status" className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-base font-semibold text-amber-900">
      📶 {summary.text}
      <span className="block text-sm font-normal">
        Waiting: {queue.map((q) => q.label).join(", ")}
      </span>
    </p>
    </>
  );
}

/** This week's entries and total for the person viewing. */
function MyHours() {
  const { state, viewerId } = useStore();
  if (!state) return null;
  const today = todayStr();
  const week = myWeek(state.timesheets, viewerId, today, nowHHMM());
  const overlaps = overlappingEntryIds(state.timesheets.filter((t) => t.crewId === viewerId));
  const jobTitle = (id: string | null) =>
    id ? (state.jobs.find((j) => j.id === id)?.title ?? "Job") : "Shop / yard";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xl font-bold text-slate-900">My hours</h2>
      <p className="text-base text-slate-700">
        This week, {fmtDate(week.monday)} – {fmtDate(week.sunday)}
      </p>
      <p className="mt-2 text-4xl font-bold text-emerald-800">{week.total.toFixed(1)} h</p>
      {week.entries.some((t) => overlaps.has(t.id)) && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-base font-semibold text-red-800">
          ⚠ Some entries overlap (shown in red). Ask the office to fix them so you are paid right.
        </p>
      )}
      {week.entries.length === 0 ? (
        <p className="mt-3 text-base text-slate-600">No hours yet this week.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {week.entries.map((t) => {
            const bad = overlaps.has(t.id);
            return (
              <li key={t.id} className={`flex items-center justify-between gap-3 py-2 ${bad ? "text-red-800" : "text-slate-900"}`}>
                <span className="text-base">
                  <span className="font-semibold">{fmtDate(t.date)}</span> · {jobTitle(t.jobId)}
                  <span className="block text-sm">
                    {t.clockIn ? `${clock12(t.clockIn)} – ${t.clockOut ? clock12(t.clockOut) : "still clocked in"}` : "Hours entered by hand"}
                  </span>
                </span>
                <span className="shrink-0 text-base font-bold">
                  {liveEntryHours(t, today, nowHHMM()).toFixed(1)} h
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function CrewView() {
  const {
    state,
    viewerId,
    role,
    canSeeAllJobs,
    openCustomer,
    clockIn,
    clockOut,
    mayTypeClockTimes,
    shareMyLocation,
    setView,
    saveTimeOffRequest,
    deleteTimeOffRequest,
  } = useStore();
  const [tab, setTab] = useState<"today" | "hours">("today");
  const [sheetJobId, setSheetJobId] = useState<string | null>(null);
  const [showTimeOff, setShowTimeOff] = useState(false);
  const [locBusy, setLocBusy] = useState(false);
  const [locMsg, setLocMsg] = useState("");
  const doShareLocation = async () => {
    if (locBusy) return;
    setLocBusy(true);
    setLocMsg("");
    const ok = await shareMyLocation();
    setLocBusy(false);
    setLocMsg(
      ok
        ? "Shared — the office can see where you are now."
        : "Couldn't get your location — check that location is on for this site and try again.",
    );
  };
  // Clock-in feedback: which button is waiting on a GPS fix, the
  // refusal for that spot, and "Moved your clock from … to …".
  const [clockBusyId, setClockBusyId] = useState<string | null>(null);
  const [clockError, setClockError] = useState<{ forId: string; message: string } | null>(null);
  const [clockNote, setClockNote] = useState<string | null>(null);
  // Clock-in target: undefined = the next unfinished stop (shop when
  // none); null = shop/yard; a job id = that job.
  const [clockJobOverride, setClockJobOverride] = useState<string | null | undefined>(undefined);
  const [showClockJobPicker, setShowClockJobPicker] = useState(false);
  const [offStart, setOffStart] = useState("");
  const [offEnd, setOffEnd] = useState("");
  const [offReason, setOffReason] = useState("");
  const [offError, setOffError] = useState("");
  const [offSent, setOffSent] = useState(false);

  const today = todayStr();
  const isAdmin = isOwnerLike(role);
  const viewer = state?.crew.find((c) => c.id === viewerId) ?? null;
  const isClimber = viewer?.role === "Climber";
  const prices = useCrewPrices(isClimber);
  // One route order everywhere: my stops by when I get there. A
  // multi-day job is on every day it spans (audit 3).
  const myJobs = myStopOrder(
    (state?.jobs ?? []).filter((j) => jobCoversDay(j, today) && j.crewIds.includes(viewerId)),
    viewerId,
  );
  const { legs } = useRouteLegs(myJobs, true);

  if (!state) return null;

  const jobTitle = (id: string | null) =>
    id ? (state.jobs.find((j) => j.id === id)?.title ?? "a job") : "shop time";
  // Clock entries are dated in Denver time (src/clockTime.ts). Only
  // today's open entry before 8 PM is running; one from an earlier day,
  // or today's after 8 PM, ended at 8 PM (the 8 PM rule, migration
  // the "crew day and 8pm clockout" rules) and shows as closed at 8 PM.
  const openEntries = runningEntries(state.timesheets, viewerId);
  const openEntry = openEntries[0] ?? null;
  const closedAt8 = closedAt8Entries(state.timesheets, viewerId);
  // Live clock-in is closed after 8 PM unless this login may type hours.
  const clockInClosed = !mayTypeClockTimes && pastClockDayEnd();

  const doClockIn = async (forId: string, jobId: string | null) => {
    if (clockBusyId) return;
    setClockBusyId(forId);
    setClockError(null);
    setClockNote(null);
    const from = openEntry;
    const job = jobId ? state.jobs.find((j) => j.id === jobId) : null;
    const res = await clockIn(viewerId, jobId, job ? (jobAddress(state, job) ?? "") : "");
    setClockBusyId(null);
    if (!res.allowed) {
      setClockError({ forId, message: res.message });
      return;
    }
    setClockNote(
      from
        ? `Moved your clock from ${jobTitle(from.jobId)} to ${jobTitle(jobId)}.`
        : `Clocked in to ${jobTitle(jobId)}.`,
    );
    setClockJobOverride(undefined);
  };

  const submitTimeOff = () => {
    if (!offStart || !offEnd) {
      setOffError("Pick a first and last day off.");
      return;
    }
    if (offEnd < offStart) {
      setOffError("The last day can't be before the first day.");
      return;
    }
    saveTimeOffRequest({
      id: uid(),
      crewId: viewerId,
      startDate: offStart,
      endDate: offEnd,
      reason: offReason.trim(),
      status: "pending",
      requestedAt: todayStr(),
      decidedBy: null,
      decidedAt: null,
    });
    setOffStart("");
    setOffEnd("");
    setOffReason("");
    setOffError("");
    setOffSent(true);
  };


  const customerName = (id: string) => {
    const c = state.customers.find((x) => x.id === id);
    return c ? `${c.firstName} ${c.lastName}` : "Unknown customer";
  };
  const todayJobs = jobsOnDay(state, today);
  const otherJobs = myStopOrder(
    todayJobs.filter((j) => !j.crewIds.includes(viewerId)),
    viewerId,
  );
  // Owners/office on Today see every job as a full card.
  const cardJobs = isAdmin ? myStopOrder(todayJobs, viewerId) : myJobs;
  const clashes = clashingTimes(myJobs, viewerId);
  // A stop this person has finished is skipped, also one a groundsman
  // cannot mark done (clocked out of it, or moved on to a later stop).
  const nextStop = nextStopFor(myJobs, state.timesheets, viewerId, today, (j) =>
    canMarkJobDone(j, viewerId, role),
  );
  const clockJobId =
    clockJobOverride !== undefined ? clockJobOverride : (nextStop?.id ?? null);
  const clockJob = clockJobId ? (state.jobs.find((j) => j.id === clockJobId) ?? null) : null;
  const myTimeOff = state.timeOff
    .filter((r) => r.crewId === viewerId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const todayCrews = (state.dayCrews ?? []).filter((c) => c.date === today);
  // Everyone sees their own crew (members, where it is, run sheet);
  // people who see all jobs see every crew.
  const visibleCrews = canSeeAllJobs ? todayCrews : todayCrews.filter((c) => c.memberIds.includes(viewerId));
  const openLocationRequests = openRequestsFor(state, viewerId);
  const lastShared = lastLocationFor(state, viewerId);

  const clockButtonFor = (j: Job) => {
    const here = openEntries.find((t) => t.jobId === j.id);
    if (here) {
      return (
        <button type="button" onClick={() => clockOut(here.id)} className={bigSecondary}>
          Clock out
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => doClockIn(j.id, j.id)}
        disabled={clockBusyId !== null || (clockInClosed && !openEntry)}
        className={bigSecondary}
      >
        {clockBusyId === j.id ? "Checking…" : openEntry ? "Switch to this job" : "Clock in here"}
      </button>
    );
  };

  return (
    <div className="mx-auto max-w-md space-y-4 pb-28 text-base">
      <div className="rounded-xl bg-emerald-700 p-4 text-white shadow-sm">
        <p className="text-sm font-bold uppercase tracking-widest text-white">Today</p>
        <h1 className="text-2xl font-bold">{fmtDateLong(today)}</h1>
        <p className="text-base text-white">
          {viewer ? viewer.name : "Crew"}
          {isAdmin ? " · the whole crew" : ""}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-emerald-900/40 p-1" role="tablist">
          {(
            [
              ["today", "My day"],
              ["hours", "My hours"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`min-h-11 rounded-md text-base font-bold ${
                tab === id ? "bg-white text-emerald-900" : "text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "today" && nextStop && (
          <div className="mt-3">
            <NavigateButton
              destination={{ lat: nextStop.lat, lng: nextStop.lng, address: jobAddress(state, nextStop) }}
              assigned
              label={`🧭 Navigate to my ${myJobs.indexOf(nextStop) > 0 ? "next" : "first"} job`}
              className="min-h-12 w-full rounded-lg bg-white px-4 py-3 text-lg font-bold text-emerald-900 shadow-sm hover:bg-emerald-50"
            />
            <p className="mt-1 text-base text-white">
              Stop {myJobs.indexOf(nextStop) + 1} · {arrivalLabel(nextStop, viewerId).main} · {nextStop.title}
            </p>
          </div>
        )}
        {tab === "today" && clashes.length > 0 && (
          <p className="mt-3 rounded-lg bg-amber-300 px-3 py-2 text-base font-bold text-amber-950">
            ⚠ Two jobs at {clashes.map(clock12).join(", ")} — ask the office which first.
          </p>
        )}
      </div>

      {openLocationRequests.length > 0 && (
        <div className="rounded-xl border border-sky-300 bg-sky-50 p-4 shadow-sm">
          <p className="text-base font-bold text-sky-900">
            📍{" "}
            {state.crew.find((c) => c.id === openLocationRequests[0].requestedBy)?.name ?? "The office"} is
            asking where you are
          </p>
          <p className="mt-1 text-base text-sky-900">
            Tap Share to send your location once — nothing is tracked until you tap it.
          </p>
          <button type="button" onClick={doShareLocation} disabled={locBusy} className={`${bigPrimary} mt-3 w-full`}>
            {locBusy ? "Getting your location…" : "Share my location"}
          </button>
          {locMsg && <p className="mt-2 text-base text-sky-900">{locMsg}</p>}
        </div>
      )}
      {openLocationRequests.length === 0 && lastShared && (
        <p className="text-sm text-slate-700">Last shared {formatAge(lastShared.recordedAt)}.</p>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {openEntry && shouldOfferClockOut(myJobs, openEntry) && (
          <div role="status" className="mb-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
            <p className="text-lg font-bold text-amber-950">That was your last job today.</p>
            <p className="text-base text-amber-950">Clock out now so your hours are right.</p>
            <div className="mt-2 grid grid-cols-1 gap-2">
              <button type="button" onClick={() => clockOut(openEntry.id)} className={`${bigPrimary} w-full`}>
                Clock out now
              </button>
            </div>
          </div>
        )}
        {openEntry ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-base text-slate-900">
              <span className="font-bold">Clocked in</span> since {clock12(openEntry.clockIn as string)}
              <span className="block">{openEntry.jobId ? jobTitle(openEntry.jobId) : "Shop time"}</span>
            </p>
            <button type="button" onClick={() => clockOut(openEntry.id)} className={bigPrimary}>
              Clock out
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-base text-slate-900">
                Clock in ·{" "}
                <span className="font-bold">{clockJob ? clockJob.title : "Shop / yard"}</span>
              </p>
              <button
                type="button"
                onClick={() => doClockIn("top", clockJob?.id ?? null)}
                disabled={clockBusyId !== null || clockInClosed}
                className={bigPrimary}
              >
                {clockBusyId === "top" ? "Checking…" : "Clock in"}
              </button>
            </div>
            {clockInClosed && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-base font-semibold text-amber-950">
                {AFTER_8PM_TEXT}
              </p>
            )}
            <button
              type="button"
              onClick={() => setShowClockJobPicker((v) => !v)}
              className="mt-1 min-h-11 text-base font-semibold text-emerald-800 underline"
            >
              {showClockJobPicker ? "Close" : "Clock in somewhere else"}
            </button>
            {showClockJobPicker && (
              <div className="mt-1 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2">
                {[{ id: null as string | null, label: "Shop / yard (no job)" }, ...[...todayJobs].sort((a, b) => Number(a.status === "done") - Number(b.status === "done")).map((j) => ({
                  id: j.id as string | null,
                  label: `${arrivalLabel(j, viewerId).main} · ${j.title}${j.status === "done" ? " · ✓ Done" : ""}`,
                }))].map((o) => (
                  <button
                    key={o.id ?? "shop"}
                    type="button"
                    onClick={() => {
                      setClockJobOverride(o.id);
                      setShowClockJobPicker(false);
                    }}
                    className="block min-h-11 w-full rounded-lg px-3 py-2 text-left text-base text-slate-900 hover:bg-white"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {closedAt8.map((t) => (
          <p key={t.id} className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-base text-amber-950">
            Your clock from {fmtDate(t.date)} ({t.jobId ? jobTitle(t.jobId) : "shop time"}) was closed at 8 PM.
          </p>
        ))}
        {openEntries.length > 1 && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-base font-semibold text-red-800">
            ⚠ You have {openEntries.length} clocks open. Clock out of the ones you left.
          </p>
        )}
        {clockError?.forId === "top" && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-base text-red-800">{clockError.message}</p>
        )}
        {clockNote && (
          <p role="status" className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-base font-semibold text-emerald-900">
            ✓ {clockNote}
          </p>
        )}
        <FieldQueueStatus />
      </div>

      {tab === "hours" ? (
        <MyHours />
      ) : (
        <>
          {cardJobs.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white p-4 text-base text-slate-700 shadow-sm">
              No jobs for you today.
            </p>
          ) : (
            <ol className="space-y-3">
              {cardJobs.map((j, idx) => {
                const mine = isAdmin || j.crewIds.includes(viewerId);
                const address = jobAddress(state, j) ?? "";
                const myIdx = myJobs.indexOf(j);
                const prevStop = myIdx > 0 ? myJobs[myIdx - 1] : null;
                const leg = myIdx > 0 ? legs[myIdx - 1] : null;
                const myDrive = (j.equipmentIds ?? [])
                  .filter((id) => (j.equipmentDrivers ?? {})[id] === viewerId)
                  .map((id) => state.equipment.find((e) => e.id === id)?.name)
                  .filter(Boolean);
                if (j.status === "done") {
                  return (
                    <li
                      key={j.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                    >
                      <span className="text-base text-slate-900">
                        <span className="mr-2 rounded-full bg-emerald-700 px-2 py-0.5 text-sm font-bold text-white">
                          ✓ Done
                        </span>
                        {idx + 1}. {j.title}
                      </span>
                      <JobStatusButtons job={j} />
                    </li>
                  );
                }
                return (
                  <li key={j.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    {leg && prevStop && (
                      <p className="mb-2 text-sm font-semibold text-slate-700">
                        ↓ From {prevStop.title}: {formatLegText(leg)}
                      </p>
                    )}
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-lg font-bold text-white">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-bold text-slate-900">
                          {arrivalLabel(j, viewerId).main} — {j.title}
                        </p>
                        {arrivalLabel(j, viewerId).sub && (
                          <p className="text-base text-slate-700">({arrivalLabel(j, viewerId).sub})</p>
                        )}
                        <p className="text-base text-slate-800">
                          <button
                            type="button"
                            onClick={() => openCustomer(j.customerId)}
                            className="font-semibold text-emerald-800 underline"
                          >
                            {customerName(j.customerId)}
                          </button>{" "}
                          · {j.serviceType}
                        </p>
                        <p className="text-base text-slate-700">{whereLine(address, j)}</p>
                      </div>
                      <StatusBadge status={j.status} />
                    </div>
                    {prevStop && j.crewArrivals?.[viewerId] && (
                      <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-base font-semibold text-sky-900">
                        🔁 You come here after {prevStop.title}.
                      </p>
                    )}
                    {myDrive.length > 0 && (
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-base font-semibold text-amber-900">
                        🛻 You&apos;re driving: {myDrive.join(" + ")}
                      </p>
                    )}
                    {j.teamNotes && (
                      <p className="mt-2 text-base text-slate-900">
                        <span className="font-bold">Team notes: </span>
                        {j.teamNotes}
                      </p>
                    )}
                    {isClimber && <PriceList lines={prices.get(j.id) ?? []} newPrice={climberNewPrice(j)} />}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <JobStatusButtons job={j} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <NavigateButton
                        destination={{ lat: j.lat, lng: j.lng, address: address || null }}
                        assigned={mine}
                        className={bigPrimary}
                      />
                      {clockButtonFor(j)}
                      <button
                        type="button"
                        onClick={() => setSheetJobId(j.id)}
                        className={`${bigSecondary} col-span-2`}
                      >
                        Job sheet
                      </button>
                    </div>
                    {clockError?.forId === j.id && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-base text-red-800">{clockError.message}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          <TodayProblemButton
            todayEquipmentIds={[...new Set(cardJobs.flatMap((j) => j.equipmentIds ?? []))]}
          />

          {!isAdmin && otherJobs.length > 0 && (
            <section className="rounded-xl border border-dashed border-slate-300 bg-white p-4">
              <h2 className="text-base font-bold text-slate-900">Other jobs today — not yours</h2>
              <ul className="mt-2 divide-y divide-slate-100">
                {otherJobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-2 py-2">
                    <button
                      type="button"
                      onClick={() => setSheetJobId(j.id)}
                      className="min-h-11 text-left text-base text-slate-900"
                    >
                      {clock12(j.startTime)} · {j.title}
                      {j.status === "done" ? " · ✓ Done" : ""}
                    </button>
                    <NavigateButton
                      destination={{ lat: j.lat, lng: j.lng, address: jobAddress(state, j) }}
                      assigned={false}
                      label="🧭"
                      className={bigSecondary}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {visibleCrews.length > 0 && (
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-base font-bold text-slate-900">{canSeeAllJobs ? "Crews" : "Your crew"}</h2>
              {visibleCrews.map((crew) => {
                const members = crew.memberIds
                  .map((id) => state.crew.find((c) => c.id === id)?.name)
                  .filter(Boolean);
                const stops = canSeeAllJobs
                  ? dayCrewJobs(state, today, crew.memberIds)
                  : crewDayJobs(state, today, viewerId);
                const position = crewPositionText(stops);
                return (
                  <div key={crew.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-base font-bold text-slate-900">{crew.name}</p>
                      <a
                        href={runSheetUrl(today, crew.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-sm font-semibold text-emerald-800 underline"
                      >
                        🖨 Print run sheet
                      </a>
                    </div>
                    <p className="text-base text-slate-700">
                      {members.length > 0 ? members.join(", ") : "No members yet"}
                    </p>
                    {position && <p className="mt-1 text-base font-semibold text-emerald-800">{position}</p>}
                    <div className="mt-2">
                      <DayItinerary jobs={stops} showCrew={false} showStatus />
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <button
            type="button"
            onClick={() => setView("schedule")}
            className="min-h-12 w-full rounded-xl border border-slate-200 bg-white p-4 text-left text-base font-bold text-slate-900 shadow-sm"
          >
            See the coming days →
          </button>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <button
              type="button"
              onClick={() => setShowTimeOff((v) => !v)}
              aria-expanded={showTimeOff}
              className="flex min-h-11 w-full items-center justify-between text-left text-base font-bold text-slate-900"
            >
              Time off {myTimeOff.length > 0 ? `(${myTimeOff.length})` : ""}
              <span aria-hidden>{showTimeOff ? "▾" : "▸"}</span>
            </button>
            {showTimeOff && (
              <div className="mt-2 space-y-3">
                <p className="text-base text-slate-700">
                  Ask for days off. The office approves them.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls()} htmlFor="off-start">First day off</label>
                    <input id="off-start" type="date" className={inputCls()} value={offStart} onChange={(e) => setOffStart(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls()} htmlFor="off-end">Last day off</label>
                    <input id="off-end" type="date" className={inputCls()} value={offEnd} onChange={(e) => setOffEnd(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className={labelCls()} htmlFor="off-reason">Reason (optional)</label>
                  <input
                    id="off-reason"
                    className={inputCls()}
                    value={offReason}
                    onChange={(e) => setOffReason(e.target.value)}
                    placeholder="e.g. Family trip"
                  />
                </div>
                {offError && <p className="rounded-lg bg-red-50 px-3 py-2 text-base text-red-800">{offError}</p>}
                {offSent && (
                  <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-base text-emerald-900">
                    ✓ Sent to the office — you&apos;ll see Approved here.
                  </p>
                )}
                <button type="button" onClick={submitTimeOff} className={bigPrimary}>
                  Send request
                </button>
                {myTimeOff.length > 0 && (
                  <ul className="space-y-2 border-t border-slate-100 pt-3">
                    {myTimeOff.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                        <span className="text-base text-slate-900">
                          <span className="font-semibold">
                            {fmtDate(r.startDate)}
                            {r.endDate !== r.startDate && ` – ${fmtDate(r.endDate)}`}
                          </span>
                          {r.reason ? ` · ${r.reason}` : ""}
                        </span>
                        <span className="flex items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-sm font-bold ${
                              r.status === "approved"
                                ? "bg-emerald-100 text-emerald-800"
                                : r.status === "denied"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {r.status === "approved" ? "Approved" : r.status === "denied" ? "Denied" : "Waiting"}
                          </span>
                          {r.status === "pending" && (
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm("Withdraw this time-off request?")) deleteTimeOffRequest(r.id);
                              }}
                              className="min-h-11 px-2 text-base font-semibold text-slate-700 underline"
                            >
                              Withdraw
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {sheetJobId &&
        (() => {
          const j = state.jobs.find((x) => x.id === sheetJobId);
          if (!j) return null;
          return (
            <JobSheet
              job={j}
              mine={isAdmin || j.crewIds.includes(viewerId)}
              onClose={() => setSheetJobId(null)}
            />
          );
        })()}
    </div>
  );
}
