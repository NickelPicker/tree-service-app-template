import { useEffect, useState } from "react";
import { useStore } from "../store";
import SkillsGrid from "./SkillsGrid";
import type { CrewMember, Role } from "../types";
import { money } from "../utils";
import { isOwnerLike } from "../permissions";
import { roleChangeQuestion, roleChangedNotice, roleName } from "../roleChange";
import {
  dangerBtn,
  inputCls,
  labelCls,
  primaryBtn,
  secondaryBtn,
} from "./ui";

const JOB_ROLES = ["Admin", "Climber", "Groundsman"];
const APP_ROLES: Array<{ value: Role; label: string }> = [
  { value: "owner", label: "Owner (admin)" },
  { value: "manager", label: "Manager" },
  { value: "office", label: "Office" },
  { value: "crew", label: "Crew" },
];

/**
 * The app roles a viewer may hand out. Only an owner can make someone
 * an owner; the database enforces the same rule.
 */
function rolesFor(viewerRole: Role): Array<{ value: Role; label: string }> {
  return viewerRole === "owner"
    ? APP_ROLES
    : APP_ROLES.filter((r) => r.value !== "owner");
}

/** One-line pay summary for a team row: "W-2 · $32/hr",
 * "1099 · 10% of job", "1099 · $250/day", or "not set yet". */
function payLabel(m: CrewMember): string {
  const emp =
    m.employmentType === "1099"
      ? "1099"
      : m.employmentType === "w2"
        ? "W-2"
        : null;
  let pay: string | null = null;
  if (m.payType === "hourly" && m.payAmount)
    pay = `${money(m.payAmount)}/hr`;
  else if (m.payType === "day" && m.payAmount)
    pay = `${money(m.payAmount)}/day`;
  else if (m.payType === "percent" && m.payAmount)
    pay = `${m.payAmount}% of job`;
  if (!emp && !pay) return "not set yet";
  return [emp, pay].filter(Boolean).join(" · ");
}

/**
 * One waiting signup: the owner picks the person's job role and app
 * role, then approves them (creates their membership — they can sign
 * in and see company data) or rejects them (removes the request).
 */
function PendingRow({
  member,
  busy,
  roleOptions,
  onApprove,
  onReject,
}: {
  member: CrewMember;
  busy: boolean;
  roleOptions: Array<{ value: Role; label: string }>;
  onApprove: (crewId: string, jobRole: string, appRole: Role) => void;
  onReject: (crewId: string) => void;
}) {
  const [jobRole, setJobRole] = useState("Groundsman");
  const [appRole, setAppRole] = useState<Role>("crew");
  return (
    <li className="rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-sm">
      <p className="font-semibold text-slate-900">
        {member.name} · {member.email || "no email"}
      </p>
      <p className="text-sm text-slate-600">
        Signed up in the app and waiting for approval. They can sign in
        but see no company data until you approve them.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>Job role</label>
          <select
            className={inputCls()}
            value={jobRole}
            disabled={busy}
            onChange={(e) => setJobRole(e.target.value)}
          >
            {JOB_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls()}>App role (permissions)</label>
          <select
            className={inputCls()}
            value={appRole}
            disabled={busy}
            onChange={(e) => setAppRole(e.target.value as Role)}
          >
            {roleOptions.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onApprove(member.id, jobRole, appRole)}
          disabled={busy}
          className={primaryBtn()}
        >
          {busy ? "Approving…" : "Approve"}
        </button>
        <button
          onClick={() => {
            if (
              window.confirm(
                `Reject ${member.name}'s signup request? Their login stays, but the request is removed — they can sign up again if you change your mind.`,
              )
            ) {
              onReject(member.id);
            }
          }}
          disabled={busy}
          className={dangerBtn()}
        >
          Reject
        </button>
      </div>
    </li>
  );
}

/**
 * Users page (admin). The Owner manages every crew member's profile
 * and login, and approves the people who signed up in the app.
 *
 * Onboarding flow: a new person taps "Create an account" on the
 * login screen (migration 006's trigger creates their roster row as
 * waiting for approval). The owner approves them here — picking job
 * role + app role — and they can sign in and work. The owner can
 * change anyone's app role here, or remove their access entirely.
 * People added with "+ New user" have a roster row but no login yet:
 * they sign up in the app with that same email and the login links
 * to their row automatically.
 */
export default function Users() {
  const {
    state,
    role,
    authUser,
    memberRoles,
    approveMember,
    rejectMember,
    revokeMember,
    changeMemberRole,
    deleteCrewMember,
    openEmployee,
    supabaseMode,
    loadTwoStepLogins,
    resetTwoStepLogin,
  } = useStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showSkills, setShowSkills] = useState(false);
  // Login ids with two-step login on (owners and managers can see this).
  const [twoStepOn, setTwoStepOn] = useState<string[]>([]);
  useEffect(() => {
    if (!supabaseMode || !isOwnerLike(role)) return;
    let cancelled = false;
    void loadTwoStepLogins().then((ids) => {
      if (!cancelled) setTwoStepOn(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [supabaseMode, role, loadTwoStepLogins]);
  const [error, setError] = useState<string | null>(null);
  // Member waiting in the "are you sure?" popup. Nothing is removed
  // until the popup's confirm button is tapped.
  const [confirmRemove, setConfirmRemove] = useState<CrewMember | null>(
    null,
  );
  // Role change waiting in its "are you sure?" popup, and the last
  // change made (for the Undo bar).
  const [confirmRole, setConfirmRole] = useState<{
    member: CrewMember;
    from: Role;
    to: Role;
  } | null>(null);
  const [lastRoleChange, setLastRoleChange] = useState<{
    member: CrewMember;
    from: Role;
    to: Role;
  } | null>(null);
  useEffect(() => {
    if (!lastRoleChange) return;
    const t = setTimeout(() => setLastRoleChange(null), 15000);
    return () => clearTimeout(t);
  }, [lastRoleChange]);

  if (!state) return null;
  if (!isOwnerLike(role)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Team</h1>
        <p className="text-sm text-slate-600">
          Only managers can view and manage user profiles and logins.
        </p>
      </div>
    );
  }

  /**
   * Remove someone from the team. With a login, this revokes their
   * access (soft delete): they disappear from the roster and from
   * every scheduling picker, but their login still signs in — it just
   * shows no company data — and an owner can reactivate them later.
   * Without a login (a day-hire who never signed up), there is no
   * login to preserve, so the roster row is removed outright. Either
   * way their jobs and timesheets stay.
   */
  const removeFromTeam = async (m: CrewMember): Promise<string | null> => {
    if (m.authUserId) return revokeMember(m.id);
    return deleteCrewMember(m.id);
  };

  const run = async (id: string, fn: () => Promise<string | null>) => {
    setBusyId(id);
    setError(null);
    const err = await fn();
    if (err) setError(err);
    setBusyId(null);
  };

  const viewerIsOwner = role === "owner";
  const roleOptions = rolesFor(role);
  const pending = state.crew.filter((c) => c.status === "pending");
  const team = state.crew.filter((c) => c.status !== "pending");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Team</h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowSkills((v) => !v)}
            className={secondaryBtn()}
          >
            {showSkills ? "Hide skills grid" : "🧰 Skills grid"}
          </button>
          <button
            onClick={() => openEmployee(null, true)}
            className={primaryBtn()}
          >
            + Add person
          </button>
        </div>
      </div>
      {showSkills && <SkillsGrid onClose={() => setShowSkills(false)} />}
      <p className="text-sm text-slate-600">
        Each crew member gets their own login — they create it on the
        login screen and you approve it here. Click anyone to open
        their profile, where you edit their details. Changing
        someone&apos;s app role changes what they can see and do.
      </p>
      {lastRoleChange && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          <span>{roleChangedNotice(lastRoleChange.member.name, lastRoleChange.to)}</span>
          <button
            onClick={() => {
              const c = lastRoleChange;
              setLastRoleChange(null);
              void run(c.member.id, () => changeMemberRole(c.member.id, c.from));
            }}
            className="min-h-11 rounded-lg border border-emerald-700 bg-white px-4 font-semibold text-emerald-800"
          >
            Undo
          </button>
        </div>
      )}
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold text-slate-900">
            Waiting for approval ({pending.length})
          </h2>
          <ul className="space-y-2">
            {pending.map((m) => (
              <PendingRow
                key={m.id}
                member={m}
                busy={busyId === m.id}
                roleOptions={roleOptions}
                onApprove={(id, jobRole, appRole) =>
                  void run(id, () => approveMember(id, jobRole, appRole))
                }
                onReject={(id) => void run(id, () => rejectMember(id))}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-slate-900">
          Team ({team.length})
        </h2>
        <ul className="space-y-2">
          {team.map((m) => {
            const isSelf =
              !!m.authUserId && !!authUser && m.authUserId === authUser.id;
            const memberRole = m.authUserId
              ? memberRoles[m.authUserId]
              : undefined;
            const busy = busyId === m.id;
            // Only an owner can change or remove an owner.
            const lockedOwner = memberRole === "owner" && !viewerIsOwner;
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
              >
                <button
                  onClick={() => openEmployee(m.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span
                    className="inline-block h-4 w-4 shrink-0 rounded-full"
                    style={{ backgroundColor: m.color }}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900 hover:text-emerald-700 hover:underline">
                      {m.name} · {m.role}
                      {m.status === "revoked" ? " · access removed" : ""}
                    </span>
                    <span className="block truncate text-sm text-slate-600">
                      {[
                        // The role shows once: in the dropdown when
                        // there is one, otherwise here.
                        memberRole && !lockedOwner && m.status !== "revoked"
                          ? null
                          : `${roleName(memberRole ?? m.appRole)} access`,
                        m.phone,
                        m.email,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="block truncate text-sm text-slate-500">
                      Pay: {payLabel(m)}
                    </span>
                    <span className="block truncate text-sm text-slate-500">
                      {m.authUserId
                        ? memberRole
                          ? "Login: active"
                          : "Login: linked, no access yet"
                        : "Login: none yet — they sign up in the app"}
                      {m.authUserId && twoStepOn.includes(m.authUserId)
                        ? " · 🔐 two-step login on"
                        : ""}
                    </span>
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  {m.status === "revoked" ? (
                    <button
                      onClick={() =>
                        void run(m.id, () =>
                          approveMember(m.id, m.role, m.appRole),
                        )
                      }
                      disabled={busy}
                      className={secondaryBtn()}
                    >
                      {busy ? "Working…" : "Reactivate"}
                    </button>
                  ) : lockedOwner ? (
                    <span className="text-sm font-semibold text-slate-600">
                      Owner
                    </span>
                  ) : memberRole ? (
                    <>
                      <select
                        aria-label={`App role for ${m.name}`}
                        className="min-h-11 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-semibold"
                        value={memberRole as Role}
                        disabled={busy || isSelf}
                        onChange={(e) => {
                          // Nothing changes until the popup's button
                          // is tapped.
                          const to = e.target.value as Role;
                          if (to !== memberRole)
                            setConfirmRole({ member: m, from: memberRole as Role, to });
                        }}
                      >
                        {(memberRole === "owner" ? APP_ROLES : roleOptions).map(
                          (r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ),
                        )}
                      </select>
                    </>
                  ) : m.authUserId ? (
                    <button
                      onClick={() =>
                        void run(m.id, () =>
                          approveMember(m.id, m.role, m.appRole),
                        )
                      }
                      disabled={busy}
                      className={secondaryBtn()}
                    >
                      {busy ? "Working…" : "Activate"}
                    </button>
                  ) : null}
                  {m.authUserId &&
                    twoStepOn.includes(m.authUserId) &&
                    !isSelf &&
                    !lockedOwner && (
                      <button
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Reset ${m.name}'s two-step login? Use this when they lost their phone. This also signs them out on every device (the lost phone included, within the hour). They sign in again with just their password and can turn it on again.`,
                            )
                          ) {
                            return;
                          }
                          const loginId = m.authUserId as string;
                          void run(m.id, async () => {
                            const err = await resetTwoStepLogin(m.id);
                            if (!err) {
                              setTwoStepOn((ids) => ids.filter((id) => id !== loginId));
                            }
                            return err;
                          });
                        }}
                        disabled={busy}
                        className={secondaryBtn()}
                      >
                        Reset two-step login
                      </button>
                    )}
                  {m.status !== "revoked" && !isSelf && !lockedOwner && (
                    <button
                      onClick={() => setConfirmRemove(m)}
                      disabled={busy}
                      className={dangerBtn()}
                    >
                      Remove from team
                    </button>
                  )}
                  <button
                    onClick={() => openEmployee(m.id, true)}
                    className={secondaryBtn()}
                  >
                    Edit
                  </button>

                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {confirmRole && (() => {
        const q = roleChangeQuestion(confirmRole.member.name, confirmRole.from, confirmRole.to);
        return (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
            onClick={() => setConfirmRole(null)}
            role="dialog"
            aria-modal="true"
            aria-label={q.title}
          >
            <div
              className="my-8 w-full max-w-lg rounded-2xl bg-slate-50 p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-xl font-bold text-slate-900">{q.title}</h2>
              <p className="mt-2 text-sm text-slate-700">{q.detail}</p>
              {q.warning && (
                <p className="mt-2 text-sm font-semibold text-amber-800">{q.warning}</p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmRole(null)}
                  className={`${secondaryBtn()} min-h-11`}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const c = confirmRole;
                    setConfirmRole(null);
                    void run(c.member.id, async () => {
                      const err = await changeMemberRole(c.member.id, c.to);
                      if (!err) setLastRoleChange(c);
                      return err;
                    });
                  }}
                  className={`${primaryBtn()} min-h-11`}
                >
                  Yes, make {q.title.replace(/^Make /, "").replace(/\?$/, "")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {confirmRemove && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
          onClick={() => setConfirmRemove(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Remove ${confirmRemove.name} from the team`}
        >
          <div
            className="my-8 w-full max-w-lg rounded-2xl bg-slate-50 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold text-slate-900">
              Remove {confirmRemove.name} from the team?
            </h2>
            {confirmRemove.authUserId ? (
              <p className="mt-2 text-sm text-slate-600">
                {confirmRemove.name} has a login, so this turns off their
                access instead of deleting them. They will no longer
                appear on the roster or be schedulable, and their login
                will still sign in but show no company data. You can
                reactivate them later. Their jobs and timesheets stay.
              </p>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                {confirmRemove.name} has no login yet, so there is
                nothing to turn off — their roster row will be deleted.
                This can&apos;t be undone. Their jobs and timesheets
                stay.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(null)}
                className={secondaryBtn()}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const m = confirmRemove;
                  setConfirmRemove(null);
                  void run(m.id, () => removeFromTeam(m));
                }}
                disabled={busyId === confirmRemove.id}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {confirmRemove.authUserId
                  ? "Turn off access"
                  : "Delete from team"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
