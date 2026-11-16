import { useState } from "react";
import { canMakeInvoiceForEstimate, estimateInvoicePricing, okToMakeZeroInvoice } from "../invoiceMaking";
import { useDraft, useStore } from "../store";
import { companyName } from "../company";
import type { DiscountType, Estimate, EstimateLine, ProposalOption } from "../types";
import { fmtDate, money, todayStr, uid } from "../utils";
import { jobValue } from "../jobValue";
import { estimateEmailPreview } from "../estimatePreview";
import { supabaseConfigured } from "../config";
import { estimateSendText } from "../estimateSend";
import { findSpeciesGuide } from "../treeGuide";
import AuditList from "./AuditLog";
import CustomerPicker from "./CustomerPicker";
import NeedsEmail from "./NeedsEmail";
import SayYes from "./SayYes";
import { sendBlockedReason } from "../sendReady";
import { showFlash } from "../flash";
import EmailPreview from "./EmailPreview";
import CrewAndEquipment from "./EstimateCrewEquipment";
import { estimateCrewChoices, estimateEquipmentChoices } from "../estimateCrew";
import {
  docTotals,
  inputCls,
  labelCls,
  linkCls,
  MoneyInput,
  primaryBtn,
  QtyInput,
  secondaryBtn,
} from "./ui";
import { ESTIMATE_STATUS_LABELS } from "../estimateStatus";

export type EstimateDraft = Omit<Estimate, "id" | "createdDate" | "emailQueuedAt">;

export const EMPTY_ESTIMATE = (customerId: string): EstimateDraft => ({
  customerId,
  jobId: null,
  title: "",
  lines: [{ id: uid(), description: "", quantity: 1, unitPrice: 0 }],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "draft",
  notes: "",
  expectedCrew: null,
  expectedClimbers: null,
  expectedGroundsmen: null,
  expectedCrewIds: null,
  equipmentIds: null,
  options: null,
  acceptedOptionId: null,
  acceptedBy: null,
  acceptedAt: null,
});

const OPTION_LABELS = ["Good", "Better", "Best"];

/** Line-item rows with an optional per-line tree link. */
function LineRows({
  lines,
  trees,
  onLine,
  onAdd,
  onRemove,
}: {
  lines: EstimateLine[];
  trees: Array<{ id: string; label: string; species: string }>;
  onLine: (id: string, patch: Partial<EstimateLine>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div>
      <div className="space-y-2">
        {lines.map((l) => (
          <div
            key={l.id}
            className="rounded-lg border border-slate-200 bg-white p-2"
          >
            <div className="grid grid-cols-12 items-center gap-2">
              <input
                className={`${inputCls()} col-span-6`}
                placeholder="Description"
                value={l.description}
                onChange={(e) =>
                  onLine(l.id, { description: e.target.value })
                }
              />
              <div className="col-span-2">
                <QtyInput
                  value={l.quantity}
                  onChange={(n) => onLine(l.id, { quantity: n })}
                />
              </div>
              <div className="col-span-3">
                <MoneyInput
                  value={l.unitPrice}
                  onChange={(n) => onLine(l.id, { unitPrice: n })}
                />
              </div>
              <button
                onClick={() => onRemove(l.id)}
                className="col-span-1 rounded-lg text-lg text-slate-400 hover:text-red-600"
                title="Remove line"
              >
                ×
              </button>
            </div>
            {(() => {
              const guide = findSpeciesGuide(l.description);
              return guide ? (
                <p className="mt-1 pl-1 text-xs italic text-slate-500">
                  {guide.botanical}
                </p>
              ) : null;
            })()}
            {trees.length > 0 && (
              <div className="mt-1 flex items-center gap-2 pl-1 text-xs text-slate-500">
                <label>Tree:</label>
                <select
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold"
                  value={l.treeId ?? ""}
                  onChange={(e) =>
                    onLine(l.id, { treeId: e.target.value || undefined })
                  }
                >
                  <option value="">Whole property</option>
                  {trees.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                      {t.species ? ` — ${t.species}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ))}
      </div>
      <button onClick={onAdd} className={`${secondaryBtn()} mt-2`}>
        + Add line
      </button>
    </div>
  );
}

/**
 * The one estimate form, shared by the Estimates page and the global
 * detail drawer. When `onInvoiceCreated` is given (drawer use), creating
 * an invoice hands its id back instead of navigating to Invoices.
 * `initialCustomerId` prefills the customer for a brand-new estimate
 * (the Sales tab's "Write estimate" button, the customer page's "New
 * estimate"); without it the Customer box starts empty and focused,
 * and Save/Send stay off until a customer is chosen. A prefilled customer
 * also gets its own new-estimate draft key, so starting an estimate
 * for one customer never restores another customer's draft.
 */
export default function EstimateForm({
  existing,
  onDone,
  onInvoiceCreated,
  initialCustomerId,
}: {
  existing: Estimate | null;
  onDone: () => void;
  onInvoiceCreated?: (invoiceId: string | null) => void;
  initialCustomerId?: string;
}) {
  const { state, saveEstimate, invoiceFromEstimate, openInvoice, queueEstimateEmail, canEdit, canSell, openJob } = useStore();
  // Sales people with a crew login write and change DRAFT estimates
  // (the database allows exactly that); sending, accepting and
  // invoicing stay with the office.
  const canWrite =
    canEdit || (canSell && (!existing || existing.status === "draft"));
  const draftKey = existing
    ? `estimate-edit-${existing.id}`
    : initialCustomerId
      ? `estimate-new-${initialCustomerId}`
      : "estimate-new";
  const initial: EstimateDraft = existing
    ? {
        customerId: existing.customerId,
        jobId: existing.jobId,
        title: existing.title,
        lines: existing.lines,
        taxRate: existing.taxRate,
        discountType: existing.discountType ?? "none",
        discountValue: existing.discountValue ?? 0,
        status: existing.status,
        notes: existing.notes,
        expectedCrew: existing.expectedCrew ?? null,
        expectedClimbers: existing.expectedClimbers ?? null,
        expectedGroundsmen: existing.expectedGroundsmen ?? null,
        expectedCrewIds: existing.expectedCrewIds ?? null,
        equipmentIds: existing.equipmentIds ?? null,
        options: existing.options ?? null,
        acceptedOptionId: existing.acceptedOptionId ?? null,
        acceptedBy: existing.acceptedBy ?? null,
        acceptedAt: existing.acceptedAt ?? null,
      }
    : // Never guess the customer: an empty box, unless the estimate
      // was started from a customer.
      EMPTY_ESTIMATE(initialCustomerId ?? "");
  const { value, setValue, restored, hasDraft, discard, replaceSaved } =
    useDraft<EstimateDraft>(draftKey, initial);
  const [showEmail, setShowEmail] = useState(false);
  const queuedNotice = false;
  // Live email: sending now, and what happened last time.
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<{ ok: boolean; text: string } | null>(null);
  // A new estimate keeps one id from its first save, so sending twice
  // (e.g. after a failed send) never makes a second copy.
  const [newId] = useState(() => uid());

  if (!state) return null;
  if (!restored) return <p className="text-sm text-slate-500">Loading form…</p>;

  const set = (patch: Partial<EstimateDraft>) =>
    setValue((prev) => ({ ...prev, ...patch }));
  const setLine = (id: string, patch: Partial<EstimateLine>) =>
    setValue((prev) => ({
      ...prev,
      lines: prev.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  const addLine = () =>
    setValue((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        { id: uid(), description: "", quantity: 1, unitPrice: 0 },
      ],
    }));
  const removeLine = (id: string) =>
    setValue((prev) => ({
      ...prev,
      lines: prev.lines.filter((l) => l.id !== id),
    }));

  const discountType: DiscountType = value.discountType ?? "none";
  const discountValue: number = value.discountValue ?? 0;
  const totals = docTotals(value.lines, value.taxRate, discountType, discountValue);
  const canSave =
    value.title.trim() !== "" && value.customerId !== "";
  const alreadyInvoiced = existing
    ? state.invoices.some((i) => i.estimateId === existing.id)
    : false;
  const customer =
    state.customers.find((c) => c.id === value.customerId) ?? null;
  const customerTrees = state.trees.filter((t) => t.customerId === value.customerId);
  const isQueued = queuedNotice || existing?.emailQueuedAt != null;
  const options = value.options ?? [];
  const hasOptions = options.length > 0;
  const acceptedOption = (existing?.options ?? []).find(
    (o) => o.id === existing?.acceptedOptionId,
  );
  /** Details that used to sit on the Estimates list row — created date,
   * line count, linked job + its value, options/Accepted, Queued — now
   * live here in the detail view instead. */
  const detailJob = existing?.jobId
    ? (state.jobs.find((j) => j.id === existing.jobId) ?? null)
    : null;
  const detailJobValue = detailJob ? jobValue(state, detailJob) : null;

  /** Keep `lines` in sync with the default (Better) option's lines, so
   * single-option code keeps working on multi-option estimates. */
  const syncLines = (opts: ProposalOption[]) => {
    const def =
      opts.find((o) => o.label === "Better") ?? opts[0];
    return def ? def.lines : value.lines;
  };

  const setOption = (id: string, patch: Partial<ProposalOption>) =>
    setValue((prev) => {
      const opts = (prev.options ?? []).map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      );
      return { ...prev, options: opts, lines: syncLines(opts) };
    });
  const setOptionLine = (
    optionId: string,
    lineId: string,
    patch: Partial<EstimateLine>,
  ) =>
    setValue((prev) => {
      const opts = (prev.options ?? []).map((o) =>
        o.id === optionId
          ? {
              ...o,
              lines: o.lines.map((l) =>
                l.id === lineId ? { ...l, ...patch } : l,
              ),
            }
          : o,
      );
      return { ...prev, options: opts, lines: syncLines(opts) };
    });
  const addOptionLine = (optionId: string) =>
    setValue((prev) => {
      const opts = (prev.options ?? []).map((o) =>
        o.id === optionId
          ? {
              ...o,
              lines: [
                ...o.lines,
                { id: uid(), description: "", quantity: 1, unitPrice: 0 },
              ],
            }
          : o,
      );
      return { ...prev, options: opts, lines: syncLines(opts) };
    });
  const removeOptionLine = (optionId: string, lineId: string) =>
    setValue((prev) => {
      const opts = (prev.options ?? []).map((o) =>
        o.id === optionId
          ? { ...o, lines: o.lines.filter((l) => l.id !== lineId) }
          : o,
      );
      return { ...prev, options: opts, lines: syncLines(opts) };
    });
  const enableOptions = () =>
    setValue((prev) => {
      const base = prev.lines.length > 0 ? prev.lines : [
        { id: uid(), description: "", quantity: 1, unitPrice: 0 },
      ];
      const opts: ProposalOption[] = OPTION_LABELS.map((label) => ({
        id: uid(),
        label,
        description:
          label === "Good"
            ? "The essential work."
            : label === "Better"
              ? "The recommended work."
              : "Everything, done completely.",
        lines: base.map((l) => ({ ...l, id: uid() })),
      }));
      return { ...prev, options: opts, lines: syncLines(opts) };
    });
  const disableOptions = () =>
    setValue((prev) => ({ ...prev, options: null }));
  const addOption = () =>
    setValue((prev) => {
      const opts = prev.options ?? [];
      if (opts.length >= 3) return prev;
      const label =
        OPTION_LABELS.find((l) => !opts.some((o) => o.label === l)) ?? "Option";
      const next: ProposalOption = {
        id: uid(),
        label,
        description: "",
        lines: [{ id: uid(), description: "", quantity: 1, unitPrice: 0 }],
      };
      const all = [...opts, next];
      return { ...prev, options: all, lines: syncLines(all) };
    });
  const removeOption = (id: string) =>
    setValue((prev) => {
      const opts = (prev.options ?? []).filter((o) => o.id !== id);
      return {
        ...prev,
        options: opts.length > 0 ? opts : null,
        lines: opts.length > 0 ? syncLines(opts) : prev.lines,
      };
    });

  const buildEstimate = (id: string): Estimate => ({
    ...value,
    id,
    createdDate: existing ? existing.createdDate : todayStr(),
    discountType,
    discountValue,
    emailQueuedAt: existing?.emailQueuedAt ?? null,
    // The visit is booked on the Sales calendar, not in this form:
    // keep it (saving used to drop it from the screen's copy).
    visitDate: existing?.visitDate ?? null,
    visitTime: existing?.visitTime ?? null,
  });

  const handleSave = () => {
    if (!canSave) return;
    saveEstimate(buildEstimate(existing ? existing.id : newId));
    discard();
    onDone();
  };

  // No email on the customer: Send is greyed out with the reason.
  const sendBlocked = customer ? sendBlockedReason(customer) : null;

  // Email the estimate. Live: saves it, then the send-estimate function
  // emails the customer with a private "Review and accept" link (and
  // records it in their message thread); once it went out the estimate
  // is Sent, the form closes and a line says where it went. Demo mode:
  // marks it queued and Sent, nothing leaves the browser.
  const handleQueueEmail = (again = false) => {
    if (!canSave || sending || sendBlocked) return;
    const id = existing ? existing.id : newId;
    const to = customer?.email.trim() ?? "";
    if (supabaseConfigured) {
      saveEstimate(buildEstimate(id));
      setSending(true);
      setSendNote(null);
      queueEstimateEmail(id, {
        again,
        onResult: (r) => {
          setSending(false);
          if (r.sent > 0) {
            discard();
            showFlash(`Sent to ${to} — now under Sent.`);
            onDone();
            return;
          }
          setSendNote({ ok: false, text: estimateSendText(r) });
        },
      });
      return;
    }
    const est = buildEstimate(id);
    saveEstimate({ ...est, status: est.status === "draft" ? "sent" : est.status });
    queueEstimateEmail(id);
    discard();
    showFlash(`Queued for ${to} — now under Sent. (Demo mode: no email leaves the app.)`);
    onDone();
  };

  // "Customer said yes": save it as accepted (with the chosen option).
  const handleAccept = (optionId: string | null) => {
    if (!existing) return;
    const accepted = {
      status: "accepted" as const,
      acceptedOptionId: optionId ?? value.acceptedOptionId ?? null,
      acceptedAt: value.acceptedAt ?? new Date().toISOString(),
    };
    saveEstimate({ ...buildEstimate(existing.id), ...accepted });
    // The form now matches what was saved: no "draft" left over.
    replaceSaved({ ...value, ...accepted });
  };

  const emailPreview =
    customer && value.title.trim() !== ""
      ? estimateEmailPreview(
          buildEstimate(existing ? existing.id : "preview"),
          customer,
          {
            name: companyName(state),
            phone: state.settings.company?.phone ?? "",
            email: state.settings.company?.email ?? "",
          },
        )
      : null;

  return (
    <div className="space-y-4">
      {!canWrite && (
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
          You can look at this estimate. The office or an owner can change it.
        </p>
      )}
      {hasDraft && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            Draft restored — your unsaved changes were kept automatically.
          </span>
          {canWrite && (
            <button
              onClick={discard}
              className="shrink-0 font-semibold underline"
            >
              Discard draft
            </button>
          )}
        </div>
      )}
      {existing && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Created {fmtDate(existing.createdDate)} · {value.lines.length} line
          item{value.lines.length === 1 ? "" : "s"}
          {detailJob && (
            <>
              {" · Job: "}
              <button
                onClick={() => openJob(detailJob.id)}
                className={linkCls()}
              >
                {detailJob.title}
              </button>
              {detailJobValue !== null ? ` (${money(detailJobValue)})` : ""}
            </>
          )}
          {(existing.options ?? []).length > 1 && (
            <> · {(existing.options ?? []).length} options</>
          )}
          {acceptedOption && <> · Accepted: {acceptedOption.label}</>}
          {isQueued && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Queued
            </span>
          )}
        </p>
      )}
      {/* A disabled fieldset switches every editing control off at once
          for read-only viewers (groundsmen) — selects, inputs, line
          add/remove — while the preview and history below stay open. */}
      <fieldset disabled={!canWrite} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>Customer</label>
          <CustomerPicker
            value={value.customerId}
            onChange={(customerId) => set({ customerId })}
            autoFocus={!existing && value.customerId === ""}
            placeholder="Type a customer name or phone…"
          />
          {value.customerId === "" && (
            <p className="mt-1 text-xs font-semibold text-amber-800">
              Choose a customer before saving or sending.
            </p>
          )}
        </div>
        <div>
          <label className={labelCls()}>Status</label>
          <select
            className={inputCls()}
            value={value.status}
            disabled={!canEdit}
            title={canEdit ? undefined : "The office changes the status (sent, accepted, declined)."}
            onChange={(e) =>
              set({ status: e.target.value as EstimateDraft["status"] })
            }
          >
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="accepted">Accepted</option>
            <option value="closed">{ESTIMATE_STATUS_LABELS.closed}</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Estimate title</label>
          <input
            className={inputCls()}
            value={value.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="e.g. Backyard cottonwood removal"
          />
        </div>
      </div>

      {customer?.type === "commercial" && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <span className="font-semibold">Commercial — {customer.companyName ?? customer.company}</span>
          {customer.projectName && (
            <>
              <br />
              Project: {customer.projectName}
              {customer.projectNumber ? ` (${customer.projectNumber})` : ""}
            </>
          )}
          {customer.poNumber && (
            <>
              <br />
              PO: {customer.poNumber}
              {customer.contractNumber ? ` · Contract: ${customer.contractNumber}` : ""}
            </>
          )}
          {customer.billingTerms && (
            <>
              <br />
              Billing terms: {customer.billingTerms}
            </>
          )}
        </p>
      )}

      {!hasOptions ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Line items
            </p>
            <button onClick={enableOptions} className={secondaryBtn()}>
              Offer multiple options (Good / Better / Best)
            </button>
          </div>
          <LineRows
            lines={value.lines}
            trees={customerTrees}
            onLine={setLine}
            onAdd={addLine}
            onRemove={removeLine}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Proposal options — the customer picks one
            </p>
            <div className="flex gap-2">
              {options.length < 3 && (
                <button onClick={addOption} className={secondaryBtn()}>
                  + Add option
                </button>
              )}
              <button onClick={disableOptions} className={secondaryBtn()}>
                Back to single option
              </button>
            </div>
          </div>
          {options.map((o) => {
            const ot = docTotals(o.lines, value.taxRate, discountType, discountValue);
            const isAccepted = existing?.acceptedOptionId === o.id;
            return (
              <section
                key={o.id}
                className={`rounded-xl border p-3 shadow-sm ${
                  isAccepted ? "border-emerald-600 bg-emerald-50" : "border-slate-200 bg-white"
                }`}
              >
                <div className="mb-2 grid gap-2 sm:grid-cols-3">
                  <div>
                    <label className={labelCls()}>Option</label>
                    <select
                      className={inputCls()}
                      value={o.label}
                      onChange={(e) => setOption(o.id, { label: e.target.value })}
                    >
                      {OPTION_LABELS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelCls()}>What this option includes</label>
                    <input
                      className={inputCls()}
                      value={o.description}
                      onChange={(e) =>
                        setOption(o.id, { description: e.target.value })
                      }
                      placeholder="e.g. Prune only — keeps the tree."
                    />
                    {(() => {
                      const guide = findSpeciesGuide(o.description);
                      return guide ? (
                        <p className="mt-1 text-xs italic text-slate-500">
                          {guide.botanical}
                        </p>
                      ) : null;
                    })()}
                  </div>
                </div>
                <LineRows
                  lines={o.lines}
                  trees={customerTrees}
                  onLine={(lineId, patch) => setOptionLine(o.id, lineId, patch)}
                  onAdd={() => addOptionLine(o.id)}
                  onRemove={(lineId) => removeOptionLine(o.id, lineId)}
                />
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-sm text-slate-700">
                    Option total:{" "}
                    <span className="font-bold">{money(ot.total)}</span>
                    {isAccepted && (
                      <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">
                        ACCEPTED
                      </span>
                    )}
                  </p>
                  {options.length > 1 && (
                    <button
                      onClick={() => removeOption(o.id)}
                      className="text-sm font-semibold text-red-700 hover:underline"
                    >
                      Remove option
                    </button>
                  )}
                </div>
              </section>
            );
          })}
          <p className="text-xs text-slate-500">
            The customer picks one option; the accepted option&apos;s lines
            become the job. The estimate&apos;s headline total follows the
            Better option until one is accepted.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>Discount</label>
          <div className="flex gap-2">
            <select
              className={inputCls()}
              value={discountType}
              onChange={(e) =>
                set({ discountType: e.target.value as DiscountType })
              }
            >
              <option value="none">No discount</option>
              <option value="percent">Percent off</option>
              <option value="fixed">Fixed $ off</option>
            </select>
            {discountType === "percent" && (
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="1"
                  className={inputCls()}
                  value={discountValue}
                  onChange={(e) =>
                    set({ discountValue: Number(e.target.value) })
                  }
                />
                <span className="text-sm font-semibold text-slate-500">%</span>
              </span>
            )}
            {discountType === "fixed" && (
              <MoneyInput
                value={discountValue}
                onChange={(n) => set({ discountValue: n })}
              />
            )}
          </div>
        </div>
        <div>
          <label className={labelCls()}>Tax rate (%)</label>
          <input
            type="number"
            min={0}
            step="0.1"
            className={inputCls()}
            value={value.taxRate}
            onChange={(e) => set({ taxRate: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <p className="flex justify-between">
          <span>Subtotal</span>
          <span className="font-semibold">{money(totals.subtotal)}</span>
        </p>
        {discountType !== "none" && (
          <p className="flex justify-between text-emerald-800">
            <span>
              Discount (
              {discountType === "percent"
                ? `${discountValue}%`
                : money(discountValue)}
              )
            </span>
            <span className="font-semibold">−{money(totals.discount)}</span>
          </p>
        )}
        <p className="flex justify-between">
          <span>Tax ({value.taxRate}%)</span>
          <span className="font-semibold">{money(totals.tax)}</span>
        </p>
        <p className="flex justify-between border-t border-slate-200 pt-1 font-bold">
          <span>Total</span>
          <span>{money(totals.total)}</span>
        </p>
      </div>

      {existing && (
        <SayYes
          estimate={existing}
          onAccept={handleAccept}
          onScheduled={() => {
            discard();
            onDone();
          }}
        />
      )}
      {existing?.status === "accepted" && acceptedOption && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm text-emerald-900">
            <span className="font-bold">Accepted:</span> {acceptedOption.label} option
            {existing.acceptedBy ? ` — signed by ${existing.acceptedBy}` : ""}
            {existing.acceptedAt ? ` on ${new Date(existing.acceptedAt).toLocaleDateString()}` : ""}
            {existing.jobId ? " — the job is scheduled." : ""}
          </p>
        </div>
      )}

      <div>
        <label className={labelCls()}>Notes</label>
        <textarea
          className={inputCls()}
          rows={2}
          value={value.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
      <CrewAndEquipment
        value={value}
        crew={estimateCrewChoices(state)}
        allCrew={state.crew}
        equipment={estimateEquipmentChoices(state)}
        allEquipment={state.equipment}
        onChange={set}
      />
      </fieldset>
      {canWrite && (
        <p className="text-xs text-slate-500">
          This quote saves automatically as you type. Leave and come back any
          time — your draft will be right where you left it.
        </p>
      )}

      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h3 className="text-base font-bold text-slate-900">
          Send to customer — full estimate in the email body
        </h3>
        <p className="text-sm text-slate-600">
          No PDF, no attachment: the whole estimate goes into the email
          itself, so it is fully searchable in Gmail. Every estimate is
          saved whether or not you send it.
        </p>
        {supabaseConfigured ? (
          <>
            <p className="text-sm text-slate-600">
              The email also has a private <b>Review and accept</b> button:
              the customer picks an option, types their name and accepts
              online. The link works for 60 days and stops working if you
              change the estimate (then email it again).
            </p>
            {existing?.emailQueuedAt && (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                Emailed on {fmtDate(existing.emailQueuedAt.slice(0, 10))}.
              </p>
            )}
            {sendNote && (
              <p
                className={`rounded-lg px-3 py-2 text-sm ${
                  sendNote.ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
                }`}
              >
                {sendNote.text}
              </p>
            )}
          </>
        ) : (
          isQueued && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Waiting to be sent: no email has gone out yet. Email starts
              once the business Gmail is connected. The preview below
              shows what the customer will receive.
            </div>
          )
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowEmail(!showEmail)}
            disabled={!emailPreview}
            className={secondaryBtn()}
          >
            {showEmail ? "Hide email preview" : "Preview email"}
          </button>
          {supabaseConfigured ? (
            <button
              onClick={() => handleQueueEmail(existing?.emailQueuedAt != null)}
              disabled={
                !canEdit ||
                !canSave ||
                sending ||
                sendBlocked !== null ||
                existing?.status === "accepted" ||
                existing?.status === "closed"
              }
              title={sendBlocked ?? undefined}
              className={primaryBtn()}
            >
              {sending
                ? "Sending…"
                : existing?.emailQueuedAt
                  ? "Email again"
                  : "Email estimate to customer"}
            </button>
          ) : (
            <button
              onClick={() => handleQueueEmail()}
              disabled={!canEdit || !canSave || isQueued || sendBlocked !== null}
              title={sendBlocked ?? undefined}
              className={primaryBtn()}
            >
              {isQueued ? "Already queued" : "Send estimate (queue)"}
            </button>
          )}
        </div>
        {customer && sendBlocked && canEdit && <NeedsEmail customer={customer} />}
        {showEmail &&
          (emailPreview ? (
            <EmailPreview email={emailPreview} />
          ) : (
            <p className="text-sm text-slate-500">
              Give the estimate a title and a customer to see the email
              preview.
            </p>
          ))}
      </div>

      {existing && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            History — every change to this estimate
          </p>
          <AuditList
            entries={state.auditLog.filter((e) => e.entityId === existing.id)}
            emptyText="No changes recorded yet. Every edit — even changing a 1 to a 2 — will appear here with who made it and when."
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {canWrite && (
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={primaryBtn()}
          >
            Save estimate
          </button>
        )}
        {canEdit && existing && !alreadyInvoiced && canMakeInvoiceForEstimate(state, existing) && (
          <button
            onClick={() => {
              if (!okToMakeZeroInvoice(estimateInvoicePricing(state, existing).total)) return;
              const invId = invoiceFromEstimate(existing.id);
              if (onInvoiceCreated) {
                onInvoiceCreated(invId);
              } else if (invId) {
                // Open the new invoice in the side panel, Send first.
                onDone();
                openInvoice(invId, { justCreated: true });
              }
            }}
            className={secondaryBtn()}
          >
            Create invoice from this estimate
          </button>
        )}
        <button onClick={onDone} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
