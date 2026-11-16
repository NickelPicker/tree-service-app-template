import { useState } from "react";
import { useStore } from "../store";
import type { Invoice } from "../types";
import {
  PAYMENT_METHODS,
  paymentMethodByCustomer,
  paymentMethodTotals,
} from "../payments";
import { fmtDate, money } from "../utils";
import { openCompose } from "../invoiceCompose";
import InvoiceChart, {
  invoiceOutstanding,
  invoiceTotal,
} from "./InvoiceChart";
import InvoiceReviewList from "./InvoiceReviewList";
import InvoiceSettingsPanel from "./InvoiceSettingsPanel";
import { invoiceWasEmailed } from "../invoiceMaking";
import { isOverdueInvoice } from "../todo";
import { businessToday } from "../overdueInvoice";
import {
  docTotals,
  inputCls,
  linkCls,
  primaryBtn,
  StatusBadge,
} from "./ui";

export default function Invoices() {
  const {
    state,
    openCustomer,
    openInvoice,
    canEdit,
    showMoney,
  } = useStore();
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [reportsOpen, setReportsOpen] = useState(false);

  if (!state) return null;
  const customerFor = (id: string) =>
    state.customers.find((x) => x.id === id) ?? null;
  const customerName = (id: string) => {
    const c = customerFor(id);
    return c ? `${c.firstName} ${c.lastName}` : "Unknown";
  };
  /** Search matches the customer's name or company, the invoice number, and line descriptions. */
  const matchesQuery = (i: Invoice) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const c = customerFor(i.customerId);
    const hay = [
      i.number,
      customerName(i.customerId),
      c?.companyName ?? "",
      ...i.lines.map((l) => l.description),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };
  // Overdue for the office: unpaid 10 business days past its due date
  // (Denver), the same rule as the Dashboard To-do (business rule).
  const today = businessToday();
  const shownStatus = (i: Invoice): Invoice["status"] =>
    i.status === "unpaid" && isOverdueInvoice(i, today) ? "overdue" : i.status;
  const filtered = state.invoices
    .filter((i) => filter === "all" || shownStatus(i) === filter)
    .filter(matchesQuery)
    .sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
  /** Totals follow the page: search + status filter change them. */
  const filteredTotal = filtered.reduce((s, i) => s + invoiceTotal(i), 0);
  const filteredOutstanding = filtered.reduce(
    (s, i) => s + invoiceOutstanding(i),
    0,
  );
  const typeSummary = (type: "commercial" | "residential") => {
    const list = filtered.filter(
      (i) => (customerFor(i.customerId)?.type ?? "residential") === type,
    );
    return {
      count: list.length,
      total: list.reduce((s, i) => s + invoiceTotal(i), 0),
      outstanding: list.reduce((s, i) => s + invoiceOutstanding(i), 0),
    };
  };
  const commercial = typeSummary("commercial");
  const residential = typeSummary("residential");
  const chartCustomerLabel = (id: string) => {
    const c = customerFor(id);
    return c?.companyName ?? customerName(id);
  };
  const chartCustomerType = (id: string) =>
    (customerFor(id)?.type ?? "residential") as
      | "commercial"
      | "residential";
  /**
   * Who pays by what — over ALL paid invoices, not this page's filter,
   * so the report always adds up to everything actually collected.
   * Money-gated: crew never sees it (same showMoney rule as
   * everywhere else).
   */
  const paidInvoices = state.invoices.filter((i) => i.status === "paid");
  const methodTotals = paymentMethodTotals(
    state.invoices,
    (i) => invoiceTotal(i),
  );
  const methodPaidTotal = (
    Object.values(methodTotals) as Array<{ count: number; total: number }>
  ).reduce((s, m) => s + m.total, 0);
  const methodHistory = paymentMethodByCustomer(
    state.invoices,
    state.customers,
    (i) => invoiceTotal(i),
  );
  const openCount = state.invoices.filter(
    (i) => i.status !== "paid" && invoiceTotal(i) > 0,
  ).length;
  const openTotal = state.invoices
    .filter((i) => i.status !== "paid")
    .reduce(
      (s, i) =>
        s +
        docTotals(
          i.lines,
          i.taxRate,
          i.discountType ?? "none",
          i.discountValue ?? 0,
        ).total,
      0,
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
        {canEdit && (
          <button
            onClick={openCompose}
            className={primaryBtn()}
          >
            + New invoice
          </button>
        )}
      </div>

      {/* Jobs marked done that got no invoice by themselves (also on the Dashboard). */}
      <InvoiceReviewList />

      {canEdit && <InvoiceSettingsPanel />}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-600">
          Outstanding balance:{" "}
          <span className="font-bold text-slate-900">
            {money(openTotal)}
          </span>{" "}
          across {openCount} open invoice{openCount === 1 ? "" : "s"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls()} w-72`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search invoices — customer, company, number, description…"
          aria-label="Search invoices"
        />
        {["all", "unpaid", "overdue", "paid"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              filter === s
                ? "bg-emerald-700 text-white"
                : "border border-slate-300 bg-white text-slate-700"
            }`}
          >
            {s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <p className="text-sm text-slate-600">
        Showing{" "}
        <span className="font-bold text-slate-900">{filtered.length}</span>{" "}
        invoice{filtered.length === 1 ? "" : "s"} · Total{" "}
        <span className="font-bold text-slate-900">
          {money(filteredTotal)}
        </span>{" "}
        · Outstanding{" "}
        <span className="font-bold text-slate-900">
          {money(filteredOutstanding)}
        </span>
      </p>

      <div className="space-y-4">
        <ul className="space-y-2">
          {filtered.map((i) => (
            <li key={i.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => openInvoice(i.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") openInvoice(i.id);
                }}
                className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm hover:border-emerald-500"
              >
                <div>
                  <p className="font-semibold text-slate-900">
                    {i.number} ·{" "}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openCustomer(i.customerId);
                      }}
                      className={linkCls()}
                    >
                      {customerName(i.customerId)}
                    </button>
                  </p>
                  <p className="text-sm text-slate-500">
                    Issued {fmtDate(i.issuedDate)} · Due {fmtDate(i.dueDate)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-slate-900">
                    {money(
                      docTotals(
                        i.lines,
                        i.taxRate,
                        i.discountType ?? "none",
                        i.discountValue ?? 0,
                      ).total,
                    )}
                  </p>
                  {invoiceWasEmailed(i) && (
                    <span className="mr-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                      Emailed
                    </span>
                  )}
                  <StatusBadge status={shownStatus(i)} />
                </div>
              </div>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="text-sm text-slate-500">No invoices match.</li>
          )}
        </ul>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <button
            onClick={() => setReportsOpen(!reportsOpen)}
            aria-expanded={reportsOpen}
            className="flex min-h-11 w-full items-center gap-2 text-left"
          >
            <span className="text-slate-500">{reportsOpen ? "▾" : "▸"}</span>
            <span className="text-base font-bold text-slate-900">Reports</span>
            <span className="text-sm text-slate-500">
              commercial vs residential, charts, who pays by what
            </span>
          </button>
          {reportsOpen && (
        <div className="mt-3 space-y-4">
          <h2 className="text-base font-bold text-slate-900">
            Commercial vs residential
          </h2>
          <p className="text-xs text-slate-500">
            For the invoices on this page — search and status filter apply.
          </p>
          {([
            ["Commercial", commercial],
            ["Residential", residential],
          ] as const).map(([label, s]) => (
            <div key={label} className="rounded-lg border border-slate-100 p-3">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900">{label}</p>
                <p className="font-bold text-slate-900">{money(s.total)}</p>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {s.count} invoice{s.count === 1 ? "" : "s"} · Outstanding{" "}
                {money(s.outstanding)}
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full ${
                    label === "Commercial" ? "bg-emerald-600" : "bg-sky-600"
                  }`}
                  style={{
                    width: `${
                      filteredTotal > 0
                        ? Math.round((s.total / filteredTotal) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {filteredTotal > 0
                  ? `${Math.round((s.total / filteredTotal) * 100)}% of the total on this page`
                  : "No total on this page"}
              </p>
            </div>
          ))}
          <div className="border-t border-slate-100 pt-3">
            <InvoiceChart
              invoices={filtered}
              customerLabel={chartCustomerLabel}
              customerType={chartCustomerType}
            />
          </div>
          {showMoney && (
            <div className="border-t border-slate-100 pt-3">
              <h2 className="text-base font-bold text-slate-900">
                Who pays by what
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Paid invoices only — all of them, not just this page&apos;s
                filter. Invoices paid before methods were recorded show as
                Not recorded.
              </p>
              <ul className="mt-2 space-y-1">
                {[
                  ...PAYMENT_METHODS.map((m) => ({
                    label: m.label,
                    ...methodTotals[m.value],
                  })),
                  {
                    label: "Not recorded",
                    ...methodTotals.unknown,
                  },
                ].map((row) => (
                  <li
                    key={row.label}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 p-2 text-sm"
                  >
                    <span className="font-semibold text-slate-900">
                      {row.label}
                      <span className="ml-1 font-normal text-slate-500">
                        × {row.count}
                      </span>
                    </span>
                    <span className="font-bold text-slate-900">
                      {money(row.total)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-slate-600">
                Total collected:{" "}
                <span className="font-bold text-slate-900">
                  {money(methodPaidTotal)}
                </span>{" "}
                across {paidInvoices.length} paid invoice
                {paidInvoices.length === 1 ? "" : "s"}
              </p>
              <h3 className="mt-3 text-sm font-bold text-slate-900">
                Per customer
              </h3>
              {methodHistory.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500">
                  No paid invoices yet.
                </p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {methodHistory.map((h) => (
                    <li
                      key={h.customerId}
                      className="rounded-lg border border-slate-100 p-2 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          onClick={() => openCustomer(h.customerId)}
                          className={linkCls()}
                        >
                          {h.customerName}
                        </button>
                        <span className="font-bold text-slate-900">
                          {money(h.paidTotal)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-600">
                        {[
                          ...PAYMENT_METHODS.map((m) => ({
                            label: m.label,
                            ...h.byMethod[m.value],
                          })),
                          {
                            label: "Not recorded",
                            ...h.byMethod.unknown,
                          },
                        ]
                          .filter((r) => r.count > 0)
                          .map(
                            (r) =>
                              `${r.label} ×${r.count} · ${money(r.total)}`,
                          )
                          .join(" — ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
          )}
        </section>
      </div>
    </div>
  );
}
