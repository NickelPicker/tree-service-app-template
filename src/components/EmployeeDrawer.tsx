import { useState } from "react";
import { useStore } from "../store";
import type { CrewMember } from "../types";
import { jobValue } from "../jobValue";
import { rawMessageIntro } from "../messages";
import { companyName } from "../company";
import { fmtDate, mondayOf, money, todayStr, weekDates } from "../utils";
import { entryHoursNow } from "../crewDay";
import EmployeeForm from "./EmployeeForm";
import { MapAppSetting } from "./NavigateButton";
import { isLegalDriver, skillCatalog } from "../skills";
import { inputCls, labelCls, linkCls, primaryBtn, secondaryBtn, StatusBadge } from "./ui";
import { isOwnerLike } from "../permissions";

/**
 * Personal message intro: only the owner of the intro may edit it.
 * Everyone else (including admins) sees it read-only. This is the
 * one record edit a groundsman may make about themselves, so it is
 * not gated on canEdit — only on "is this my profile?".
 */
function MessageIntroSection({ employee }: { employee: CrewMember }) {
  const { state, viewer, saveMessageIntro } = useStore();
  const isSelf = viewer?.id === employee.id;
  const [text, setText] = useState(employee.messageIntro ?? "");
  const [saved, setSaved] = useState(false);
  const changed = text !== (employee.messageIntro ?? "");
  if (!isSelf) {
    return (
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Message intro
        </p>
        <p className="text-sm text-slate-700">
          {employee.messageIntro?.trim()
            ? employee.messageIntro
            : `${rawMessageIntro(employee, companyName(state))} (default — no personal intro written yet)`}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Only {employee.name.split(" ")[0]} can change this intro.
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        My message intro
      </p>
      <label className={labelCls()}>Autofills when I message a customer</label>
      <textarea
        className={inputCls()}
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        placeholder={`Hi {firstName}, this is {senderName} with ${companyName(state)}:`}
      />
      <p className="mt-1 text-xs text-slate-500">
        Use {"{firstName}"} for the customer&apos;s first name and{" "}
        {"{senderName}"} for your name. Leave it blank to use the default
        intro.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={!changed}
          onClick={() => {
            saveMessageIntro(employee.id, text);
            setSaved(true);
          }}
          className={primaryBtn()}
        >
          Save my intro
        </button>
        {saved && !changed && (
          <span className="text-sm text-emerald-700">Saved.</span>
        )}
      </div>
    </div>
  );
}

/**
 * Employee profile drawer, opened from any page that names an employee.
 * Shows the profile, current + upcoming jobs (each opens the job
 * drawer, with its value), and recent timesheets with this week's
 * hours. Editing rules, for now: admins and climbers can edit;
 * groundsmen are read-only on records (they can still clock in/out
 * and add their own timesheet entries from the Timesheets page).
 */
export default function EmployeeDrawer({
  employeeId,
  edit,
  onClose,
}: {
  employeeId: string | null;
  edit: boolean;
  onClose: () => void;
}) {
  const { state, role, canEdit, openJob, viewer } = useStore();
  const [editing, setEditing] = useState(edit);
  const showMoney = useStore().showMoney;
  if (!state) return null;

  const employee = employeeId
    ? (state.crew.find((c) => c.id === employeeId) ?? null)
    : null;

  if (!employee) {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-bold text-slate-900">Add a person</h2>
        <p className="text-sm text-slate-600">
          Demo-only local account — real logins come with the Phase 2
          backend.
        </p>
        <EmployeeForm existing={null} onDone={onClose} />
      </div>
    );
  }

  const isOwner = isOwnerLike(role);
  const today = todayStr();
  const week = weekDates(mondayOf(today));
  // Money is hidden for Crew viewers, same rule as everywhere else.

  const upcomingJobs = state.jobs
    .filter(
      (j) =>
        j.crewIds.includes(employee.id) &&
        (j.date >= today || j.status === "in_progress"),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const recentEntries = state.timesheets
    .filter((t) => t.crewId === employee.id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const weekHours = state.timesheets
    .filter((t) => t.crewId === employee.id && week.includes(t.date))
    .reduce((s, t) => s + entryHoursNow(t), 0);
  const jobTitle = (id: string | null) => {
    if (!id) return "Shop / yard";
    return state.jobs.find((j) => j.id === id)?.title ?? "Job";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <span
            className="inline-block h-6 w-6 rounded-full"
            style={{ backgroundColor: employee.color }}
          />
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {employee.name}
            </h2>
            <p className="text-sm text-slate-600">
              {employee.role} · App role: {employee.appRole}
            </p>
          </div>
        </div>
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)} className={secondaryBtn()}>
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <EmployeeForm
          existing={employee}
          selfOnly={!isOwner}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          {isOwner && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <p className="text-slate-700">
                <span className="font-semibold text-slate-900">Driving: </span>
                {isLegalDriver(employee)
                  ? `yes (licence + insurance)${employee.cdlClass && employee.cdlClass !== "none" ? ` · CDL ${employee.cdlClass}` : ""}`
                  : employee.driverLicensed
                    ? "not on the insurance yet"
                    : "no licence recorded"}
                {employee.lastResort ? " · only when needed" : ""}
              </p>
              <p className="mt-1 text-slate-700">
                <span className="font-semibold text-slate-900">Skills: </span>
                {(employee.skills ?? []).length === 0
                  ? "none ticked yet (tap Edit)"
                  : skillCatalog(state)
                      .filter((sk) => (employee.skills ?? []).includes(sk.id))
                      .map((sk) => sk.label)
                      .join(", ")}
              </p>
            </div>
          )}
          <div className="space-y-1 text-sm text-slate-700">
            <p>
              Phone:{" "}
              {employee.phone ? (
                <a className={linkCls()} href={`tel:${employee.phone}`}>
                  {employee.phone}
                </a>
              ) : (
                "No phone on file"
              )}
            </p>
            <p>
              Email:{" "}
              {employee.email ? (
                <a className={linkCls()} href={`mailto:${employee.email}`}>
                  {employee.email}
                </a>
              ) : (
                "No email on file"
              )}
            </p>
            {isOwner && (
              <p className="text-slate-500">
                Login: {employee.authUserId ? "linked" : "none yet — they sign up in the app"}
              </p>
            )}
            {!canEdit && (
              <p className="text-xs text-slate-500">
                You can look at this profile. An owner or the office can change it.
              </p>
            )}
          </div>

          <MessageIntroSection key={employee.id} employee={employee} />

          {viewer?.id === employee.id && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <MapAppSetting />
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Current + upcoming jobs
            </p>
            {upcomingJobs.length === 0 ? (
              <p className="text-sm text-slate-500">No upcoming jobs.</p>
            ) : (
              <ul className="space-y-2">
                {upcomingJobs.map((j) => {
                  const v = jobValue(state, j);
                  return (
                    <li key={j.id}>
                      <button
                        onClick={() => openJob(j.id)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left shadow-sm hover:border-emerald-500"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-900">
                            {j.title}
                          </span>
                          <span className="text-xs text-slate-500">
                            {fmtDate(j.date)} · {j.startTime} ·{" "}
                            {j.serviceType}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {v !== null && showMoney && (
                            <span className="text-sm font-semibold text-slate-900">
                              {money(v)}
                            </span>
                          )}
                          <StatusBadge status={j.status} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Timesheets · {weekHours.toFixed(1)} h this week
            </p>
            {recentEntries.length === 0 ? (
              <p className="text-sm text-slate-500">No entries yet.</p>
            ) : (
              <ul className="space-y-2">
                {recentEntries.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2 text-sm last:border-0"
                  >
                    <span className="text-slate-700">
                      {fmtDate(t.date)} ·{" "}
                      {t.jobId ? (
                        <button
                          onClick={() => openJob(t.jobId as string)}
                          className={linkCls()}
                        >
                          {jobTitle(t.jobId)}
                        </button>
                      ) : (
                        "Shop / yard"
                      )}
                      {t.location ? ` · 📍 ${t.location}` : ""}
                    </span>
                    <span className="font-semibold text-slate-900">
                      {entryHoursNow(t).toFixed(1)} h
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
