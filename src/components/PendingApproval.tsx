import { useStore } from "../store";
import { secondaryBtn } from "./ui";

/**
 * Waiting-for-approval screen. Shown in Supabase mode when someone is
 * signed in but has no company membership row yet — they signed up in
 * the app and an owner has not approved them, or an owner removed
 * their access. They see no company data at all: RLS locks every
 * table to members, and this screen keeps them out of the app shell
 * itself. The owner approves (or rejects) them from the Users page.
 */
export default function PendingApproval() {
  const { authUser, signOut } = useStore();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-lg font-bold text-slate-900">
          🌲 Waiting for approval
        </p>
        <p className="mt-1 text-sm text-slate-500">
          You signed in as{" "}
          <span className="font-semibold text-slate-900">
            {authUser?.email}
          </span>
          . Your login is waiting for the owner to approve it from the
          Team page — until then you can&apos;t see any company data.
          If you just signed up, give the owner a nudge; if your access
          was removed, ask them about it.
        </p>
        <button
          onClick={() => void signOut()}
          className={`${secondaryBtn()} mt-4 w-full`}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
