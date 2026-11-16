import { useState, type ReactNode } from "react";
import { useStore } from "../store";
import type { Customer } from "../types";
import { jobValue } from "../jobValue";
import {
  canSeeCustomerLogEntry,
  visibleJobsForViewer,
} from "../jobVisibility";
import { invoiceTotal } from "../splits";
import { fmtDate, money, todayStr } from "../utils";
import { newJobDate } from "../jobForm";
import { addressLine, telHref } from "../customerSearch";
import AuditList from "./AuditLog";
import MessageThread from "./MessageThread";
import PrivateNotesSection from "./PrivateNotes";
import TeamNotes from "./TeamNotes";
import CustomerSuggestions from "./CustomerSuggestions";
import { docTotals, primaryBtn, secondaryBtn, StatusBadge } from "./ui";

/** A folded section with a big tap target; closed until opened. */
function Fold({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-slate-500">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-bold text-slate-900">{title}</span>
        {count !== undefined && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
            {count}
          </span>
        )}
      </button>
      {open && <div className="border-t border-slate-100 p-3">{children}</div>}
    </section>
  );
}

const rowCls =
  "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left shadow-sm hover:border-emerald-500";

/**
 * The customer page, the same on the Customers tab and in the side
 * panel: phone (tap to call), address and gate code at the top, then
 * New estimate / New job / Text, the shared Team notes, then Jobs,
 * Estimates and Invoices. Everything else (property notes, private
 * notes, messages, tree map, activity log) sits in closed sections.
 */
export default function CustomerOverview({
  customer,
  headerActions,
  treeMap,
  footer,
}: {
  customer: Customer;
  /** Buttons at the top right (Edit, Close…). */
  headerActions?: ReactNode;
  /** The tree map / inventory block (full map on the Customers tab, a summary in the panel). */
  treeMap: ReactNode;
  /** Shown at the very bottom (e.g. Delete customer). */
  footer?: ReactNode;
}) {
  const {
    state,
    canEdit,
    canSeeAllJobs,
    viewerId,
    openJob,
    openEstimate,
    openInvoice,
    createJob,
    newEstimateFor,
    canMessageCustomers,
  } = useStore();
  const showMoney = useStore().showMoney;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [textMode, setTextMode] = useState(false);
  if (!state) return null;
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // Crew job rule (see src/jobVisibility.ts): a crew viewer without
  // the seeAllJobs override sees only their own jobs here, and the
  // activity log hides entries about jobs they cannot open.
  const jobs = visibleJobsForViewer(state, viewerId, canSeeAllJobs)
    .filter((j) => j.customerId === customer.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const logEntries = state.auditLog.filter(
    (e) =>
      e.customerId === customer.id &&
      canSeeCustomerLogEntry(state, e, viewerId, canSeeAllJobs),
  );
  const estimates = state.estimates
    .filter((e) => e.customerId === customer.id)
    .sort((a, b) => b.createdDate.localeCompare(a.createdDate));
  const invoices = state.invoices
    .filter((i) => i.customerId === customer.id)
    .sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
  const address = addressLine(customer);
  const name =
    `${customer.firstName} ${customer.lastName}`.trim() ||
    customer.companyName ||
    customer.company ||
    "Customer";
  const messagesOpen = open.messages || textMode;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-bold text-slate-900">
            {name}
            {customer.company && name !== customer.company ? ` · ${customer.company}` : ""}
          </h2>
          {customer.phone.trim() !== "" && (
            <a
              href={telHref(customer.phone)}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-50 px-3 text-base font-bold text-emerald-800 hover:bg-emerald-100"
            >
              📞 {customer.phone}
            </a>
          )}
          {address && <p className="text-sm text-slate-700">{address}</p>}
          {customer.gateCode && (
            <p className="text-sm font-semibold text-slate-900">
              Gate code: <span className="rounded bg-amber-100 px-1.5 py-0.5">{customer.gateCode}</span>
            </p>
          )}
          {customer.email ? (
            <a href={`mailto:${customer.email}`} className="block break-all text-sm text-emerald-800 underline">
              {customer.email}
            </a>
          ) : (
            <p className="text-sm text-amber-800">No email on file</p>
          )}
          {customer.noAutoEmails && (
            <p className="text-sm font-semibold text-amber-700">No automatic emails</p>
          )}
        </div>
        {headerActions && <div className="flex shrink-0 flex-wrap justify-end gap-2">{headerActions}</div>}
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => newEstimateFor(customer.id)} className={`${primaryBtn()} min-h-11`}>
            New estimate
          </button>
          <button
            onClick={() => createJob(newJobDate(null, todayStr(), state.closedDays), undefined, customer.id)}
            className={`${secondaryBtn()} min-h-11`}
          >
            New job
          </button>
          {canMessageCustomers && (
            <button
              onClick={() => setTextMode(true)}
              className={`${secondaryBtn()} min-h-11`}
            >
              Text
            </button>
          )}
        </div>
      )}

      <CustomerSuggestions customer={customer} />

      <TeamNotes customerId={customer.id} />

      {customer.type === "commercial" && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-slate-800">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sky-800">
            Commercial — project &amp; billing
          </p>
          {customer.companyName && <p><b>Company:</b> {customer.companyName}</p>}
          {customer.projectName && (
            <p>
              <b>Project:</b> {customer.projectName}
              {customer.projectNumber ? ` (${customer.projectNumber})` : ""}
            </p>
          )}
          {(customer.poNumber || customer.contractNumber) && (
            <p>
              {customer.poNumber && <><b>PO:</b> {customer.poNumber} </>}
              {customer.contractNumber && <><b>Contract:</b> {customer.contractNumber}</>}
            </p>
          )}
          {customer.jobSiteAddress && <p><b>Job site:</b> {customer.jobSiteAddress}</p>}
          {customer.billingTerms && <p><b>Billing terms:</b> {customer.billingTerms}</p>}
          {(customer.contacts ?? []).map((ct) => (
            <p key={ct.id}>
              {ct.name} · {ct.role}
              {ct.phone && (
                <>
                  {" · "}
                  <a href={telHref(ct.phone)} className="underline">{ct.phone}</a>
                </>
              )}
            </p>
          ))}
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Jobs ({jobs.length})
        </p>
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500">No jobs yet.</p>
        ) : (
          <ul className="space-y-2">
            {jobs.map((j) => {
              const v = jobValue(state, j);
              return (
                <li key={j.id}>
                  <button onClick={() => openJob(j.id)} className={rowCls}>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">{j.title}</span>
                      <span className="text-xs text-slate-500">
                        {fmtDate(j.date)} · {j.startTime} · {j.serviceType}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {v !== null && showMoney && (
                        <span className="text-sm font-semibold text-slate-900">{money(v)}</span>
                      )}
                      <StatusBadge status={j.status} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Estimates ({estimates.length})
        </p>
        {estimates.length === 0 ? (
          <p className="text-sm text-slate-500">No estimates yet.</p>
        ) : (
          <ul className="space-y-2">
            {estimates.map((e) => (
              <li key={e.id}>
                <button onClick={() => openEstimate(e.id)} className={rowCls}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-900">{e.title}</span>
                    <span className="text-xs text-slate-500">{fmtDate(e.createdDate)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {showMoney && (
                      <span className="text-sm font-semibold text-slate-900">
                        {money(docTotals(e.lines, e.taxRate, e.discountType ?? "none", e.discountValue ?? 0).total)}
                      </span>
                    )}
                    <StatusBadge status={e.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Invoices ({invoices.length})
        </p>
        {invoices.length === 0 ? (
          <p className="text-sm text-slate-500">No invoices yet.</p>
        ) : (
          <ul className="space-y-2">
            {invoices.map((i) => (
              <li key={i.id}>
                <button onClick={() => openInvoice(i.id)} className={rowCls}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-900">{i.number}</span>
                    <span className="text-xs text-slate-500">
                      Issued {fmtDate(i.issuedDate)} · due {fmtDate(i.dueDate)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {showMoney && (
                      <span className="text-sm font-semibold text-slate-900">{money(invoiceTotal(i))}</span>
                    )}
                    <StatusBadge status={i.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(customer.propertyNotes || customer.notes) && (
        <Fold title="Property notes" open={!!open.property} onToggle={() => toggle("property")}>
          {customer.propertyNotes && (
            <p className="whitespace-pre-wrap text-sm text-slate-700">{customer.propertyNotes}</p>
          )}
          {customer.notes && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{customer.notes}</p>
          )}
        </Fold>
      )}
      <Fold title="Private notes" open={!!open.private} onToggle={() => toggle("private")}>
        <PrivateNotesSection customerId={customer.id} />
      </Fold>
      <Fold
        title="Messages and calls"
        open={messagesOpen}
        onToggle={() => {
          if (messagesOpen) {
            setTextMode(false);
            setOpen((o) => ({ ...o, messages: false }));
          } else toggle("messages");
        }}
      >
        <MessageThread key={`${customer.id}-${textMode ? "sms" : "any"}`} customerId={customer.id} initialChannel="sms" />
      </Fold>
      <Fold title="Tree map and inventory" open={!!open.map} onToggle={() => toggle("map")}>
        {treeMap}
      </Fold>
      <Fold title="Activity log" count={logEntries.length} open={!!open.log} onToggle={() => toggle("log")}>
        <AuditList
          entries={logEntries}
          emptyText="No activity recorded yet. Every change made for this customer will appear here with who made it and when."
        />
      </Fold>
      {footer}
    </div>
  );
}
