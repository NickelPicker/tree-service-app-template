import { useCallback, useEffect, useState } from "react";
import { jobInvoicePricing, okToInvoiceWithOpenClock, okToMakeZeroInvoice } from "../invoiceMaking";
import { useLoadedState, useStore } from "../store";
import {
  dismissInvoiceReview,
  loadInvoiceReviews,
  REVIEW_REASONS,
  type InvoiceReview,
} from "../autoInvoice";
import { linkCls, secondaryBtn } from "./ui";

/**
 * Dashboard: jobs marked done that did NOT get an automatic invoice
 * because a person should look first (hourly, extra costs, no accepted
 * estimate...). Office only; hidden when empty. An item leaves the list
 * when an invoice is made for the job, the job is reopened, or the
 * office presses "Done".
 */
export default function InvoiceReviewList() {
  const { openJob, invoiceFromJob, openInvoice, canEdit, role } = useStore();
  const state = useLoadedState();
  const [items, setItems] = useState<InvoiceReview[]>([]);
  const staff = role !== "crew";
  const refresh = useCallback(() => {
    void loadInvoiceReviews().then(setItems);
  }, []);
  // Reload when jobs or invoices change (a teammate's Done, an invoice made here).
  useEffect(() => {
    if (staff) refresh();
  }, [staff, refresh, state.jobs, state.invoices]);
  if (!staff || items.length === 0) return null;

  return (
    <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">Needs invoice review</h2>
      <p className="text-sm text-slate-600">
        These jobs were marked done but no invoice was made by itself.
        Check each one and make its invoice.
      </p>
      <ul className="mt-2 divide-y divide-slate-100 text-sm">
        {items.map((r) => {
          const job = state.jobs.find((j) => j.id === r.jobId);
          const cust = state.customers.find((c) => c.id === (job?.customerId ?? r.customerId));
          const name = cust ? `${cust.firstName} ${cust.lastName}`.trim() : "";
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {job ? (
                  <button onClick={() => openJob(job.id)} className={linkCls()}>
                    {job.title || "Job"}
                  </button>
                ) : (
                  "Job"
                )}
                {name && <span className="text-slate-600"> · {name}</span>}
                <span className="block text-xs text-slate-500">
                  {REVIEW_REASONS[r.reason] ?? r.reason}
                </span>
              </span>
              <span className="flex gap-2">
                {canEdit && job && !job.invoiceId && (
                  <button
                    className={`${secondaryBtn()} min-h-11`}
                    onClick={() => {
                      if (!okToInvoiceWithOpenClock(state, job) || !okToMakeZeroInvoice(jobInvoicePricing(state, job).total)) return;
                      const id = invoiceFromJob(job.id);
                      if (id) openInvoice(id);
                    }}
                  >
                    Make invoice
                  </button>
                )}
                {job?.invoiceId && (
                  <button className={secondaryBtn()} onClick={() => openInvoice(job.invoiceId!)}>
                    Open invoice
                  </button>
                )}
                <button
                  className={`${secondaryBtn()} min-h-11`}
                  onClick={() => {
                    if (!window.confirm("Take this job off the list without an invoice? Only do this if no invoice is needed (or you billed it another way).")) return;
                    void dismissInvoiceReview(r.id).then(refresh);
                  }}
                >
                  No invoice needed
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
