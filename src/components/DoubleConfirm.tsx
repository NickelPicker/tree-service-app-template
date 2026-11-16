import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SECOND_TAP_DELAY_MS, tapAllowed, type DoubleConfirmTexts } from "../doubleConfirm";

/**
 * The two "are you sure" dialogs for mass emails (owner's rule: more
 * than 3 emails at once). Step 1 sits at the TOP of the screen, step 2
 * at the BOTTOM, so the second yes is never under the finger that
 * pressed the first. Step 2's yes ignores taps for SECOND_TAP_DELAY_MS.
 * Escape, Cancel or a tap outside the box cancels. Use it through
 * useDoubleConfirm (src/useDoubleConfirm.tsx).
 */
export default function DoubleConfirm({
  texts,
  onDone,
}: {
  texts: DoubleConfirmTexts;
  onDone: (ok: boolean) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [ready, setReady] = useState(false);
  const openedAt = useRef(0);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  useEffect(() => {
    cancelRef.current?.focus();
    if (step !== 2) return;
    openedAt.current = Date.now();
    const t = window.setTimeout(() => setReady(true), SECOND_TAP_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [step]);

  const s = step === 1 ? texts.first : texts.second;
  const yes = () => {
    if (step === 1) {
      setReady(false);
      setStep(2);
      return;
    }
    if (!ready || !tapAllowed(openedAt.current, Date.now())) return;
    onDone(true);
  };
  const btn = "min-h-[44px] rounded-lg px-4 py-2 text-base font-semibold";

  return createPortal(
    <div
      className={`fixed inset-0 z-[1000] flex bg-slate-900/50 p-4 ${step === 1 ? "items-start" : "items-end"} justify-center`}
      style={{
        paddingTop: step === 1 ? "max(1rem, env(safe-area-inset-top))" : undefined,
        paddingBottom: step === 2 ? "max(1rem, env(safe-area-inset-bottom))" : undefined,
      }}
      onClick={() => onDone(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="double-confirm-title"
        aria-describedby={s.body ? "double-confirm-body" : undefined}
        className={`w-full max-w-md rounded-xl bg-white p-4 shadow-xl ${step === 2 ? "border-2 border-amber-500" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Step {step} of 2
        </p>
        <h2 id="double-confirm-title" className="mt-1 text-lg font-bold text-slate-900">
          {s.title}
        </h2>
        {s.body && (
          <p id="double-confirm-body" className="mt-1 text-sm text-slate-700">
            {s.body}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onDone(false)}
            className={`${btn} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={yes}
            aria-disabled={step === 2 && !ready}
            className={`${btn} text-white ${
              step === 2
                ? ready
                  ? "bg-amber-700 hover:bg-amber-800"
                  : "cursor-wait bg-amber-700 opacity-50"
                : "bg-emerald-700 hover:bg-emerald-800"
            }`}
          >
            {s.yes}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
