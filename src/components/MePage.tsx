import { useStore } from "../store";
import Timesheets from "./Timesheets";

/**
 * "Me": the crew's own page — their profile (map app, phone, etc.),
 * two-step login, sign out, and their hours. Keeps these account
 * buttons in one place instead of crowding the phone header.
 */
export default function MePage({
  crewId,
  onTwoStep,
}: {
  crewId: string | null;
  onTwoStep: () => void;
}) {
  const { viewer, authUser, openEmployee, signOut, supabaseMode } = useStore();
  const hasProfile = !!viewer && !viewer.id.startsWith("auth:");
  const big =
    "flex min-h-12 w-full items-center justify-center rounded-xl px-4 text-base font-semibold";
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-lg font-bold text-slate-900">
          {viewer?.name ?? "Me"}
        </p>
        {authUser?.email && (
          <p className="text-sm text-slate-600">{authUser.email}</p>
        )}
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {hasProfile && (
            <button
              onClick={() => openEmployee(viewer.id)}
              className={`${big} bg-emerald-700 text-white`}
            >
              My profile & map app
            </button>
          )}
          {supabaseMode && (
            <button
              onClick={onTwoStep}
              className={`${big} border border-slate-300 bg-white text-slate-800`}
            >
              🔐 Two-step login
            </button>
          )}
          {supabaseMode && (
            <button
              onClick={() => void signOut()}
              className={`${big} border border-slate-300 bg-white text-slate-800`}
            >
              Sign out
            </button>
          )}
        </div>
      </section>
      <Timesheets crewId={crewId} />
    </div>
  );
}
