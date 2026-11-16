import { useLoadedState, useStore } from "../store";
import { jobsWithoutValue } from "../jobsWithoutValue";
import { fmtDate, todayStr } from "../utils";
import { linkCls } from "./ui";

/**
 * Dashboard: upcoming jobs with no dollar value, by name, so the
 * office can open each one and type a value. Shown only to people who
 * see money; hidden when there are none.
 */
export default function JobsWithoutValue() {
  const { openJob, showMoney, canEdit } = useStore();
  const state = useLoadedState();
  if (!showMoney || !canEdit) return null;
  const jobs = jobsWithoutValue(state, todayStr());
  if (jobs.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">
        {jobs.length} upcoming job{jobs.length === 1 ? " has" : "s have"} no value
      </h2>
      <p className="text-sm text-slate-600">
        The Plan board works out how long a job takes from its value ($400 = 1
        hour). Open each one and type a value, or link its estimate.
      </p>
      <ul className="mt-2 divide-y divide-slate-100 text-sm">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="font-semibold text-slate-900">{j.title || "Untitled job"}</span>
              <span className="text-slate-500"> · {fmtDate(j.date)}</span>
            </span>
            <button className={linkCls()} onClick={() => openJob(j.id, { edit: true })}>
              Add value
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
