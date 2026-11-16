import { useEffect, useState } from "react";
import { useLoadedState, useStore } from "../store";
import { isOwnerLike } from "../permissions";
import { loadAutomationStatus } from "../automationStatus";
import { setupChecklist, setupToDo } from "../setupChecklist";
import { todayStr } from "../utils";
import { secondaryBtn } from "./ui";

/**
 * "Finish setting up" (owners and managers): ticks itself from the
 * company's real data (src/setupChecklist.ts) and disappears once
 * everything is done.
 */
export default function SetupChecklistCard() {
  const { viewer, setView } = useStore();
  const state = useLoadedState();
  const admin = isOwnerLike(viewer?.appRole);
  const [gmailReady, setGmailReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!admin) return;
    let live = true;
    void loadAutomationStatus()
      .then((s) => live && setGmailReady(s?.gmailReady ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [admin]);
  if (!admin) return null;
  const items = setupChecklist({ state, today: todayStr(), gmailReady });
  const left = setupToDo(items);
  if (left.length === 0) return null;
  const done = items.length - left.length;
  return (
    <section className="rounded-xl border border-sky-200 bg-white p-4 shadow-sm" aria-label="Finish setting up">
      <h2 className="text-base font-bold text-slate-900">
        Finish setting up{" "}
        <span className="ml-1 text-sm font-semibold text-slate-500">
          {done} of {items.length} done
        </span>
      </h2>
      <p className="text-xs text-slate-500">Ticks itself as you go, and goes away when everything is done.</p>
      <ul className="mt-1 divide-y divide-slate-100">
        {left.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-semibold ${i.done ? "text-slate-400 line-through" : "text-slate-900"}`}>
                <span aria-hidden className="mr-1.5">{i.done ? "✅" : "⬜"}</span>
                {i.label}
                <span className="sr-only">{i.done ? " (done)" : " (to do)"}</span>
              </span>
              {!i.done && (
                <>
                  <span className="block text-xs text-slate-600">{i.how}</span>
                  {i.missing && <span className="block text-xs text-amber-800">{i.missing}</span>}
                </>
              )}
            </span>
            {!i.done && (
              <button onClick={() => setView(i.view)} className={`${secondaryBtn()} min-h-11 shrink-0`}>
                {i.button}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
