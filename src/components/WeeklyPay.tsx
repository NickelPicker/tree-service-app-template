import { OVERTIME_RULES } from "../businessSettings";
import { Fragment, useEffect, useState } from "react";
import { useStore } from "../store";
import { addDaysISO, fmtDate, fmtDateTime, money } from "../utils";
import {
  changedSinceApproval,
  overtimeRuleText,
  payrollCsv,
  weeklyPayRows,
  weekTotals,
} from "../weeklyPay";
import {
  approveWeek,
  loadWeekApproval,
  undoWeekApproval,
  type WeekApproval,
} from "../weekApprovals";
import { linkCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * Owner/manager weekly pay view (top of Timesheets): hours and pay per
 * person for the week, overtime (OVERTIME_RULES), "Approve week" and "Download
 * for payroll" (a CSV made in the browser). See src/weeklyPay.ts.
 */
export default function WeeklyPay({
  weekMonday,
  week,
  onWeek,
}: {
  weekMonday: string;
  week: string[];
  onWeek: (monday: string) => void;
}) {
  const { state, openEmployee, viewerName } = useStore();
  const [approval, setApproval] = useState<WeekApproval | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setNote(null);
    void loadWeekApproval(weekMonday).then((a) => {
      if (cancelled) return;
      setApproval(a);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [weekMonday]);

  if (!state) return null;
  const rows = weeklyPayRows(state.crew, state.timesheets, week, undefined, {
    jobs: state.jobs,
    invoices: state.invoices,
  });
  const totals = weekTotals(rows);
  const anyOpen = rows.some((r) => r.openEntries > 0);
  const changed = approval ? changedSinceApproval(approval.totalHours, totals.hours) : false;

  const download = () => {
    const csv = payrollCsv(rows, week[0], week[6]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-week-of-${week[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const approve = async () => {
    if (busy) return;
    if (
      anyOpen &&
      !window.confirm(
        "Someone is still clocked in this week, so their open entry counts as 0 hours. Approve the week anyway?",
      )
    )
      return;
    setBusy(true);
    setNote(null);
    const r = await approveWeek(weekMonday, totals.hours, viewerName);
    setBusy(false);
    if (r.ok) setApproval(r.approval);
    else setNote(r.message);
  };

  const undo = async () => {
    if (busy || !window.confirm("Take back the approval for this week?")) return;
    setBusy(true);
    const ok = await undoWeekApproval(weekMonday);
    setBusy(false);
    if (ok) setApproval(null);
    else setNote("Could not undo the approval. Try again.");
  };

  return (
    <section className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-900">Weekly pay</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onWeek(addDaysISO(weekMonday, -7))}
            className={`${secondaryBtn()} min-h-11`}
          >
            ← Prev
          </button>
          <span className="text-sm font-semibold text-slate-800">
            {fmtDate(week[0])} – {fmtDate(week[6])}
          </span>
          <button
            onClick={() => onWeek(addDaysISO(weekMonday, 7))}
            className={`${secondaryBtn()} min-h-11`}
          >
            Next →
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No hours this week.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2">Person</th>
                <th className="py-2 text-right">Hours</th>
                <th className="py-2 text-right">Rate</th>
                <th className="py-2 text-right">Straight pay</th>
                <th className="py-2 text-right">Overtime extra</th>
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.crewId}>
                  <tr className="border-b border-slate-100 align-top">
                    <td className="py-2">
                      <button onClick={() => openEmployee(r.crewId)} className={linkCls()}>
                        {r.name}
                      </button>
                      <span className="text-slate-500"> · {r.role}</span>
                      {r.overtimeHours > 0 && (
                        <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">
                          Overtime: {r.overtimeHours.toFixed(1)} h ({overtimeRuleText(r)})
                        </span>
                      )}
                      {r.noOvertime && (
                        <span className="block text-xs text-slate-500">{overtimeRuleText(r)}</span>
                      )}
                      {r.overtimeUnpaid && (
                        <span className="block text-xs font-semibold text-red-800" role="note">
                          Overtime with no pay this week (no paid jobs yet). Check this by hand.
                        </span>
                      )}
                      {r.openEntries > 0 && (
                        <span className="ml-2 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                          Still clocked in
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right font-semibold text-slate-900">
                      {r.hours.toFixed(1)} h
                      {r.overtimeHours > 0 && (
                        <span className="block text-xs font-normal text-slate-500">
                          {r.regularHours.toFixed(1)} regular + {r.overtimeHours.toFixed(1)} overtime
                        </span>
                      )}
                      {r.fixedHours && (
                        <span className="block text-xs font-normal text-slate-500">fixed weekly hours</span>
                      )}
                      {r.payType === "day" && (
                        <span className="block text-xs font-normal text-slate-500">
                          {r.days} day{r.days === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right text-slate-700">
                      {r.rate === null
                        ? "Not set"
                        : r.payType === "hourly"
                          ? `${money(r.rate)}/h`
                          : r.payType === "day"
                            ? `${money(r.rate)}/day`
                            : r.payType === "percent"
                              ? `${r.rate}% of job`
                              : "Not set"}
                      {r.overtimeHours > 0 && r.regularRate !== null && r.payType !== "hourly" && (
                        <span className="block text-xs text-slate-500">
                          works out to {money(r.regularRate)}/h
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right text-slate-900">{r.pay === null ? "—" : money(r.pay)}</td>
                    <td className="py-2 text-right text-slate-900">
                      {r.overtimePremium === null ? "—" : r.overtimePremium > 0 ? money(r.overtimePremium) : ""}
                    </td>
                    <td className="py-2 text-right font-bold text-slate-900">
                      {r.total === null ? "—" : money(r.total)}
                    </td>
                  </tr>
                  {r.percent && (r.percent.paid.length > 0 || r.percent.waiting.length > 0) && (
                    <tr className="border-b border-slate-100">
                      <td colSpan={6} className="pb-2 pl-3 text-xs text-slate-600">
                        {r.percent.paid.length > 0 && (
                          <p>
                            <span className="font-semibold text-slate-800">Paid this week: </span>
                            {r.percent.paid
                              .map((j) => `${j.title}${j.amount !== null ? ` ${money(j.amount)}` : ""}`)
                              .join(" · ")}
                          </p>
                        )}
                        {r.percent.waiting.length > 0 && (
                          <p>
                            <span className="font-semibold text-slate-800">Waiting for payment: </span>
                            {r.percent.waiting
                              .map((j) => `${j.title}${j.amount !== null ? ` (${money(j.amount)})` : j.invoiceNumber ? "" : " (no invoice yet)"}`)
                              .join(" · ")}
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr>
                <td className="py-2 font-bold text-slate-900">Total</td>
                <td className="py-2 text-right font-bold text-slate-900">
                  {totals.hours.toFixed(1)} h
                </td>
                <td />
                <td className="py-2 text-right font-bold text-slate-900">{money(totals.pay)}</td>
                <td className="py-2 text-right font-bold text-slate-900">
                  {totals.overtimePremium > 0 ? money(totals.overtimePremium) : ""}
                </td>
                <td className="py-2 text-right font-bold text-slate-900">{money(totals.total)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-xs text-slate-500">
            {OVERTIME_RULES === "colorado"
              ? "Colorado overtime: hours over 40 in the week, over 12 in a day, or over 12 in a row (even past midnight), whichever is more."
              : "Overtime: hours over 40 in the week."}{" "}
            Overtime
            extra is half the person&apos;s average hourly pay for the week, for
            each overtime hour (the straight pay already covers those hours once).
            A short break between clock entries stays part of a stretch in a row.
            People on fixed weekly hours: those hours count, so overtime only
            over 40. No overtime for 1099 contractors.
            Percent people are paid their share of a job in the week its invoice
            is paid. &quot;—&quot; means no rate is set on that person&apos;s profile.
          </p>
        </div>
      )}

      {loaded && approval && (
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            changed ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"
          }`}
        >
          ✓ Approved by {approval.approvedBy || "an owner"}
          {approval.approvedAt ? ` on ${fmtDateTime(approval.approvedAt)}` : ""} ({approval.totalHours.toFixed(1)} h).
          {changed && " Hours have changed since then — check them and approve again."}
        </p>
      )}
      {note && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{note}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {(!approval || changed) && (
          <button
            onClick={() => void approve()}
            disabled={busy || !loaded || rows.length === 0}
            className={`${primaryBtn()} min-h-11`}
          >
            {busy ? "Saving…" : changed ? "Approve again" : "Approve week"}
          </button>
        )}
        <button
          onClick={download}
          disabled={rows.length === 0}
          className={`${secondaryBtn()} min-h-11`}
        >
          Download for payroll
        </button>
        {approval && (
          <button onClick={() => void undo()} disabled={busy} className={`${secondaryBtn()} min-h-11`}>
            Undo approval
          </button>
        )}
      </div>
    </section>
  );
}
