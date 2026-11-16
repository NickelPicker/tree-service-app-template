import { useEffect, useState } from "react";
import { useStore } from "../store";
import {
  checkManualVisitSlot,
  customerCoords,
  formatVisitTime,
  visitSlotOptions,
} from "../scheduling";
import { todayStr } from "../utils";
import { secondaryBtn } from "./ui";
import type { Estimate } from "../types";

/**
 * Manual day + time picker for the estimator's estimate visits (Sales tab).
 *
 * The suggester's "Schedule it" only offers the suggested day/time;
 * customers often ask for a specific window, so the estimator needs to pick
 * one himself. Date input + half-hour time select (8 AM–5 PM, last
 * start 4:30 PM), prefilled with the suggestion when one exists or
 * the visit's current day/time when changing one.
 *
 * Rules, enforced live as the day/time change:
 * - a slot another visit already occupies is refused ("That slot is
 *   already booked") and never saved;
 * - weekend / holiday / closed day / past date / tight drive to a
 *   neighbouring visit show as amber warnings, never a block — the estimator
 *   is choosing deliberately for a customer request.
 * Saving calls the existing setEstimateVisit (no-op when unchanged,
 * audit-logged). The picker itself never writes anything else.
 */

const slotOptions = visitSlotOptions;

interface VisitPickerProps {
  estimate: Estimate;
  /** Prefill: the suggestion's day, or the visit's current day. */
  initialDate: string | null;
  /** Prefill: the suggestion's time, or the visit's current time. */
  initialTime: string | null;
  /** Close the picker (after a save, or on Cancel). */
  onDone: () => void;
}

export default function VisitPicker({
  estimate,
  initialDate,
  initialTime,
  onDone,
}: VisitPickerProps) {
  const { state, setEstimateVisit } = useStore();
  const [date, setDate] = useState(initialDate ?? todayStr());
  const [time, setTime] = useState(initialTime ?? "08:00");
  const [taken, setTaken] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Live slot check: re-runs on every day/time change. Geocoding is
  // cached, so this is cheap after the first lookup.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    (async () => {
      const cust = state.customers.find((c) => c.id === estimate.customerId);
      const coords = await customerCoords(cust);
      if (cancelled) return;
      const check = await checkManualVisitSlot(
        state,
        date,
        time,
        coords,
        estimate.id,
      );
      if (cancelled) return;
      setTaken(check.taken);
      setWarnings(check.warnings);
      if (check.taken) {
        setError("That slot is already booked — pick another time.");
      } else {
        setError(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, date, time, estimate]);

  const save = () => {
    if (taken) {
      setError("That slot is already booked — pick another time.");
      return;
    }
    setEstimateVisit(estimate.id, date, time);
    onDone();
  };

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Day
          <input
            type="date"
            value={date}
            min={todayStr()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal text-slate-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Time
          <select
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-normal text-slate-900"
          >
            {slotOptions().map((t) => (
              <option key={t} value={t}>
                {formatVisitTime(t)}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={save}
          className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-800"
        >
          Set visit
        </button>
        <button onClick={onDone} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {warnings.map((w) => (
            <li key={w} className="text-xs font-medium text-amber-700">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mt-2 text-xs font-semibold text-red-700">{error}</p>
      )}
    </div>
  );
}
