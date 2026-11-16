import { useRef, useState } from "react";
import { WEEKDAY_NAMES, isSchedulable } from "../crewSuggest";
import { useStore } from "../store";
import { skillCatalog, skillsByGroup } from "../skills";
import { companyName } from "../company";
import type { CrewMember, Role } from "../types";
import { uid } from "../utils";
import { canEditRecords, isOwnerLike } from "../permissions";
import { isUserAutosaveReady } from "../userAutosave";
import {
  inputCls,
  labelCls,
  linkCls,
  MoneyInput,
  primaryBtn,
} from "./ui";

const EMPTY_USER: Omit<CrewMember, "id"> = {
  name: "",
  role: "Ground",
  phone: "",
  color: "#475569",
  appRole: "crew",
  email: "",
  messageIntro: "",
  authUserId: null,
  status: "active",
  employmentType: null,
  payType: null,
  payAmount: null,
  availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
  canDriveEquipment: [],
  worksWellWith: [],
  skills: [],
  driverLicensed: false,
  companyInsured: false,
  cdlClass: "none",
  lastResort: false,
  prefersOwnTruck: false,
  ownTruckId: null,
  permissions: null,
};

/**
 * The one employee form, shared by the Users page flow and the employee
 * profile drawer. `selfOnly` limits the form to the contact fields a
 * non-admin can edit about themselves (phone + email); admins edit
 * everything.
 */
export default function EmployeeForm({
  existing,
  selfOnly,
  onDone,
}: {
  existing: CrewMember | null;
  selfOnly?: boolean;
  onDone: () => void;
}) {
  const { state, saveCrewMember, viewerId, viewer } = useStore();
  const isOwner = isOwnerLike(viewer?.appRole);
  const [form, setForm] = useState<Omit<CrewMember, "id">>(
    existing
      ? {
          name: existing.name,
          role: existing.role,
          phone: existing.phone,
          color: existing.color,
          appRole: existing.appRole,
          email: existing.email,
          messageIntro: existing.messageIntro ?? "",
          // Carried through untouched: editing a profile must never
          // drop the person's login link or onboarding state.
          authUserId: existing.authUserId ?? null,
          status: existing.status ?? "active",
          employmentType: existing.employmentType ?? null,
          payType: existing.payType ?? null,
          payAmount: existing.payAmount ?? null,
          availableWeekdays: existing.availableWeekdays ?? [0, 1, 2, 3, 4, 5, 6],
          canDriveEquipment: existing.canDriveEquipment ?? [],
          worksWellWith: existing.worksWellWith ?? [],
          skills: existing.skills ?? [],
          driverLicensed: existing.driverLicensed ?? false,
          companyInsured: existing.companyInsured ?? false,
          cdlClass: existing.cdlClass ?? "none",
          lastResort: existing.lastResort ?? false,
          prefersOwnTruck: existing.prefersOwnTruck ?? false,
          ownTruckId: existing.ownTruckId ?? null,
          permissions: existing.permissions ?? null,
        }
      : EMPTY_USER,
  );
  // Only the owner of an intro may edit it — an admin editing someone
  // else's profile sees it read-only, never overwrites it. New users
  // have no intro yet; they write their own once they sign in.
  const canEditIntro = existing ? existing.id === viewerId : false;

  /**
   * Autosave. There is no Save button anymore: every change lands in
   * the store through the same saveCrewMember path the old Save button
   * used (same store call, same audit logging, same header
   * Saving…/✓ Saved indicator and save-error banner with retry).
   * Toggles, selects, checkboxes and the color picker save
   * immediately; text fields save on blur, not per keystroke.
   * A new user gets a stable id up front and is created in the store
   * the moment the form is valid (it has a name); until then
   * nothing is saved. An invalid form (blank name) is
   * never written, so clearing a name can't overwrite a good row.
   */
  const [memberId] = useState(() => existing?.id ?? uid());
  const [created, setCreated] = useState(!!existing);
  const createdRef = useRef(!!existing);
  const formRef = useRef(form);
  const persist = (next: Omit<CrewMember, "id">) => {
    if (!isUserAutosaveReady(next)) return;
    if (!createdRef.current) {
      createdRef.current = true;
      setCreated(true);
    }
    saveCrewMember({ ...next, id: memberId });
  };
  const applyPatch = (patch: Partial<Omit<CrewMember, "id">>) => {
    const next = { ...formRef.current, ...patch };
    formRef.current = next;
    setForm(next);
    return next;
  };
  // Text fields: local only — the save happens on blur.
  const set = (patch: Partial<Omit<CrewMember, "id">>) => {
    applyPatch(patch);
  };
  // Toggles, selects, checkboxes, color: save immediately.
  const setAndSave = (patch: Partial<Omit<CrewMember, "id">>) => {
    persist(applyPatch(patch));
  };
  // Text fields save when the field loses focus, not per keystroke.
  const saveOnBlur = () => persist(formRef.current);
  const valid = isUserAutosaveReady(form);

  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {!selfOnly && (
          <>
            <div>
              <label className={labelCls()}>Full name *</label>
              <input
                className={inputCls()}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                onBlur={saveOnBlur}
              />
            </div>
            <div>
              <label className={labelCls()}>Job role</label>
              <input
                className={inputCls()}
                value={form.role}
                onChange={(e) => set({ role: e.target.value })}
                onBlur={saveOnBlur}
                placeholder="Foreman, Climber, Ground…"
              />
            </div>
            <div>
              <label className={labelCls()}>App role</label>
              <select
                className={inputCls()}
                value={form.appRole}
                onChange={(e) => setAndSave({ appRole: e.target.value as Role })}
              >
                <option value="owner">Owner (admin)</option>
                <option value="manager">Manager</option>
                <option value="office">Office</option>
                <option value="crew">Crew</option>
              </select>
            </div>
            {isOwner && (
              <>
                <div>
                  <label className={labelCls()}>Employment type</label>
                  <select
                    className={inputCls()}
                    value={form.employmentType ?? ""}
                    onChange={(e) =>
                      setAndSave({
                        employmentType: (e.target.value || null) as
                          | "w2"
                          | "1099"
                          | null,
                      })
                    }
                  >
                    <option value="">Not set</option>
                    <option value="w2">W-2 employee</option>
                    <option value="1099">1099 contractor</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls()}>Pay type</label>
                  <select
                    className={inputCls()}
                    value={form.payType ?? ""}
                    onChange={(e) =>
                      setAndSave({
                        payType: (e.target.value || null) as
                          | "hourly"
                          | "day"
                          | "percent"
                          | null,
                      })
                    }
                  >
                    <option value="">Not set</option>
                    <option value="hourly">Hourly ($/hr)</option>
                    <option value="day">Day rate ($/day)</option>
                    <option value="percent">% of the job</option>
                  </select>
                </div>
                {form.payType === "percent" ? (
                  <div>
                    <label className={labelCls()}>
                      Pay amount (% of job)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      className={inputCls()}
                      value={form.payAmount ?? ""}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        set({ payAmount: isNaN(n) ? null : n });
                      }}
                      onBlur={saveOnBlur}
                      placeholder="e.g. 10"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Percent of the job&apos;s value, paid on jobs where
                      they logged time. Only owners see pay.
                    </p>
                  </div>
                ) : form.payType ? (
                  <div>
                    <label className={labelCls()}>
                      Pay amount (
                      {form.payType === "day" ? "$/day" : "$/hr"})
                    </label>
                    <MoneyInput
                      value={form.payAmount ?? 0}
                      onChange={(n) =>
                        set({ payAmount: n === 0 ? null : n })
                      }
                      onBlur={saveOnBlur}
                      placeholder="0.00"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      {form.payType === "day"
                        ? "Flat rate per day worked on the job, counted by days with timesheet entries."
                        : "Job costing prices this person's timesheet hours at this rate."}{" "}
                      Blank = the job&apos;s default labor rate. Only owners
                      see pay.
                    </p>
                  </div>
                ) : null}
                <div>
                  <label className={labelCls()}>Paid a fixed number of hours each week</label>
                  <input
                    type="number"
                    min={0}
                    max={80}
                    step={0.5}
                    className={inputCls()}
                    value={form.fixedWeeklyHours ?? ""}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      set({ fixedWeeklyHours: isNaN(n) ? null : Math.min(80, Math.max(0, n)) });
                    }}
                    onBlur={saveOnBlur}
                    placeholder="Blank = paid for clocked hours"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    For someone on set hours (e.g. 32). The weekly pay view uses this instead of their clocked hours; hours over 40 are overtime.
                  </p>
                </div>
                <label className="flex items-start gap-2 text-sm text-slate-800 sm:col-span-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-emerald-700"
                    checked={form.countedOnEveryJob === true}
                    onChange={(e) => set({ countedOnEveryJob: e.target.checked })}
                    onBlur={saveOnBlur}
                  />
                  <span>
                    Count on every job&apos;s labor cost
                    <span className="block text-xs text-slate-500">
                      Office time that every job pays for (like the office manager). Added to each job&apos;s planned cost.
                    </span>
                  </span>
                </label>
              </>
            )}
            {/* Scheduling: availability, drivers, groupings — the
            owner sets these; they drive the crew suggestions. */}
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-bold text-slate-900">
                Generally available
              </p>
              <p className="text-xs text-slate-500">
                Which weekdays this person usually works. Scheduling
                them on another weekday warns you (you can override),
                and the crew suggestion prefers people who are usually
                free that day.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {WEEKDAY_NAMES.map((name, d) => {
                  const days = form.availableWeekdays ?? [0, 1, 2, 3, 4, 5, 6];
                  const on = days.includes(d);
                  return (
                    <label
                      key={name}
                      className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setAndSave({
                            availableWeekdays: on
                              ? days.filter((x) => x !== d)
                              : [...days, d].sort((a, b) => a - b),
                          })
                        }
                        className="h-4 w-4 accent-emerald-700"
                      />
                      {name}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-bold text-slate-900">
                Can drive / transport
              </p>
              <p className="text-xs text-slate-500">
                Check every piece of equipment this person can drive or
                haul. The crew suggestion assigns a driver for each
                piece on the job from these.
              </p>
              {(state?.equipment ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">
                  No equipment on file yet — add it on the Equipment
                  page first.
                </p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {(state?.equipment ?? []).map((e) => {
                    const can = (form.canDriveEquipment ?? []).includes(e.id);
                    return (
                      <label
                        key={e.id}
                        className="flex cursor-pointer items-center gap-2 text-sm text-slate-800"
                      >
                        <input
                          type="checkbox"
                          checked={can}
                          onChange={() =>
                            setAndSave({
                              canDriveEquipment: can
                                ? (form.canDriveEquipment ?? []).filter(
                                    (x) => x !== e.id,
                                  )
                                : [...(form.canDriveEquipment ?? []), e.id],
                            })
                          }
                          className="h-4 w-4 accent-emerald-700"
                        />
                        {e.name} · {e.kind}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-bold text-slate-900">Skills</p>
              <p className="text-xs text-slate-500">
                Tick everything this person can do. The scheduler only
                sends people with the skills a job needs. Add or rename
                skills on Users → Skills grid.
              </p>
              <div className="mt-2 space-y-3">
                {skillsByGroup(skillCatalog(state)).map(({ group, skills }) => (
                  <div key={group}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {group}
                    </p>
                    <div className="mt-1 grid gap-1 sm:grid-cols-2">
                      {skills.map((sk) => {
                        const has = (form.skills ?? []).includes(sk.id);
                        return (
                          <label
                            key={sk.id}
                            className="flex cursor-pointer items-center gap-2 text-sm text-slate-800"
                          >
                            <input
                              type="checkbox"
                              checked={has}
                              onChange={() =>
                                setAndSave({
                                  skills: has
                                    ? (form.skills ?? []).filter((x) => x !== sk.id)
                                    : [...(form.skills ?? []), sk.id],
                                })
                              }
                              className="h-4 w-4 accent-emerald-700"
                            />
                            {sk.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-bold text-slate-900">Driving</p>
              <p className="text-xs text-slate-500">
                The scheduler only picks someone to drive a company
                vehicle when both of the first two boxes are ticked.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.driverLicensed === true}
                    onChange={(e) => setAndSave({ driverLicensed: e.target.checked })}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  Has a valid driver&apos;s licence
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.companyInsured === true}
                    onChange={(e) => setAndSave({ companyInsured: e.target.checked })}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  On the company vehicle insurance
                </label>
                <div>
                  <label className={labelCls()}>CDL</label>
                  <select
                    className={inputCls()}
                    value={form.cdlClass ?? "none"}
                    onChange={(e) =>
                      setAndSave({ cdlClass: e.target.value as "none" | "B" | "A" })
                    }
                  >
                    <option value="none">No CDL</option>
                    <option value="B">CDL Class B</option>
                    <option value="A">CDL Class A</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls()}>Prefers to drive their own truck</label>
                  <select
                    className={inputCls()}
                    value={form.prefersOwnTruck ? (form.ownTruckId ?? "") : "-"}
                    onChange={(e) =>
                      setAndSave(
                        e.target.value === "-"
                          ? { prefersOwnTruck: false, ownTruckId: null }
                          : { prefersOwnTruck: true, ownTruckId: e.target.value || null },
                      )
                    }
                  >
                    <option value="-">No</option>
                    {(state?.equipment ?? [])
                      .filter((e) => e.kind === "Truck")
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          Yes: {e.name}
                        </option>
                      ))}
                  </select>
                </div>
                {!form.driverLicensed || !form.companyInsured ? (
                  <p className="text-xs font-semibold text-amber-700 sm:col-span-2">
                    Not a driver for the scheduler until the licence and
                    insurance boxes are both ticked.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={form.lastResort === true}
                  onChange={(e) => setAndSave({ lastResort: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-emerald-700"
                />
                <span>
                  <span className="font-bold text-slate-900">Only when needed</span>
                  <span className="block text-xs text-slate-500">
                    The scheduler calls this person in only when a job
                    would otherwise go unfilled (for example an
                    occasional contractor).
                  </span>
                </span>
              </label>
            </div>
            <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-bold text-slate-900">
                Works well with
              </p>
              <p className="text-xs text-slate-500">
                The people this person works best with. The crew
                suggestion prefers keeping these people on the same
                job.
              </p>
              <div className="mt-2 space-y-1.5">
                {(state?.crew ?? [])
                  .filter((c) => isSchedulable(c) && c.id !== existing?.id)
                  .map((c) => {
                    const picked = (form.worksWellWith ?? []).includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 text-sm text-slate-800"
                      >
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={() =>
                            setAndSave({
                              worksWellWith: picked
                                ? (form.worksWellWith ?? []).filter(
                                    (x) => x !== c.id,
                                  )
                                : [...(form.worksWellWith ?? []), c.id],
                            })
                          }
                          className="h-4 w-4 accent-emerald-700"
                        />
                        {c.name} · {c.role}
                      </label>
                    );
                  })}
              </div>
            </div>
            {isOwner && (
              <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-bold text-slate-900">
                  What this person can see
                </p>
                <p className="text-xs text-slate-500">
                  Per-person permissions. Blank = the role default
                  (owners and office see everything; crew see only
                  their own jobs and no dollar amounts).
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["seeAllCustomers", "All customers"],
                      ["seeMoney", "Dollar amounts"],
                      ["seeAllJobs", "All jobs"],
                    ] as const
                  ).map(([key, label]) => {
                    const v = form.permissions?.[key];
                    return (
                      <div key={key}>
                        <label className={labelCls()}>{label}</label>
                        <select
                          className={inputCls()}
                          value={
                            v === true ? "allow" : v === false ? "deny" : "default"
                          }
                          onChange={(e) => {
                            const val = e.target.value;
                            setAndSave({
                              permissions: {
                                ...(form.permissions ?? {}),
                                [key]:
                                  val === "allow"
                                    ? true
                                    : val === "deny"
                                      ? false
                                      : undefined,
                              },
                            });
                          }}
                        >
                          <option value="default">Role default</option>
                          <option value="allow">Allow</option>
                          <option value="deny">Deny</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                    <input
                      type="checkbox"
                      checked={form.permissions?.canMessageCustomers ?? false}
                      onChange={(e) =>
                        setAndSave({
                          permissions: {
                            ...(form.permissions ?? {}),
                            canMessageCustomers: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-emerald-700"
                    />
                    Can message customers
                  </label>
                  <p className="mt-1 text-xs text-slate-500">
                    {form.permissions?.canMessageCustomers === undefined
                      ? "Default: off — nobody can message customers until an owner turns this on. New people start with no messaging access."
                      : "Set for this person."}{" "}
                    {form.permissions?.canMessageCustomers !== undefined && (
                      <button
                        type="button"
                        onClick={() =>
                          setAndSave({
                            permissions: {
                              ...(form.permissions ?? {}),
                              canMessageCustomers: undefined,
                            },
                          })
                        }
                        className={linkCls()}
                      >
                        Reset to default (off)
                      </button>
                    )}
                  </p>
                </div>
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                    <input
                      type="checkbox"
                      checked={
                        form.permissions?.canManualClockIn ??
                        canEditRecords(form.appRole)
                      }
                      onChange={(e) =>
                        setAndSave({
                          permissions: {
                            ...(form.permissions ?? {}),
                            canManualClockIn: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 accent-emerald-700"
                    />
                    May enter hours by hand
                  </label>
                  <p className="mt-1 text-xs text-slate-500">
                    {form.permissions?.canManualClockIn === undefined
                      ? "Default: off for crew — they clock in and out live by tapping Clock in and Clock out, and cannot type past clock times or hours. Owners, managers and the office always may. Turn this on to let this person type them."
                      : "Set for this person."}{" "}
                    {form.permissions?.canManualClockIn !== undefined && (
                      <button
                        type="button"
                        onClick={() =>
                          setAndSave({
                            permissions: {
                              ...(form.permissions ?? {}),
                              canManualClockIn: undefined,
                            },
                          })
                        }
                        className={linkCls()}
                      >
                        Reset to default (off for crew)
                      </button>
                    )}
                  </p>
                </div>
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                    <input
                      type="checkbox"
                      checked={form.permissions?.hideFromSchedule !== true}
                      onChange={(e) =>
                        setAndSave({
                          permissions: {
                            ...(form.permissions ?? {}),
                            hideFromSchedule: e.target.checked ? undefined : true,
                          },
                        })
                      }
                      className="h-4 w-4 accent-emerald-700"
                    />
                    Show on the schedule and crew lists
                  </label>
                  <p className="mt-1 text-xs text-slate-500">
                    Turn off for someone who never goes out on jobs (office
                    staff, or a second login for someone already on the
                    roster). Their login and access stay the same.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
        <div>
          <label className={labelCls()}>Phone</label>
          <input
            className={inputCls()}
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
            onBlur={saveOnBlur}
          />
        </div>
        <div>
          <label className={labelCls()}>Email</label>
          <input
            className={inputCls()}
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
            onBlur={saveOnBlur}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>
            My message intro (autofills when I message a customer)
          </label>
          <textarea
            className={inputCls()}
            rows={2}
            value={form.messageIntro ?? ""}
            disabled={!canEditIntro}
            onChange={(e) => set({ messageIntro: e.target.value })}
            onBlur={saveOnBlur}
            placeholder={`Hi {firstName}, this is {senderName} with ${companyName(state)}:`}
          />
          <p className="mt-1 text-xs text-slate-500">
            {canEditIntro
              ? "Use {firstName} for the customer's first name and {senderName} for your name. Leave it blank to use the default intro."
              : existing
                ? `Only ${existing.name} can change this intro — it is shown here read-only so it is never overwritten by mistake.`
                : "A new user writes their own intro once they sign in."}
          </p>
        </div>
        {!selfOnly && (
          <>
            <div>
              <label className={labelCls()}>Calendar color</label>
              <input
                type="color"
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-1"
                value={form.color}
                onChange={(e) => setAndSave({ color: e.target.value })}
              />
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            // Safety net: a blur can be missed (e.g. the field never
            // lost focus before Done was tapped), so persist once
            // more. For a new user this is also the moment the row is
            // created if the form just became valid.
            persist(formRef.current);
            onDone();
          }}
          className={primaryBtn()}
        >
          Done
        </button>
        <p className="text-xs text-slate-500">
          {!created
            ? "Fill in a name — the user is created automatically."
            : !valid
              ? "A name is required — this change isn't saved yet."
              : "Changes save automatically."}
        </p>
      </div>
    </section>
  );
}
