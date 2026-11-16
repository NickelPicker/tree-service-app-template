import { useStore } from "../store";
import { jobValue } from "../jobValue";
import { fmtDate, fmtDateLong, money } from "../utils";
import { docTotals, StatusBadge } from "./ui";
import { NEW_YEAR_START, isNewYearRecord } from "../pipelineFilter";
import { estimateStatusLabel } from "../estimateStatus";

/**
 * Sales pipeline (kanban): Lead → Estimate → Proposal
 * → Job → Invoice → Paid. Stages are derived from the real records —
 * a customer with no estimate yet is a Lead; a sent multi-option
 * estimate is a Proposal; a scheduled job is a Job; an unpaid invoice
 * is an Invoice; a paid invoice is Paid. Cards open the record.
 */
export default function Pipeline() {
  const { state, openJob, openEstimate, openInvoice, openCustomer } =
    useStore();
  const showMoney = useStore().showMoney;
  if (!state) return null;

  const customerName = (id: string) => {
    const c = state.customers.find((x) => x.id === id);
    return c ? `${c.firstName} ${c.lastName}` : "Unknown customer";
  };

  // New-year only: the board restarts from Jan 2027. Every column
  // below is derived from these filtered sets, so an old record can
  // never drag its customer or job into a column via a link.
  // Customers carry no date, so only app-created customers can be
  // Leads. Invoices are judged on their issued date.
  const nyCustomers = state.customers.filter((c) =>
    isNewYearRecord(c.id),
  );
  const nyEstimates = state.estimates.filter((e) =>
    isNewYearRecord(e.id, e.createdDate),
  );
  const nyJobs = state.jobs.filter((j) => isNewYearRecord(j.id, j.date));
  const nyInvoices = state.invoices.filter((i) =>
    isNewYearRecord(i.id, i.issuedDate),
  );

  // Leads: customers with no estimate, job, or invoice yet.
  const leads = nyCustomers.filter(
    (c) =>
      !nyEstimates.some((e) => e.customerId === c.id) &&
      !nyJobs.some((j) => j.customerId === c.id) &&
      !nyInvoices.some((i) => i.customerId === c.id),
  );
  // Proposals: sent multi-option estimates not yet accepted.
  const proposals = nyEstimates.filter(
    (e) =>
      (e.options ?? []).length > 0 &&
      e.status === "sent" &&
      !e.acceptedOptionId,
  );
  // Estimates: draft/sent single-option estimates (and multi-option
  // ones that are still drafts), not yet accepted or invoiced.
  const estimates = nyEstimates.filter(
    (e) =>
      e.status !== "accepted" &&
      e.status !== "closed" &&
      !proposals.some((p) => p.id === e.id) &&
      !nyInvoices.some((i) => i.estimateId === e.id),
  );
  // Jobs: active jobs (scheduled or in progress).
  const jobs = nyJobs.filter((j) => j.status !== "done");
  // Invoices: open (unpaid / overdue / partial).
  const invoices = nyInvoices.filter((i) => i.status !== "paid");
  // Paid: paid invoices.
  const paid = nyInvoices.filter((i) => i.status === "paid");

  const columns: Array<{
    id: string;
    label: string;
    count: number;
    total?: number | null;
  }> = [
    { id: "lead", label: "Lead", count: leads.length },
    { id: "estimate", label: "Estimate", count: estimates.length },
    { id: "proposal", label: "Proposal", count: proposals.length },
    { id: "job", label: "Job", count: jobs.length },
    { id: "invoice", label: "Invoice", count: invoices.length },
    { id: "paid", label: "Paid", count: paid.length },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Sales pipeline</h1>
        <p className="text-sm text-slate-600">
          Every customer&apos;s work, from first contact to paid — drag
          nothing here yet; move a card by changing its record (send an
          estimate, accept a proposal, create the job, send the invoice,
          mark it paid).
        </p>
        <p className="mt-1 text-xs text-slate-500">
          New-year view — only work created in the app, or dated from{" "}
          {fmtDateLong(NEW_YEAR_START)}, shows here.
        </p>
      </div>
      {leads.length +
        estimates.length +
        proposals.length +
        jobs.length +
        invoices.length +
        paid.length ===
        0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-bold text-amber-900">
            Starting fresh for the new year.
          </p>
          <p className="mt-1 text-sm text-amber-800">
            Nothing here yet — new customers, estimates, jobs, and
            invoices will show up as you create them. Older work is
            still in Customers, Estimates, Jobs, and Invoices.
          </p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {columns.map((col) => (
          <section
            key={col.id}
            className="rounded-xl border border-slate-200 bg-slate-50 p-3"
          >
            <h2 className="text-sm font-bold text-slate-900">
              {col.label}{" "}
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">
                {col.count}
              </span>
            </h2>
            <div className="mt-3 space-y-2">
              {col.id === "lead" &&
                leads.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openCustomer(c.id)}
                    className="block w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm hover:border-emerald-500"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {c.firstName} {c.lastName}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {c.address}, {c.city}
                    </span>
                  </button>
                ))}
              {col.id === "estimate" &&
                estimates.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => openEstimate(e.id)}
                    className="block w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm hover:border-emerald-500"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {e.title}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {customerName(e.customerId)} · {estimateStatusLabel(e.status)}
                    </span>
                    {showMoney && (
                      <span className="block text-xs font-semibold text-slate-900">
                        {money(
                          docTotals(
                            e.lines,
                            e.taxRate,
                            e.discountType ?? "none",
                            e.discountValue ?? 0,
                          ).total,
                        )}
                      </span>
                    )}
                  </button>
                ))}
              {col.id === "proposal" &&
                proposals.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => openEstimate(e.id)}
                    className="block w-full rounded-lg border border-emerald-200 bg-white p-2 text-left shadow-sm hover:border-emerald-500"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {e.title}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {customerName(e.customerId)} ·{" "}
                      {(e.options ?? []).length} options
                    </span>
                    <span className="mt-1 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                      AWAITING CHOICE
                    </span>
                  </button>
                ))}
              {col.id === "job" &&
                jobs.map((j) => (
                  <button
                    key={j.id}
                    onClick={() => openJob(j.id)}
                    className="block w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm hover:border-emerald-500"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {j.title}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {customerName(j.customerId)} · {fmtDate(j.date)}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-1">
                      {(() => {
                        const v = jobValue(state, j);
                        return v !== null && showMoney ? (
                          <span className="text-xs font-semibold text-slate-900">
                            {money(v)}
                          </span>
                        ) : (
                          <span />
                        );
                      })()}
                      <StatusBadge status={j.status} />
                    </span>
                  </button>
                ))}
              {col.id === "invoice" &&
                invoices.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => openInvoice(i.id)}
                    className="block w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm hover:border-emerald-500"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {i.number} · {customerName(i.customerId)}
                    </span>
                    <span className="block text-xs text-slate-500">
                      Due {fmtDate(i.dueDate)}
                      {(i.splits ?? []).length > 0
                        ? ` · split ${(i.splits ?? []).length} ways`
                        : ""}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-1">
                      {showMoney && (
                        <span className="text-xs font-semibold text-slate-900">
                          {money(
                            docTotals(
                              i.lines,
                              i.taxRate,
                              i.discountType ?? "none",
                              i.discountValue ?? 0,
                            ).total,
                          )}
                        </span>
                      )}
                      <StatusBadge status={i.status} />
                    </span>
                  </button>
                ))}
              {col.id === "paid" &&
                paid.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => openInvoice(i.id)}
                    className="block w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm hover:border-emerald-500"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {i.number} · {customerName(i.customerId)}
                    </span>
                    <span className="block text-xs text-slate-500">
                      Paid {i.paidDate ? fmtDate(i.paidDate) : ""}
                    </span>
                    {showMoney && (
                      <span className="block text-xs font-semibold text-slate-900">
                        {money(
                          docTotals(
                            i.lines,
                            i.taxRate,
                            i.discountType ?? "none",
                            i.discountValue ?? 0,
                          ).total,
                        )}
                      </span>
                    )}
                  </button>
                ))}
              {col.count === 0 && (
                <p className="text-xs text-slate-400">Nothing here yet.</p>
              )}
            </div>
          </section>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Tip: open any card to work it. A proposal moves to Job when the
        customer accepts an option; a job moves to Invoice when you
        create the invoice from it.
      </p>
    </div>
  );
}
