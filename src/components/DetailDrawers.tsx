import { useEffect } from "react";
import { useStore } from "../store";
import CustomerDrawer from "./CustomerDrawer";
import EmployeeDrawer from "./EmployeeDrawer";
import EstimateForm from "./EstimateForm";
import InvoiceDetail from "./InvoiceDetail";
import JobEditor from "./JobEditor";
import { JobSheetBody } from "./JobSheet";
import { mayChangeJob } from "../permissions";
import { secondaryBtn } from "./ui";

/**
 * The shared detail drawers, rendered once at the App level over
 * whatever page is open. Only the top of the stack is shown; closing
 * it returns to the drawer below (or the page itself), and the page
 * underneath never loses its state. No drawer ever navigates away.
 */
export default function DetailDrawers() {
  const {
    state,
    drawerStack,
    closeDrawer,
    invoiceFromJob,
    openInvoice,
    canEdit,
    canEditJobs,
    role,
    viewerId,
    openJob,
  } = useStore();

  const top = drawerStack[drawerStack.length - 1] ?? null;
  const canGoBack = drawerStack.length > 1;

  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, closeDrawer]);

  if (!state || !top) return null;

  // Title honesty for read-only viewers: a groundsman opening a job
  // sees "Job details", not "Edit job" — nothing is editable for them.
  // Crew logins open a job as the read-only job sheet (review:
  // one wrong tap in the office form could change the date or crew);
  // those allowed to edit get a small "Edit" link to the form.
  const crewSheet = top.kind === "job" && !!top.jobId && role === "crew" && !top.edit;
  // "See all jobs" shows crew every job, but a Climber changes only the
  // jobs he is on (the "rls tightening" rules).
  const topJob =
    top.kind === "job" && top.jobId
      ? (state.jobs.find((j) => j.id === top.jobId) ?? null)
      : null;
  const mayEditTopJob = mayChangeJob(topJob, viewerId, {
    canManage: canEdit,
    canEditJobs,
    dayCrews: state.dayCrews ?? [],
  });
  const title =
    crewSheet
      ? "Job sheet"
      : top.kind === "job"
      ? top.jobId
        ? mayEditTopJob
          ? "Edit job"
          : "Job details"
        : "New job"
      : top.kind === "employee"
        ? top.employeeId
          ? "Employee profile"
          : "Add a person"
        : top.kind === "customer"
          ? "Customer"
          : top.kind === "estimate"
            ? canEdit
              ? "Edit estimate"
              : "Estimate"
            : top.kind === "newEstimate"
              ? "New estimate"
              : "Invoice";
  const wide =
    top.kind === "estimate" || top.kind === "invoice" || top.kind === "newEstimate";

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={closeDrawer}
      />
      <div
        className={`absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-2xl ${
          wide ? "max-w-lg" : "max-w-md"
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <p className="text-sm font-semibold text-slate-500">
            {title} — the page stays open behind this panel
          </p>
          <div className="flex gap-2">
            {canGoBack && (
              <button onClick={closeDrawer} className={secondaryBtn()}>
                ← Back
              </button>
            )}
            <button onClick={closeDrawer} className={secondaryBtn()}>
              ✕ Close
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-24">
          {top.kind === "job" &&
            (() => {
              const job = top.jobId
                ? (state.jobs.find((j) => j.id === top.jobId) ?? null)
                : null;
              if (top.jobId && !job) {
                return (
                  <p className="text-sm text-slate-500">
                    This job no longer exists.
                  </p>
                );
              }
              if (crewSheet && job) {
                return (
                  <JobSheetBody
                    key={job.id}
                    job={job}
                    mine={job.crewIds.includes(viewerId)}
                    onEdit={
                      mayEditTopJob
                        ? () => {
                            closeDrawer();
                            openJob(job.id, { edit: true });
                          }
                        : undefined
                    }
                  />
                );
              }
              return (
                <JobEditor
                  key={top.jobId ?? "new"}
                  job={job}
                  defaultDate={top.defaultDate}
                  defaultStartTime={top.defaultStartTime}
                  defaultCustomerId={top.defaultCustomerId}
                  onClose={closeDrawer}
                  onInvoice={(jobId) => {
                    // Open the new invoice straight away, Send first.
                    const invId = invoiceFromJob(jobId);
                    if (invId) openInvoice(invId, { justCreated: true });
                  }}
                  onOpenInvoice={openInvoice}
                />
              );
            })()}
          {top.kind === "employee" && (
            <EmployeeDrawer
              key={top.employeeId ?? "new"}
              employeeId={top.employeeId}
              edit={top.edit}
              onClose={closeDrawer}
            />
          )}
          {top.kind === "customer" && (
            <CustomerDrawer customerId={top.customerId} />
          )}
          {top.kind === "estimate" &&
            (() => {
              const estimate = state.estimates.find(
                (e) => e.id === top.estimateId,
              );
              if (!estimate) {
                return (
                  <p className="text-sm text-slate-500">
                    This estimate no longer exists.
                  </p>
                );
              }
              return (
                <EstimateForm
                  key={estimate.id}
                  existing={estimate}
                  onDone={closeDrawer}
                  onInvoiceCreated={(invId) => {
                    closeDrawer();
                    if (invId) openInvoice(invId, { justCreated: true });
                  }}
                />
              );
            })()}
          {top.kind === "invoice" &&
            (() => {
              const invoice = state.invoices.find(
                (i) => i.id === top.invoiceId,
              );
              if (!invoice) {
                return (
                  <p className="text-sm text-slate-500">
                    This invoice no longer exists.
                  </p>
                );
              }
              return (
                <InvoiceDetail
                  key={invoice.id}
                  invoice={invoice}
                  justCreated={top.justCreated === true}
                />
              );
            })()}
          {top.kind === "newEstimate" && (
            <EstimateForm
              key={`new-${top.customerId}`}
              existing={null}
              initialCustomerId={top.customerId}
              onDone={closeDrawer}
            />
          )}
        </div>
      </div>
    </div>
  );
}
