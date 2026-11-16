import { useState } from "react";
import { useStore } from "../store";
import { saveBannerKind, useFieldQueue } from "../fieldQueue";
import { MapAppSetting } from "./NavigateButton";

/**
 * Crew phones: the account buttons (profile, map app, tour, two-step
 * login, sign out) behind one "Me" button, so the top of Today is the
 * day's work, not account chrome. Saving status stays visible.
 */
export default function CrewMeMenu({
  onTour,
  onTwoStep,
}: {
  onTour: () => void;
  onTwoStep: () => void;
}) {
  const { authUser, viewer, openEmployee, signOut, saveStatus, saveError, retrySave, unsavedNonField } = useStore();
  const queue = useFieldQueue();
  const unsent = queue.length;
  const offlineSaved =
    saveBannerKind(
      saveStatus,
      saveError,
      queue,
      typeof navigator === "undefined" ? true : navigator.onLine,
      unsavedNonField,
    ) ===
    "offline-saved";
  const [open, setOpen] = useState(false);
  const item =
    "flex min-h-11 w-full items-center rounded-lg px-3 py-2 text-left text-base font-semibold text-slate-900 hover:bg-slate-50";
  return (
    <div className="relative flex items-center gap-2">
      {saveStatus === "saving" && <span className="text-sm font-semibold text-slate-600">Saving…</span>}
      {saveStatus === "saved" && <span className="text-sm font-semibold text-emerald-700">✓ Saved</span>}
      {offlineSaved && (
        <span className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-bold text-amber-900">📶 Saved on phone</span>
      )}
      {saveStatus === "error" && !offlineSaved && (
        <button
          type="button"
          onClick={retrySave}
          className="min-h-11 rounded-lg bg-red-100 px-3 text-sm font-bold text-red-800"
        >
          Not saved — retry
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="min-h-11 rounded-full border-2 border-slate-300 bg-white px-4 text-base font-bold text-slate-900"
      >
        👤 Me {open ? "▴" : "▾"}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-[55] w-72 space-y-1 rounded-xl border border-slate-200 bg-white p-2 shadow-xl"
        >
          <p className="truncate px-3 py-1 text-sm text-slate-600">{authUser?.email}</p>
          {viewer && !viewer.id.startsWith("auth:") && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                openEmployee(viewer.id);
              }}
            >
              My profile
            </button>
          )}
          <div className="px-3 py-2">
            <MapAppSetting />
          </div>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onTour();
            }}
          >
            Take the tour
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onTwoStep();
            }}
          >
            🔐 Two-step login
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${item} text-red-800`}
            onClick={() => {
              // With taps still waiting, sign-out asks its own (louder) question.
              if (unsent > 0 || window.confirm("Sign out of the app on this phone?")) void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
