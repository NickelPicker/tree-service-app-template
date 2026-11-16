import { useState } from "react";
import { useStore } from "../store";
import type { Job, JobPriceChange } from "../types";
import {
  changeSummary,
  crewChangesFor,
  priceBoxLines,
  priceChanged,
  priceOf,
  REASON_MAX,
  reasonOk,
  unseenCrewChanges,
  type JobPrice,
} from "../priceChange";
import { showFlash } from "../flash";
import { fmtDateTime, money } from "../utils";
import { inputCls, labelCls, linkCls, MoneyInput, primaryBtn, secondaryBtn } from "./ui";

/**
 * Job price changes with a reason (the "invoice email by hand" rules; business rule). A Climber sees the current price, what it will change
 * to, and says why on the same box; the office is told on the
 * Dashboard and sees the reasons on the job.
 */

/**
 * The Climber's price box: current price, the new price as it is
 * typed (with the difference), and the reason. Save stays off until
 * the price changed and a reason is typed. Saves on its own, through
 * change_job_price; the job's own Save never sends a price.
 */
export function PriceChangeBox({
  job,
  onSaved,
  shown = null,
}: {
  /** The job as loaded (its current price). */
  job: Job;
  /** The price shown when it comes from the job's estimate, else null. */
  shown?: number | null;
  /** Called with the new price once the database took it. */
  onSaved: (price: JobPrice) => void;
}) {
  const { changeJobPrice } = useStore();
  const current = priceOf(job);
  const [draft, setDraft] = useState<JobPrice>(current);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = priceChanged(current, draft);
  const lines = priceBoxLines(current, draft, job.estimatedHours, shown);
  const canSave = changed && reasonOk(reason) && !busy;
  const hourly = draft.billingType === "hourly";

  const save = async () => {
    setError(null);
    setBusy(true);
    const err = await changeJobPrice(job.id, draft, reason);
    setBusy(false);
    if (err) return setError(`Not saved: ${err}`);
    showFlash("Price changed — the office has been told");
    setReason("");
    onSaved(draft);
  };

  return (
    <div
      className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:col-span-2"
      aria-label="Change the price"
    >
      <p className="text-sm font-semibold text-slate-800">Change the price</p>
      <p className="text-sm text-slate-800" data-testid="price-current">
        {lines.current}
      </p>
      <div>
        <label className={labelCls()} htmlFor={`pc-billing-${job.id}`}>
          Billed
        </label>
        <select
          id={`pc-billing-${job.id}`}
          className={inputCls()}
          value={hourly ? "hourly" : "flat"}
          onChange={(e) =>
            setDraft((d) => ({ ...d, billingType: e.target.value === "hourly" ? "hourly" : "flat" }))
          }
        >
          <option value="flat">Flat — one price for the job</option>
          <option value="hourly">Hourly — rate × hours</option>
        </select>
      </div>
      {hourly ? (
        <div>
          <label className={labelCls()}>New hourly rate ($/hr)</label>
          <MoneyInput
            value={draft.hourlyRate ?? 0}
            onChange={(n) => setDraft((d) => ({ ...d, hourlyRate: n === 0 ? null : n }))}
            placeholder="0.00"
          />
        </div>
      ) : (
        <div>
          <label className={labelCls()}>New job value ($)</label>
          <MoneyInput
            value={draft.value ?? 0}
            onChange={(n) => setDraft((d) => ({ ...d, value: n === 0 ? null : n }))}
            placeholder="0.00"
          />
        </div>
      )}
      {lines.next && (
        <p className="text-sm font-semibold text-emerald-800" data-testid="price-next">
          {lines.next}
        </p>
      )}
      {lines.next && job.estimateId && job.replacedPrice == null && (
        <p className="text-xs text-slate-600">The new price replaces the estimate&apos;s price.</p>
      )}
      <div>
        <label className={labelCls()} htmlFor={`pc-reason-${job.id}`}>
          Why did the price change? (the office sees this)
        </label>
        <textarea
          id={`pc-reason-${job.id}`}
          className={inputCls()}
          rows={2}
          maxLength={REASON_MAX}
          value={reason}
          placeholder="e.g. a second stump the estimate did not include"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!canSave} onClick={() => void save()} className={`${primaryBtn()} min-h-11`}>
          {busy ? "Saving…" : "Save new price"}
        </button>
        {changed && (
          <button
            type="button"
            onClick={() => {
              setDraft(current);
              setError(null);
            }}
            className={`${secondaryBtn()} min-h-11`}
          >
            Keep the current price
          </button>
        )}
        {changed && !reasonOk(reason) && (
          <span className="text-xs font-semibold text-amber-800">Say why to save the new price.</span>
        )}
      </div>
    </div>
  );
}

/**
 * A replaced price, struck through (business rule: "The replaced
 * price should be visible but have a strikethrough signifying void
 * pricing"). Nothing when there is none.
 */
export function OldPrice({ amount }: { amount: number | null }) {
  if (amount === null) return null;
  return (
    <>
      <del className="text-slate-400" title="Old price, no longer used" data-testid="old-price">
        {money(amount)}
      </del>{" "}
    </>
  );
}

/**
 * The job's price changes made by Climbers, with their reasons, newest
 * first (hidden when there are none). The office's own price edits are
 * not listed (business rule).
 */
export function PriceChangeHistory({ job }: { job: Job }) {
  const { state, role } = useStore();
  const list = crewChangesFor(state?.jobPriceChanges, job.id);
  if (list.length === 0) return null;
  const office = role !== "crew";
  return (
    <section className="mt-4 rounded-lg border border-slate-200 p-3" aria-label="Price changes">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Price changes</p>
      <ul className="divide-y divide-slate-100">
        {list.map((c) => (
          <li key={c.id} className="py-1.5 text-sm">
            <p className="text-slate-900">
              <span className="font-semibold">{changeSummary(c, job.estimatedHours)}</span>
              <span className="text-slate-500">
                {" "}
                · {c.changedByName || "Someone"} · {fmtDateTime(c.changedAt)}
              </span>
            </p>
            {c.reason && <p className="break-words italic text-slate-700">“{c.reason}”</p>}
            {office && (
              <p className="text-xs text-slate-500">
                {c.seenAt ? `Seen by ${c.seenBy ?? "the office"}` : "Not seen by the office yet"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MarkSeenButton({ change }: { change: JobPriceChange }) {
  const { markPriceChangeSeen } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void markPriceChangeSeen(change.id).then((err) => {
          setBusy(false);
          if (err) showFlash(`Not saved: ${err}`, { tone: "warn" });
        });
      }}
      className={`${secondaryBtn()} min-h-11`}
    >
      Mark seen
    </button>
  );
}

/** Dashboard card: crew price changes the office has not seen (staff only; hidden when empty). */
export function CrewPriceChangesCard() {
  const { state, role, openJob } = useStore();
  if (!state || role === "crew") return null;
  const unseen = unseenCrewChanges(state.jobPriceChanges);
  if (unseen.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm" aria-label="Prices changed by the crew">
      <h2 className="text-base font-bold text-slate-900">Prices changed by the crew</h2>
      <p className="text-sm text-slate-600">A Climber changed these prices on site. Check the reason, then mark it seen.</p>
      <ul className="mt-2 divide-y divide-slate-100">
        {unseen.map((c) => {
          const job = state.jobs.find((j) => j.id === c.jobId);
          return (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <button onClick={() => openJob(c.jobId)} className={linkCls()}>
                  {job?.title || "Job"}
                </button>
                <span className="text-sm text-slate-600">
                  {" "}
                  · {c.changedByName || "Crew"} · {fmtDateTime(c.changedAt)}
                </span>
                <p className="text-sm font-semibold text-slate-900">{changeSummary(c, job?.estimatedHours)}</p>
                {c.reason && <p className="break-words text-sm italic text-slate-600">“{c.reason}”</p>}
              </div>
              <span className="flex gap-2">
                <button onClick={() => openJob(c.jobId)} className={`${primaryBtn()} min-h-11`}>
                  Open job
                </button>
                <MarkSeenButton change={c} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
