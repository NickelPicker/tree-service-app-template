import { useMemo, useState } from "react";
import { useStore } from "../store";
import { isOwnerLike } from "../permissions";
import { planSuggestions, type PlanSuggestion } from "../planner/learn";
import { resolvePlannerSettings } from "../planner/settings";
import { todayStr } from "../utils";

/** Most suggestions shown at once; the rest wait until these are handled. */
const MAX_SHOWN = 3;

/**
 * Plan board learning panel (staff only). One collapsed line,
 * "💡 2 suggestions from your recent plans", that opens into one-tap
 * Apply / Dismiss questions worked out in src/planner/learn.ts.
 * Shows nothing at all when there is nothing to suggest.
 */
export default function PlanInsights({ date }: { date: string }) {
  const { state, role, savePlannerSettings, saveCrewMember } = useStore();
  // Opening is per day: moving to another day folds it again.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === date;
  // Every Apply/Dismiss writes settings, which only owners and managers can save.
  const staff = isOwnerLike(role);
  const canEditCrew = isOwnerLike(role);

  const list = useMemo(() => {
    if (!state || !staff) return [];
    const settings = resolvePlannerSettings(state.settings.planner);
    try {
      return planSuggestions(state, settings, todayStr(), { canEditCrew }).slice(0, MAX_SHOWN);
    } catch {
      // Suggestions are a bonus: bad data never breaks the Plan board.
      return [];
    }
  }, [state, staff, canEditCrew]);

  if (!state || !staff || list.length === 0) return null;

  const dismiss = (s: PlanSuggestion) => {
    const before = state.settings.planner?.dismissedPlanSuggestions ?? [];
    savePlannerSettings({ dismissedPlanSuggestions: [...new Set([...before, s.key])] });
  };
  const apply = (s: PlanSuggestion) => {
    if (s.apply.type === "planner") savePlannerSettings(s.apply.patch);
    else for (const m of s.apply.updates) saveCrewMember(m);
  };

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-sm">
      <button
        type="button"
        onClick={() => setOpenFor(open ? null : date)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-semibold text-emerald-900"
      >
        <span>
          💡 {list.length} suggestion{list.length === 1 ? "" : "s"} from your recent plans
        </span>
        <span className="text-xs text-emerald-700">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="divide-y divide-emerald-100 border-t border-emerald-200">
          {list.map((s) => (
            <li key={s.key} className="space-y-2 px-3 py-2">
              <p className="text-slate-800">{s.text}</p>
              <p className="text-xs text-slate-500">{s.why}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => apply(s)}
                  className="min-h-9 rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => dismiss(s)}
                  className="min-h-9 rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
