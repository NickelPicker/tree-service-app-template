import { useMemo, useState } from "react";
import { handedTimesheetsWeek } from "../viewHandoff";
import { useStore } from "../store";
import { clockInSites } from "../company";
import type { TimesheetEntry } from "../types";
import { jobValue } from "../jobValue";
import { entryHoursNow, overlappingEntryIds } from "../crewDay";
import { firstAssignedJobToday, jobsOnDay } from "../scheduling";
import {
  addDaysISO,
  endsNextDay,
  entryHours,
  fmtDate,
  isOpenEntry,
  mondayOf,
  money,
  todayStr,
  uid,
  weekDates,
} from "../utils";
import {
  dangerBtn,
  inputCls,
  labelCls,
  linkCls,
  primaryBtn,
  secondaryBtn,
} from "./ui";
import WeeklyPay from "./WeeklyPay";
import { canRunWeeklyPay, isOwnerLike } from "../permissions";
import { CLOSED_AT_8PM_TEXT, eightPmClockOut } from "../clockTime";

function TimesheetEditForm({
  entry,
  onSave,
  onCancel,
}: {
  entry: TimesheetEntry;
  onSave: (t: TimesheetEntry) => void;
  onCancel: () => void;
}) {
  const { state, mayTypeClockTimes } = useStore();
  const [form, setForm] = useState<TimesheetEntry>(entry);
  if (!state) return null;
  const set = (patch: Partial<TimesheetEntry>) =>
    setForm((p) => ({ ...p, ...patch }));
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>Job</label>
          <select
            className={inputCls()}
            value={form.jobId ?? ""}
            onChange={(e) =>
              set({ jobId: e.target.value === "" ? null : e.target.value })
            }
          >
            <option value="">Shop / yard</option>
            {state.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </div>
        {mayTypeClockTimes && (
          <>
            <div>
              <label className={labelCls()}>Date</label>
              <input
                type="date"
                className={inputCls()}
                value={form.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls()}>Clock in</label>
              <input
                type="time"
                className={inputCls()}
                value={form.clockIn ?? ""}
                onChange={(e) =>
                  set({ clockIn: e.target.value === "" ? null : e.target.value })
                }
              />
            </div>
            <div>
              <label className={labelCls()}>Clock out</label>
              <input
                type="time"
                className={inputCls()}
                value={form.clockOut ?? ""}
                onChange={(e) =>
                  set({ clockOut: e.target.value === "" ? null : e.target.value })
                }
              />
            </div>
            <div>
              <label className={labelCls()}>Manual hours</label>
              <input
                type="number"
                min={0}
                step={0.25}
                className={inputCls()}
                value={form.hours ?? ""}
                onChange={(e) =>
                  set({
                    hours: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </>
        )}
        <div>
          <label className={labelCls()}>Location</label>
          <input
            className={inputCls()}
            value={form.location}
            onChange={(e) => set({ location: e.target.value })}
            placeholder="Job site address or shop / yard"
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Notes</label>
          <input
            className={inputCls()}
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </div>
      </div>
      {!mayTypeClockTimes && (
        <p className="text-sm text-slate-700">
          Clock times come from tapping Clock in and Clock out. To fix a
          time or hours, ask the office.
        </p>
      )}
      <p className="text-xs text-slate-500">
        Edits are allowed, and every edit is recorded in the audit log
        with who made it and when.
      </p>
      <div className="flex gap-2">
        <button onClick={() => onSave(form)} className={primaryBtn()}>
          Save changes
        </button>
        <button onClick={onCancel} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function Timesheets({ crewId }: { crewId: string | null }) {
  const {
    state,
    role,
    canEdit,
    canManualClockIn,
    viewerId,
    addTimesheet,
    clockIn,
    clockOut,
    deleteTimesheet,
    updateTimesheet,
    setAutoClock,
    openEmployee,
    openJob,
  } = useStore();
  // The Dashboard To-do can open a given week (the one to approve).
  const [weekMonday, setWeekMonday] = useState(() => handedTimesheetsWeek() ?? mondayOf(todayStr()));
  const [clockCrew, setClockCrew] = useState("");
  // Clock-in target: undefined = auto (the crew member's first
  // assigned job today, or shop when none); null = shop/yard; a job
  // id = that job. The Change picker lists only today's jobs —
  // never every location.
  const [clockJobOverride, setClockJobOverride] = useState<
    string | null | undefined
  >(undefined);
  const [showClockJobPicker, setShowClockJobPicker] = useState(false);
  const [clockLocation, setClockLocation] = useState("");
  const [mCrew, setMCrew] = useState("");
  const [mJob, setMJob] = useState("");
  const [mDate, setMDate] = useState(todayStr());
  const [mHours, setMHours] = useState(8);
  const [mNotes, setMNotes] = useState("");
  const [mLocation, setMLocation] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockMessage, setClockMessage] = useState<string | null>(null);

  const week = useMemo(() => weekDates(weekMonday), [weekMonday]);
  const showMoney = useStore().showMoney;
  if (!state) return null;

  const visibleCrew =
    crewId != null ? state.crew.filter((c) => c.id === crewId) : state.crew;
  const scopedCrewIds = new Set(visibleCrew.map((c) => c.id));
  // Scoped viewers (non-admins) see only their own timesheets; admins
  // see everyone's. This keeps a groundsman on their own time while
  // editors still see the whole crew.
  const openEntries = state.timesheets.filter(
    (t) => isOpenEntry(t) && (crewId == null || scopedCrewIds.has(t.crewId)),
  );
  const weekEntries = state.timesheets
    .filter(
      (t) =>
        week.includes(t.date) &&
        (crewId == null || scopedCrewIds.has(t.crewId)),
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  // Entries of one person that overlap on the same day: the same
  // minutes would be paid twice. Shown in red.
  const overlaps = overlappingEntryIds(weekEntries);

  const hoursByCrew = visibleCrew.map((c) => ({
    crew: c,
    hours: state.timesheets
      .filter((t) => t.crewId === c.id && week.includes(t.date))
      .reduce((sum, t) => sum + entryHoursNow(t), 0),
  }));
  const weekTotal = hoursByCrew.reduce((s, x) => s + x.hours, 0);

  const crewName = (id: string) =>
    state.crew.find((c) => c.id === id)?.name ?? "Unknown";
  const jobTitle = (id: string | null) => {
    if (!id) return "Shop / yard";
    const j = state.jobs.find((x) => x.id === id);
    return j ? j.title : "Job";
  };
  // The value of the job a timesheet entry points at, from the one
  // shared rule — so timesheet job references carry values too.
  const jobValueFor = (id: string | null): number | null => {
    if (!id) return null;
    const j = state.jobs.find((x) => x.id === id);
    return j ? jobValue(state, j) : null;
  };
  // Money is hidden for Crew viewers, same rule as everywhere else.
  // Who may touch an entry: editors (admins and climbers) may touch
  // any entry; anyone else may touch only their own — clocking in/out
  // and adding their own time is not record editing.
  const canTouchEntry = (t: TimesheetEntry) =>
    canEdit || t.crewId === viewerId;
  // The 8 PM rule (the "crew day and 8pm clockout" rules): an open entry from an
  // earlier day, or from today after 8 PM, already ended at 8 PM. The
  // database closes it; Clock out saves 20:00 too.
  const endedAt8 = (t: TimesheetEntry) => eightPmClockOut(t) !== null;
  const endedAt8Note = (
    <span className="text-sm font-semibold text-amber-800">Ended at 8 PM</span>
  );

  // The crew member being clocked in (scoped view, the select, or
  // the first crew member) and the job clock-in defaults to: their
  // first assigned job today, or shop when they have none.
  const clockCrewId = crewId ?? (clockCrew || state.crew[0]?.id);
  const clockFirstJob = clockCrewId
    ? firstAssignedJobToday(state, clockCrewId, todayStr())
    : null;
  const clockJobId =
    clockJobOverride !== undefined
      ? clockJobOverride
      : (clockFirstJob?.id ?? null);
  const clockJobTitle = clockJobId
    ? (state.jobs.find((j) => j.id === clockJobId)?.title ?? "Job")
    : null;
  const todayJobs = jobsOnDay(state, todayStr());

  const doClockIn = async () => {
    // Scoped viewers clock in as themselves, whatever the select says.
    // Already clocked in: the store moves the clock to the new job (as
    // on Today). An open entry from an earlier day ended at 8 PM and is
    // closed by the clock-in. Never a silent no-op (audit 3).
    const crew = clockCrewId;
    if (!crew || clockBusy) return;
    setClockBusy(true);
    setClockMessage(null);
    const res = await clockIn(crew, clockJobId, clockLocation);
    setClockBusy(false);
    if (!res.allowed) {
      // Geofence said no (too far, or location off) — nothing was
      // recorded; show why.
      setClockMessage(res.message);
      return;
    }
    setClockLocation("");
  };

  const doManual = () => {
    // Scoped viewers add hours to themselves only.
    const crew = crewId ?? (mCrew || state.crew[0]?.id);
    if (!crew) return;
    addTimesheet({
      id: uid(),
      crewId: crew,
      jobId: mJob === "" ? null : mJob,
      date: mDate,
      clockIn: null,
      clockOut: null,
      hours: mHours,
      notes: mNotes,
      location: mLocation,
    });
    setMNotes("");
    setMLocation("");
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Timesheets</h1>

      {canRunWeeklyPay(role) && (
        <WeeklyPay weekMonday={weekMonday} week={week} onWeek={setWeekMonday} />
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">Clock in / out</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={clockCrew}
            onChange={(e) => {
              setClockCrew(e.target.value);
              setClockJobOverride(undefined);
              setShowClockJobPicker(false);
            }}
          >
            <option value="">Select crew member…</option>
            {visibleCrew.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.role}
              </option>
            ))}
          </select>
          <span className="text-sm text-slate-800">
            {clockJobTitle ? (
              <>
                Clock in to:{" "}
                <span className="font-semibold">{clockJobTitle}</span>
              </>
            ) : (
              "Clock in — shop / yard"
            )}
          </span>
          <button
            type="button"
            onClick={() => setShowClockJobPicker((v) => !v)}
            className={linkCls()}
          >
            Change
          </button>
          <input
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={clockLocation}
            onChange={(e) => setClockLocation(e.target.value)}
            placeholder="Location (job site address)"
          />
          <button
            onClick={doClockIn}
            disabled={clockBusy}
            className={primaryBtn()}
          >
            {clockBusy ? "Checking location…" : "Clock in"}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {clockJobTitle
            ? "First assigned job today — Change picks from today's jobs only."
            : "No job assigned today — clocking in as shop time."}
        </p>
        {showClockJobPicker && (
          <div className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2">
            <p className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Today&apos;s jobs
            </p>
            <button
              type="button"
              onClick={() => {
                setClockJobOverride(null);
                setShowClockJobPicker(false);
              }}
              className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-white"
            >
              Shop / yard (no job)
            </button>
            {todayJobs.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => {
                  setClockJobOverride(j.id);
                  setShowClockJobPicker(false);
                }}
                className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-white"
              >
                {j.startTime} · {j.title}
              </button>
            ))}
            {todayJobs.length === 0 && (
              <p className="px-2 py-1 text-sm text-slate-500">
                No jobs scheduled today.
              </p>
            )}
          </div>
        )}
        {clockMessage && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {clockMessage}
          </p>
        )}
        {openEntries.length > 0 && (
          <ul className="mt-3 space-y-2">
            {openEntries.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm"
              >
                <span>
                  <button
                    onClick={() => openEmployee(t.crewId)}
                    className={linkCls()}
                  >
                    {crewName(t.crewId)}
                  </button>{" "}
                  clocked in at {t.clockIn} ·{" "}
                  {t.jobId ? (
                    <>
                      <button
                        onClick={() => openJob(t.jobId as string)}
                        className={linkCls()}
                      >
                        {jobTitle(t.jobId)}
                      </button>
                      {(() => {
                        const v = jobValueFor(t.jobId);
                        return v !== null && showMoney
                          ? ` (${money(v)})`
                          : "";
                      })()}
                    </>
                  ) : (
                    "Shop / yard"
                  )}
                </span>
                {canTouchEntry(t) &&
                  (endedAt8(t) ? (
                    endedAt8Note
                  ) : (
                    <button
                      onClick={() => clockOut(t.id)}
                      className={secondaryBtn()}
                    >
                      Clock out
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">
          Auto clock-in/out by location
        </h2>
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={state.settings.autoClock}
            disabled={!canEdit}
            onChange={(e) => setAutoClock(e.target.checked)}
          />
          <span>
            <span className="font-semibold">
              Auto clock-in/out by location (requires location sharing while
              using the app)
            </span>
            <span className="block text-slate-600">
              When this is on, the goal is: clock in as soon as an employee
              steps onto a job site, and clock out when they leave the
              final job site they are assigned to that day.
            </span>
            <span className="block text-slate-600">
              Manual clock-in already checks location: it opens within
              0.25 mi of {clockInSites(state).map((s) => s.label).join(", ") || "a shop or yard address"}, or your first job
              site of the day. Clock-out is never restricted.
            </span>
          </span>
        </label>
        {state.settings.autoClock && (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Not working yet: automatic arrival and departure needs a phone
            app that does not exist yet — it is not running here,
            and no GPS data is being collected or faked. Until then, the
            Clock in / Clock out buttons above (with a typed location)
            are the working path, and location sharing will need to be on
            while using the app for automatic detection to work.
          </div>
        )}
      </section>

      {!isOwnerLike(role) && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">
          Weekly summary
        </h2>
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => setWeekMonday(addDaysISO(weekMonday, -7))}
            className={secondaryBtn()}
          >
            ← Prev week
          </button>
          <span className="text-sm font-semibold text-slate-800">
            Week of {fmtDate(week[0])}
          </span>
          <button
            onClick={() => setWeekMonday(addDaysISO(weekMonday, 7))}
            className={secondaryBtn()}
          >
            Next week →
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {hoursByCrew.map(({ crew, hours }) => (
              <tr key={crew.id} className="border-b border-slate-100">
                <td className="py-2 text-slate-800">
                  <button
                    onClick={() => openEmployee(crew.id)}
                    className={linkCls()}
                  >
                    {crew.name}
                  </button>{" "}
                  · {crew.role}
                </td>
                <td className="py-2 text-right font-semibold text-slate-900">
                  {hours.toFixed(1)} h
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-2 font-bold text-slate-900">Total</td>
              <td className="py-2 text-right font-bold text-slate-900">
                {weekTotal.toFixed(1)} h
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">
          Manual hours entry
        </h2>
        {canManualClockIn ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className={labelCls()}>Crew member</label>
            <select
              className={inputCls()}
              value={mCrew}
              onChange={(e) => setMCrew(e.target.value)}
            >
              <option value="">Select…</option>
              {visibleCrew.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls()}>Job</label>
            <select
              className={inputCls()}
              value={mJob}
              onChange={(e) => setMJob(e.target.value)}
            >
              <option value="">Shop / yard</option>
              {state.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls()}>Date</label>
            <input
              type="date"
              className={inputCls()}
              value={mDate}
              onChange={(e) => setMDate(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls()}>Hours</label>
            <input
              type="number"
              min={0}
              step={0.25}
              className={inputCls()}
              value={mHours}
              onChange={(e) => setMHours(Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelCls()}>Notes</label>
            <input
              className={inputCls()}
              value={mNotes}
              onChange={(e) => setMNotes(e.target.value)}
              placeholder="e.g. Chipper maintenance"
            />
          </div>
          <div>
            <label className={labelCls()}>Location</label>
            <input
              className={inputCls()}
              value={mLocation}
              onChange={(e) => setMLocation(e.target.value)}
              placeholder="Job site address or shop / yard"
            />
          </div>
        </div>
        <button onClick={doManual} className={`${primaryBtn()} mt-3`}>
          Add hours
        </button>
          </>
        ) : (
          <p className="text-sm text-slate-600">
            Entering hours by hand isn&apos;t turned on for you — an
            owner or manager can turn on &quot;May enter hours by
            hand&quot; on your card in Team. Clock in and out by tapping
            Clock in and Clock out instead.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">
          Entries this week
        </h2>
        {overlaps.size > 0 && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
            ⚠ {overlaps.size} entries overlap another entry of the same person
            (shown in red). The same hours would be paid twice — fix the clock
            times or delete the extra entry.
          </p>
        )}
        {weekEntries.length === 0 ? (
          <p className="text-sm text-slate-500">No entries this week.</p>
        ) : (
          <ul className="space-y-2">
            {weekEntries.map((t) => (
              <li
                key={t.id}
                className={`flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2 text-sm last:border-0 ${
                  overlaps.has(t.id) ? "rounded-lg border-l-4 border-l-red-600 bg-red-50 pl-2" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-900">
                    <button
                      onClick={() => openEmployee(t.crewId)}
                      className={linkCls()}
                    >
                      {crewName(t.crewId)}
                    </button>{" "}
                    ·{" "}
                    {t.jobId ? (
                      <>
                        <button
                          onClick={() => openJob(t.jobId as string)}
                          className={linkCls()}
                        >
                          {jobTitle(t.jobId)}
                        </button>
                        {(() => {
                          const v = jobValueFor(t.jobId);
                          return v !== null && showMoney
                            ? ` (${money(v)})`
                            : "";
                        })()}
                      </>
                    ) : (
                      "Shop / yard"
                    )}
                  </p>
                  <p className="text-slate-500">
                    {fmtDate(t.date)}
                    {t.clockIn
                      ? ` · ${t.clockIn}–${t.clockOut ?? (endedAt8(t) ? "20:00 (8 PM)" : "still clocked in")}`
                      : ""}
                    {t.autoClosed && (
                      <span className="font-semibold text-amber-800"> · {CLOSED_AT_8PM_TEXT}</span>
                    )}
                    {endsNextDay(t) && (
                      <span className="font-semibold text-amber-800"> · Ends after midnight: check this entry</span>
                    )}
                    {t.location ? ` · 📍 ${t.location}` : ""}
                    {t.notes ? ` · ${t.notes}` : ""}
                  </p>
                  {editingId === t.id && (
                    <TimesheetEditForm
                      entry={t}
                      onSave={(next) => {
                        updateTimesheet(next);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-slate-900">
                    {entryHoursNow(t).toFixed(1)} h
                  </span>
                  {isOpenEntry(t) &&
                    canTouchEntry(t) &&
                    (endedAt8(t) ? (
                      endedAt8Note
                    ) : (
                      <button
                        onClick={() => clockOut(t.id)}
                        className={secondaryBtn()}
                      >
                        Clock out
                      </button>
                    ))}
                  {canTouchEntry(t) && (
                    <button
                      onClick={() =>
                        setEditingId(editingId === t.id ? null : t.id)
                      }
                      className={secondaryBtn()}
                    >
                      Edit
                    </button>
                  )}
                  {canTouchEntry(t) && role !== "crew" && (
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete ${crewName(t.crewId)}'s ${entryHours(t).toFixed(1)} h on ${fmtDate(t.date)}? This takes the hours off their timesheet.`,
                          )
                        )
                          deleteTimesheet(t.id);
                      }}
                      className={dangerBtn()}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
