import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { canMarkJobDone, canTapJobStatus, doneNeedsConfirm } from "../liveProgress";
import type { Job, JobStatus } from "../types";

/** How long "Marked Done · Undo" stays up after a tap. */
export const UNDO_MS = 8000;

/**
 * Arrived / Done buttons for one job (live progress, day-plan
 * part 3). Renders nothing when the viewer may not tap the job (see
 * canTapJobStatus).
 *
 * - scheduled → "📍 Arrived" (→ in_progress) and "✓ Done" (→ done
 *   straight from scheduled, to be forgiving in the field).
 * - in_progress → "✓ Done".
 * - done → a "Mark not done" link.
 * - Done (and Mark not done) for everyone on the job, the office and
 *   owners (business rule). Groundsmen confirm Done with a
 *   second tap, "Yes, the job is finished", at the bottom of the screen
 *   (DoneConfirmSheet), so a phone in a pocket cannot finish a job.
 * - After a tap, "Marked Done · Undo" for 8 seconds.
 *
 * Buttons are at least 44 px tall: crew tap them with gloves on.
 */
/**
 * The confirm button ignores taps for this long after the sheet opens,
 * so a double tap (or a pocket) on Done cannot also hit "Yes".
 */
export const CONFIRM_ARM_MS = 700;

/**
 * Second step of Done for groundsmen: a sheet along the bottom of the
 * screen, far from the Done button on the card. Cancel is at the top of
 * the sheet, "Yes, the job is finished" at the very bottom; tapping
 * outside or pressing Escape cancels.
 */
function DoneConfirmSheet({
  title,
  onYes,
  onCancel,
}: {
  title: string;
  onYes: () => void;
  onCancel: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[70] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={`Finish ${title}?`}>
      <button type="button" aria-label="Cancel" className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative rounded-t-2xl bg-white px-4 pb-6 pt-3 shadow-2xl">
        <div className="mx-auto max-w-md">
          <div className="flex items-center justify-between gap-3">
            <p className="text-lg font-bold text-slate-900">Finish {title}?</p>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border-2 border-slate-300 bg-white px-4 text-base font-bold text-slate-800"
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 text-base text-slate-700">
            Only when the work is finished and the site is cleaned up. The office is told and the bill is made.
          </p>
          <button
            type="button"
            onClick={() => {
              if (armed) onYes();
            }}
            aria-disabled={!armed}
            className={`mt-10 inline-flex min-h-14 w-full items-center justify-center rounded-xl bg-emerald-700 px-4 text-lg font-bold text-white ${
              armed ? "hover:bg-emerald-800" : "opacity-60"
            }`}
          >
            ✓ Yes, the job is finished
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Recent taps by job id. A Done job moves to another place on the crew
 * screen (a new card), so the Undo lives here instead of in one card's
 * state and the new card shows it for the rest of its 8 seconds.
 */
const recentTaps = new Map<string, { label: string; prev: JobStatus; to: JobStatus; until: number }>();

export function JobStatusButtons({ job }: { job: Job }) {
  const { setJobStatus, viewerId, role, state } = useStore();
  const [confirming, setConfirming] = useState(false);
  const cancelConfirm = useCallback(() => setConfirming(false), []);
  const [undo, setUndoState] = useState<{ label: string; prev: JobStatus; to: JobStatus } | null>(() => {
    const r = recentTaps.get(job.id);
    return r && r.until > Date.now() ? { label: r.label, prev: r.prev, to: r.to } : null;
  });
  const setUndo = (u: { label: string; prev: JobStatus; to: JobStatus } | null) => {
    if (u) recentTaps.set(job.id, { ...u, until: Date.now() + UNDO_MS });
    else recentTaps.delete(job.id);
    setUndoState(u);
  };
  useEffect(() => {
    if (!undo) return;
    const left = (recentTaps.get(job.id)?.until ?? Date.now() + UNDO_MS) - Date.now();
    const t = window.setTimeout(() => {
      recentTaps.delete(job.id);
      setUndoState(null);
    }, Math.max(0, left));
    return () => window.clearTimeout(t);
  }, [undo, job.id]);
  if (!canTapJobStatus(job, viewerId, role)) return null;
  const jobRole = state?.crew.find((c) => c.id === viewerId)?.role;
  const canDone = canMarkJobDone(job, viewerId, role);
  const confirmDone = doneNeedsConfirm(role, jobRole);
  const tap = (to: JobStatus, label: string) => {
    const prev = job.status;
    setJobStatus(job.id, to);
    setUndo({ label, prev, to });
  };
  const big =
    "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-base font-bold";

  if (undo && job.status === undo.to) {
    return (
      <span
        role="status"
        className="inline-flex min-h-11 items-center gap-3 rounded-lg bg-slate-900 px-4 py-2 text-base font-semibold text-white"
      >
        {undo.label}
        <button
          type="button"
          onClick={() => {
            setJobStatus(job.id, undo.prev);
            setUndo(null);
          }}
          className="min-h-11 rounded px-2 font-bold text-amber-300 underline"
        >
          Undo
        </button>
      </span>
    );
  }
  if (job.status === "done") {
    if (!canDone) return null;
    return (
      <button
        type="button"
        onClick={() => tap("in_progress", "Marked not done")}
        className="min-h-11 px-1 text-base font-semibold text-slate-700 underline"
      >
        Mark not done
      </button>
    );
  }
  return (
    <span className="flex flex-wrap gap-2">
      {job.status === "scheduled" && (
        <button
          type="button"
          onClick={() => tap("in_progress", "Marked Arrived")}
          className={`${big} bg-emerald-700 text-white hover:bg-emerald-800`}
        >
          📍 Arrived
        </button>
      )}
      {canDone && (
        <button
          type="button"
          onClick={() => (confirmDone ? setConfirming(true) : tap("done", "Marked Done"))}
          className={`${big} border-2 border-slate-400 bg-white text-slate-800 hover:bg-slate-50`}
        >
          ✓ Done
        </button>
      )}
      {confirming && (
        <DoneConfirmSheet
          title={job.title}
          onCancel={cancelConfirm}
          onYes={() => {
            setConfirming(false);
            tap("done", "Marked Done");
          }}
        />
      )}
    </span>
  );
}
