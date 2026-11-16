import { useState } from "react";
import { useStore } from "../store";
import type { Estimate } from "../types";
import { customerDisplayName, filterEstimates, writtenBy } from "../estimateGroups";
import { estimateActiveTotals } from "../email";
import { money } from "../utils";
import EstimateForm from "./EstimateForm";
import {
  dangerBtn,
  linkCls,
  primaryBtn,
  secondaryBtn,
  StatusBadge,
} from "./ui";
import { estimateStatusLabel } from "../estimateStatus";

export default function Estimates() {
  const { state, deleteEstimate, openCustomer, canEdit, viewerId } = useStore();
  const [formMode, setFormMode] = useState<"new" | "edit" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // "Mine": only the estimates this person wrote.
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [needsOpen, setNeedsOpen] = useState(true);
  const [toScheduleOpen, setToScheduleOpen] = useState(true);
  const [doneOpen, setDoneOpen] = useState(false);

  if (!state) return null;
  const selected = state.estimates.find((e) => e.id === selectedId) ?? null;
  const customerName = (id: string) => {
    const c = state.customers.find((x) => x.id === id);
    return customerDisplayName(c);
  };
  // Status pills filter the whole list first; the groups below show
  // what's left of that filtered list.
  // The list is what the database lets this login read (a Sales login:
  // residential estimates and the ones he wrote, the "sales access refine" rules).
  const { needsAttention, toSchedule, finished } = filterEstimates(
    mineOnly ? writtenBy(state.estimates, viewerId) : state.estimates,
    state.customers,
    statusFilter,
    search,
    state.jobs,
  );
  const filtered = [...needsAttention, ...toSchedule, ...finished];

  const openEstimate = (e: Estimate) => {
    setSelectedId(e.id);
    setFormMode("edit");
  };

  // Slim row: customer + title + total + status. Job link, line count,
  // Queued pill, created date, job value, and the options/Accepted pills
  // live in the detail view (EstimateForm's summary strip) instead.
  const estimateRow = (e: Estimate) => (
    <li
      key={e.id}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
    >
      <div>
        <button
          onClick={() => openEstimate(e)}
          className="font-semibold text-slate-900 hover:text-emerald-700 hover:underline"
        >
          {e.title}
        </button>
        <p className="text-sm text-slate-600">
          <button
            onClick={() => openCustomer(e.customerId)}
            className={linkCls()}
          >
            {customerName(e.customerId)}
          </button>
        </p>
      </div>
      <div className="flex items-center gap-3">
        <p className="font-bold text-slate-900">
          {money(estimateActiveTotals(e).total)}
        </p>
        <StatusBadge status={e.status} />
        <button onClick={() => openEstimate(e)} className={secondaryBtn()}>
          {canEdit ? "Open" : "View"}
        </button>
        {canEdit && (
          <button
            onClick={() => {
              if (window.confirm("Delete this estimate?")) {
                deleteEstimate(e.id);
                if (selectedId === e.id) setSelectedId(null);
              }
            }}
            className={dangerBtn()}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );

  const groupHeader = (
    title: string,
    count: number,
    open: boolean,
    onToggle: () => void,
  ) => (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 text-left"
      aria-expanded={open}
    >
      <span className="text-slate-500">{open ? "▾" : "▸"}</span>
      <h2 className="text-base font-bold text-slate-900">{title}</h2>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
        {count}
      </span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Estimates</h1>
        {canEdit && (
          <button
            onClick={() => {
              setFormMode("new");
              setSelectedId(null);
            }}
            className={primaryBtn()}
          >
            + New estimate
          </button>
        )}
      </div>

      {formMode && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-base font-bold text-slate-900">
            {formMode === "new" ? "New estimate" : "Edit estimate"}
          </h2>
          <EstimateForm
            key={formMode === "edit" ? selected?.id ?? "edit" : "new"}
            existing={formMode === "edit" ? selected : null}
            onDone={() => setFormMode(null)}
          />
        </section>
      )}

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by customer or title…"
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
      />

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setMineOnly(!mineOnly)}
          aria-pressed={mineOnly}
          className={`rounded-full px-3 py-1 text-sm font-semibold ${
            mineOnly
              ? "bg-emerald-700 text-white"
              : "border border-slate-300 bg-white text-slate-700"
          }`}
        >
          Mine
        </button>
        {["all", "draft", "sent", "accepted", "closed"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              statusFilter === s
                ? "bg-emerald-700 text-white"
                : "border border-slate-300 bg-white text-slate-700"
            }`}
          >
            {s === "all" ? "All" : estimateStatusLabel(s)}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-slate-500">No estimates match.</p>
      )}

      {needsAttention.length > 0 && (
        <section className="space-y-2">
          {groupHeader(
            "Needs attention",
            needsAttention.length,
            needsOpen,
            () => setNeedsOpen(!needsOpen),
          )}
          {needsOpen && (
            <ul className="space-y-2">
              {needsAttention.map(estimateRow)}
            </ul>
          )}
        </section>
      )}

      {toSchedule.length > 0 && (
        <section className="space-y-2">
          {groupHeader(
            "Accepted — waiting to schedule",
            toSchedule.length,
            toScheduleOpen,
            () => setToScheduleOpen(!toScheduleOpen),
          )}
          {toScheduleOpen && (
            <ul className="space-y-2">{toSchedule.map(estimateRow)}</ul>
          )}
        </section>
      )}

      {finished.length > 0 && (
        <section className="space-y-2">
          {groupHeader("Booked or declined", finished.length, doneOpen, () =>
            setDoneOpen(!doneOpen),
          )}
          {doneOpen && (
            <ul className="space-y-2">{finished.map(estimateRow)}</ul>
          )}
        </section>
      )}
    </div>
  );
}
