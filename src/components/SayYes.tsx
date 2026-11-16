import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Estimate } from "../types";
import { estimateActiveTotals } from "../email";
import { customerCoords, fmtDayShort, suggestDay, type SuggestedDay } from "../scheduling";
import { formatHHMM, resolvePlannerSettings } from "../planner/settings";
import { defaultOptionId, needsOptionPick, sayYesStep, scheduledText } from "../sayYes";
import { showFlash } from "../flash";
import { plainTime } from "../auditText";
import { addDaysISO, fmtDate, money, todayStr } from "../utils";
import { docTotals, inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * One button on an estimate: "Customer said yes → Schedule job".
 * It marks the estimate accepted (asking which option when there are
 * several), then offers the suggested day ("Schedule it" / "Pick
 * another day"). Choosing a day creates the job there and confirms
 * "Scheduled for Mon, Nov 16 at 7:00 AM — Open job · Plan that day".
 * Closing the panel before picking a day leaves the estimate accepted
 * and waiting in Schedule's "To schedule" list.
 */
export default function SayYes({
  estimate,
  onAccept,
  onScheduled,
}: {
  estimate: Estimate;
  /** Save the estimate as accepted (with the chosen option, if any). */
  onAccept: (optionId: string | null) => void;
  /** After the job is booked (the form closes). */
  onScheduled: () => void;
}) {
  const { state, canEdit, jobFromEstimate, openJob, setScheduleFocusDate, setView } = useStore();
  const [optionId, setOptionId] = useState<string | null>(() => defaultOptionId(estimate));
  const [suggestion, setSuggestion] = useState<SuggestedDay | null | "loading">(null);
  const [picking, setPicking] = useState(false);
  const dayStart = state ? formatHHMM(resolvePlannerSettings(state.settings.planner).dayStartMin) : "07:00";
  const [pickDate, setPickDate] = useState(() => addDaysISO(todayStr(), 1));
  const [pickTime, setPickTime] = useState(dayStart);
  const step = state ? sayYesStep(estimate, state.jobs) : "ask";
  const suggestOn = state?.settings.suggestDays !== false;

  // Find the suggested day once the estimate is accepted.
  useEffect(() => {
    if (step !== "schedule" || !state || !suggestOn) return;
    let cancelled = false;
    setSuggestion("loading");
    (async () => {
      const cust = state.customers.find((c) => c.id === estimate.customerId);
      const coords = await customerCoords(cust);
      if (cancelled) return;
      const s = await suggestDay(state, estimateActiveTotals(estimate).total, coords, null);
      if (!cancelled) setSuggestion(s);
    })().catch(() => {
      if (!cancelled) setSuggestion(null);
    });
    return () => {
      cancelled = true;
    };
    // Once per accepted estimate; later edits don't re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, estimate.id]);

  if (!state || !canEdit || step === "closed") return null;

  const book = (date: string, time: string) => {
    const jobId = jobFromEstimate(estimate.id, date, time);
    if (!jobId) return;
    showFlash(scheduledText(date, time), {
      actions: [
        { label: "Open job", run: () => openJob(jobId) },
        {
          label: "Plan that day",
          run: () => {
            setScheduleFocusDate(date);
            setView("schedule");
          },
        },
      ],
    });
    onScheduled();
  };

  if (step === "booked") {
    const job = state.jobs.find((j) => j.estimateId === estimate.id || j.id === estimate.jobId);
    return job ? (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
        Booked: <b>{job.title}</b> on {fmtDate(job.date)} at {job.startTime}.{" "}
        <button onClick={() => openJob(job.id)} className="min-h-11 font-semibold underline">
          Open job
        </button>
      </div>
    ) : null;
  }

  const options = estimate.options ?? [];

  if (step === "ask") {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4">
        <h3 className="text-base font-bold text-slate-900">Did the customer say yes?</h3>
        {options.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm text-slate-700">Which option did they pick?</legend>
            {options.map((o) => (
              <label
                key={o.id}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-white px-3 py-2 text-sm ${
                  optionId === o.id ? "border-emerald-600" : "border-slate-200"
                }`}
              >
                <input
                  type="radio"
                  name={`yes-option-${estimate.id}`}
                  checked={optionId === o.id}
                  onChange={() => setOptionId(o.id)}
                  className="h-5 w-5"
                />
                <span className="font-semibold">{o.label}</span>
                <span className="text-slate-600">
                  {money(docTotals(o.lines, estimate.taxRate, estimate.discountType ?? "none", estimate.discountValue ?? 0).total)}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <button
          onClick={() => onAccept(options.length > 0 ? optionId : null)}
          disabled={needsOptionPick(estimate, optionId)}
          className={`${primaryBtn()} min-h-11 w-full text-base sm:w-auto`}
        >
          Customer said yes → Schedule job
        </button>
        {needsOptionPick(estimate, optionId) && (
          <p className="text-xs text-slate-600">Pick the option they chose first.</p>
        )}
      </div>
    );
  }

  // step === "schedule": accepted, no job yet.
  const sug = suggestion === "loading" ? null : suggestion;
  return (
    <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4">
      <h3 className="text-base font-bold text-slate-900">Accepted ✓ — pick the day for the job</h3>
      {suggestOn && suggestion === "loading" && <p className="text-sm text-slate-600">Finding the best day…</p>}
      {sug && !picking && (
        <>
          <p className="text-sm text-slate-700">
            Suggested: <b>{fmtDayShort(sug.date)}</b> at {plainTime(dayStart)} — {sug.reason}
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => book(sug.date, dayStart)} className={`${primaryBtn()} min-h-11`}>
              Schedule it {fmtDayShort(sug.date)}
            </button>
            <button
              onClick={() => {
                setPickDate(sug.date);
                setPicking(true);
              }}
              className={`${secondaryBtn()} min-h-11`}
            >
              Pick another day
            </button>
          </div>
        </>
      )}
      {(picking || !suggestOn || suggestion === null) && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className={labelCls()} htmlFor={`yes-date-${estimate.id}`}>Day</label>
            <input
              id={`yes-date-${estimate.id}`}
              type="date"
              className={`${inputCls()} min-h-11`}
              value={pickDate}
              onChange={(e) => setPickDate(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls()} htmlFor={`yes-time-${estimate.id}`}>Start</label>
            <input
              id={`yes-time-${estimate.id}`}
              type="time"
              className={`${inputCls()} min-h-11`}
              value={pickTime}
              onChange={(e) => setPickTime(e.target.value)}
            />
          </div>
          <button
            onClick={() => pickDate && book(pickDate, pickTime || dayStart)}
            disabled={!pickDate}
            className={`${primaryBtn()} min-h-11`}
          >
            Schedule job
          </button>
        </div>
      )}
      <p className="text-xs text-slate-600">
        Not ready to pick a day? Close this — the job waits in Schedule → To schedule.
      </p>
    </div>
  );
}
