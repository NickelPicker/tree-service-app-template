import { useState } from "react";
import { useStore } from "../store";
import type { Customer, CustomerEditRequest } from "../types";
import {
  approvalChanges,
  changeLines,
  changesText,
  currentValues,
  DECLINE_REASON_MAX,
  decisionText,
  diffSuggestion,
  FIELD_LABELS,
  maxLength,
  NOTE_FIELDS,
  pendingAll,
  pendingFor,
  recentDecided,
  suggestionSummary,
  SUGGESTABLE_FIELDS,
  type SuggestableField,
} from "../customerEdits";
import { showFlash } from "../flash";
import { fmtDate } from "../utils";
import { inputCls, labelCls, linkCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * Suggested customer changes (the "customer edit requests" rules). A Sales login
 * with a crew app role cannot edit a customer: it sends a suggestion,
 * which the office approves or declines.
 */

/** True for the viewer who suggests instead of editing (Sales, crew app role). */
export function useSuggestsInsteadOfEditing(): boolean {
  const { canSell, canEdit } = useStore();
  return canSell && !canEdit;
}

/** Office staff, managers and owners decide suggestions. */
function useDecides(): boolean {
  const { role } = useStore();
  return role !== "crew";
}

const fieldInput: Partial<Record<SuggestableField, { inputMode?: "tel" | "email" | "numeric"; type?: string }>> = {
  phone: { inputMode: "tel" },
  email: { type: "email" },
  zip: { inputMode: "numeric" },
};

/** The customer's fields, prefilled; sends only what was changed. */
export function SuggestCustomerEditForm({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const { suggestCustomerEdit } = useStore();
  const [form, setForm] = useState<Record<SuggestableField, string>>(() => currentValues(customer));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = diffSuggestion(customer, form);
  const changed = Object.keys(changes).length;

  const send = async () => {
    setError(null);
    if (changed === 0) return setError("Change at least one field first.");
    setBusy(true);
    const err = await suggestCustomerEdit(customer.id, changes, note);
    setBusy(false);
    if (err) return setError(`Not sent: ${err}`);
    showFlash("Sent to the office for approval");
    onClose();
  };

  return (
    <div className="space-y-3 rounded-xl border border-sky-200 bg-sky-50 p-3" aria-label="Suggest a change">
      <p className="text-sm font-bold text-slate-900">Suggest a change</p>
      <p className="text-xs text-slate-600">
        The office checks it before the customer changes.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {SUGGESTABLE_FIELDS.map((f) => {
          const id = `sg-${f}`;
          const isNote = NOTE_FIELDS.includes(f);
          const wide = f === "street" || f === "company" || isNote;
          return (
            <div key={f} className={wide ? "sm:col-span-2" : undefined}>
              <label className={labelCls()} htmlFor={id}>
                {FIELD_LABELS[f].charAt(0).toUpperCase() + FIELD_LABELS[f].slice(1)}
                {changes[f] !== undefined && <span className="ml-1 text-sky-700">• changed</span>}
              </label>
              {isNote ? (
                <textarea
                  id={id}
                  className={inputCls()}
                  rows={f === "property_notes" ? 3 : 2}
                  placeholder={f === "property_notes" ? "Access notes, trees on site, hazards, pets…" : undefined}
                  maxLength={maxLength(f)}
                  value={form[f]}
                  onChange={(e) => setForm((x) => ({ ...x, [f]: e.target.value }))}
                />
              ) : (
                <input
                  id={id}
                  className={inputCls()}
                  maxLength={maxLength(f)}
                  {...fieldInput[f]}
                  value={form[f]}
                  onChange={(e) => setForm((x) => ({ ...x, [f]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
        <div className="sm:col-span-2">
          <label className={labelCls()} htmlFor="sg-note">
            Note for the office (optional)
          </label>
          <input
            id="sg-note"
            className={inputCls()}
            maxLength={1000}
            value={note}
            placeholder="e.g. customer gave me the new number on site"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void send()} className={`${primaryBtn()} min-h-11`}>
          {busy ? "Sending…" : `Send to the office${changed > 0 ? ` (${changed} change${changed === 1 ? "" : "s"})` : ""}`}
        </button>
        <button type="button" onClick={onClose} className={`${secondaryBtn()} min-h-11`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * The office's review of one suggestion: before → after per field, the
 * "after" editable (prefilled with what was suggested) with an "Apply"
 * tick, then Approve, or Decline with an optional reason for the Sales
 * person.
 */
function ReviewCard({ customer, request }: { customer: Customer; request: CustomerEditRequest }) {
  const { decideCustomerEdit } = useStore();
  const lines = changeLines(customer, request.changes);
  const [after, setAfter] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.field, l.after])),
  );
  const [keep, setKeep] = useState<Set<string>>(() => new Set(lines.map((l) => l.field)));
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const edits = approvalChanges(request.changes, after, keep);
  const nothingLeft = edits !== null && Object.keys(edits).length === 0;

  const decide = async (d: "approve" | "decline") => {
    setBusy(true);
    const err = await decideCustomerEdit(
      request.id,
      d,
      d === "approve" ? { changes: edits } : { reason },
    );
    setBusy(false);
    if (err) showFlash(`Not saved: ${err}`, { tone: "warn" });
    else
      showFlash(
        d === "approve"
          ? edits
            ? "Approved with your changes — the customer is updated"
            : "Approved — the customer is updated"
          : "Suggestion declined",
      );
  };

  return (
    <div>
      <ul className="mt-1 space-y-2 text-sm">
        {lines.map((l) => {
          const id = `rv-${request.id}-${l.field}`;
          const on = keep.has(l.field);
          const isNote = NOTE_FIELDS.includes(l.field);
          return (
            <li key={l.field} className="break-words">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={id} className="font-semibold text-slate-700">
                  {capital(l.label)}
                </label>
                <label className="flex min-h-11 items-center gap-1 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      setKeep((k) => {
                        const n = new Set(k);
                        if (e.target.checked) n.add(l.field);
                        else n.delete(l.field);
                        return n;
                      })
                    }
                  />
                  Apply
                </label>
              </div>
              <p className="text-slate-500">
                Now: <span className="line-through">{l.before.trim() || "(blank)"}</span>
                {after[l.field] !== l.after && (
                  <span className="ml-2 text-slate-500">· suggested: {l.after.trim() || "(blank)"}</span>
                )}
              </p>
              {isNote ? (
                <textarea
                  id={id}
                  className={inputCls()}
                  rows={2}
                  disabled={!on}
                  maxLength={maxLength(l.field)}
                  value={after[l.field] ?? ""}
                  onChange={(e) => setAfter((x) => ({ ...x, [l.field]: e.target.value }))}
                />
              ) : (
                <input
                  id={id}
                  className={inputCls()}
                  disabled={!on}
                  maxLength={maxLength(l.field)}
                  {...fieldInput[l.field]}
                  value={after[l.field] ?? ""}
                  onChange={(e) => setAfter((x) => ({ ...x, [l.field]: e.target.value }))}
                />
              )}
            </li>
          );
        })}
      </ul>
      {request.note && <p className="mt-1 text-sm italic text-slate-600">“{request.note}”</p>}
      {edits && !nothingLeft && (
        <p className="mt-1 text-xs font-semibold text-sky-800">You changed the suggestion: {changesText(edits)}</p>
      )}
      {declining ? (
        <div className="mt-2 space-y-2">
          <label className={labelCls()} htmlFor={`rv-reason-${request.id}`}>
            Reason for {request.requestedName || "Sales"} (optional)
          </label>
          <input
            id={`rv-reason-${request.id}`}
            className={inputCls()}
            maxLength={DECLINE_REASON_MAX}
            value={reason}
            placeholder="e.g. we already have the newer number"
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void decide("decline")} className={`${primaryBtn()} min-h-11`}>
              Decline
            </button>
            <button disabled={busy} onClick={() => setDeclining(false)} className={`${secondaryBtn()} min-h-11`}>
              Back
            </button>
          </span>
        </div>
      ) : (
        <span className="mt-2 flex flex-wrap gap-2">
          <button
            disabled={busy || nothingLeft}
            onClick={() => void decide("approve")}
            className={`${primaryBtn()} min-h-11`}
          >
            {edits && !nothingLeft ? "Approve with changes" : "Approve"}
          </button>
          <button disabled={busy} onClick={() => setDeclining(true)} className={`${secondaryBtn()} min-h-11`}>
            Decline…
          </button>
        </span>
      )}
    </div>
  );
}

/** A Sales person's decided suggestions (last 30 days) with the office's answer. */
function RecentList({ items, showCustomer }: { items: CustomerEditRequest[]; showCustomer: boolean }) {
  const { state, openCustomer } = useStore();
  return (
    <ul className="mt-1 divide-y divide-slate-100">
      {items.map((r) => {
        const c = showCustomer ? state?.customers.find((x) => x.id === r.customerId) : undefined;
        const name = c ? `${c.firstName} ${c.lastName}`.trim() || c.company || "Customer" : "";
        return (
          <li key={r.id} className="py-2 text-sm">
            {c && (
              <button onClick={() => openCustomer(c.id)} className={linkCls()}>
                {name}
              </button>
            )}
            <p className="break-words text-slate-700">You suggested: {changesText(r.changes)}</p>
            <p
              className={`break-words font-semibold ${r.status === "declined" ? "text-amber-800" : "text-emerald-800"}`}
            >
              {decisionText(r)}
            </p>
            <p className="text-xs text-slate-500">
              {r.decidedBy ? `${r.decidedBy}, ` : ""}
              {r.decidedAt ? fmtDate(r.decidedAt.slice(0, 10)) : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * On the customer page: "Suggest a change" for a Sales login and its
 * waiting suggestions; for the office, every waiting suggestion with
 * Approve / Decline.
 */
export default function CustomerSuggestions({ customer }: { customer: Customer }) {
  const { state } = useStore();
  const suggests = useSuggestsInsteadOfEditing();
  const decides = useDecides();
  const [formOpen, setFormOpen] = useState(false);
  if (!state) return null;
  const pending = pendingFor(state.customerEditRequests, customer.id);
  const recent = suggests ? recentDecided(state.customerEditRequests, new Date(), customer.id) : [];
  if (!suggests && (!decides || pending.length === 0)) return null;

  return (
    <div className="space-y-2">
      {suggests && !formOpen && (
        <button onClick={() => setFormOpen(true)} className={`${secondaryBtn()} min-h-11`}>
          ✏️ Suggest a change
        </button>
      )}
      {suggests && formOpen && <SuggestCustomerEditForm customer={customer} onClose={() => setFormOpen(false)} />}
      {pending.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            {decides ? "Suggested customer changes" : "Your suggestions"}
          </p>
          <ul className="mt-1 divide-y divide-amber-100">
            {pending.map((r) => (
              <li key={r.id} className="py-2">
                {decides ? (
                  <>
                    <p className="text-sm text-slate-700">
                      {r.requestedName || "Sales"} suggested on {fmtDate(r.createdAt.slice(0, 10))}
                    </p>
                    <ReviewCard customer={customer} request={r} />
                  </>
                ) : (
                  <>
                    <p className="break-words text-sm text-slate-900">{suggestionSummary(r)}</p>
                    <p className="text-xs font-semibold text-amber-800">Waiting for office approval</p>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {recent.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Recent suggestions</p>
          <RecentList items={recent} showCustomer={false} />
        </section>
      )}
    </div>
  );
}

/**
 * Sales view: the Sales person's own suggestions decided in the last
 * 30 days, with the office's answer (hidden when there are none).
 */
export function MyRecentSuggestionsCard() {
  const { state } = useStore();
  const suggests = useSuggestsInsteadOfEditing();
  if (!state || !suggests) return null;
  const recent = recentDecided(state.customerEditRequests, new Date());
  const waiting = pendingAll(state.customerEditRequests).length;
  if (recent.length === 0 && waiting === 0) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">Your suggested customer changes</h2>
      {waiting > 0 && (
        <p className="text-sm text-amber-800">
          {waiting} waiting for office approval
        </p>
      )}
      {recent.length > 0 && <RecentList items={recent} showCustomer />}
    </section>
  );
}

/** Dashboard attention card: every waiting suggestion (office only; hidden when empty). */
export function SuggestedChangesCard() {
  const { state, openCustomer } = useStore();
  const decides = useDecides();
  if (!state || !decides) return null;
  const pending = pendingAll(state.customerEditRequests);
  if (pending.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">Suggested customer changes</h2>
      <p className="text-sm text-slate-600">
        Sales suggested these changes. Nothing changes until you approve.
      </p>
      <ul className="mt-2 divide-y divide-slate-100">
        {pending.map((r) => {
          const c = state.customers.find((x) => x.id === r.customerId);
          if (!c) return null;
          const name = `${c.firstName} ${c.lastName}`.trim() || c.company || "Customer";
          return (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="min-w-0 flex-1">
                <button onClick={() => openCustomer(c.id)} className={linkCls()}>
                  {name}
                </button>
                <span className="text-sm text-slate-600"> · {r.requestedName || "Sales"} suggested</span>
                <ReviewCard customer={c} request={r} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
