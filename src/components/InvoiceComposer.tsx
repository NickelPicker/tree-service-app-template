import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Invoice } from "../types";
import { addDaysISO, termsLabel, todayStr, uid } from "../utils";
import { invoiceEmailPreview } from "../invoicePreview";
import { nextInvoiceNumber } from "../invoiceMaking";
import { sendBlockedReason } from "../sendReady";
import {
  discardCompose,
  draftHasContent,
  draftInvoice,
  finishCompose,
  minimizeCompose,
  restoreCompose,
  toggleExpandCompose,
  updateComposeDraft,
  useInvoiceCompose,
} from "../invoiceCompose";
import BillToEditor from "./BillToEditor";
import CustomerPicker from "./CustomerPicker";
import EmailPreview from "./EmailPreview";
import NeedsEmail from "./NeedsEmail";
import {
  inputCls,
  labelCls,
  MoneyInput,
  primaryBtn,
  secondaryBtn,
} from "./ui";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2";
const headerBtn = `flex h-9 w-9 items-center justify-center rounded-lg text-lg leading-none text-white hover:bg-white/15 ${focusRing} focus-visible:ring-offset-slate-800`;

/**
 * The "New invoice" pop-up, Gmail draft style. Mounted once in App.tsx
 * (next to the side panels), so it stays open, or minimized to a bar
 * at the bottom of the screen, on every screen. State and the kept
 * draft live in src/invoiceCompose.ts; "+ New invoice" on the Invoices
 * page opens it.
 *
 * Desktop: a window docked bottom-right (520px, at most 80% of the
 * screen tall, scrolls inside). Phone: a full-width bottom sheet.
 * Sits under the side panels (z-50) and the confirmation bar (z-[60]).
 */
export default function InvoiceComposer() {
  const { state, saveInvoice, openInvoice, canEdit } = useStore();
  const compose = useInvoiceCompose();
  const { custId, desc, amount, due, dueTouched } = compose.draft;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const wasMinimized = useRef(compose.minimized);

  // Opening or restoring moves focus into the window; minimizing puts
  // it on the bar's restore button.
  useEffect(() => {
    if (!compose.open) return;
    if (compose.minimized) {
      if (!wasMinimized.current) restoreRef.current?.focus();
    } else if (compose.focusRequest > 0) {
      const first = bodyRef.current?.querySelector<HTMLElement>(
        "input, select, textarea, button:not([disabled])",
      );
      first?.focus();
    }
    wasMinimized.current = compose.minimized;
  }, [compose.open, compose.minimized, compose.focusRequest]);

  // Phones: the docked bar must not hide the end of the page.
  const docked = compose.open && compose.minimized;
  useEffect(() => {
    if (!docked) return;
    document.body.classList.add("compose-docked");
    return () => document.body.classList.remove("compose-docked");
  }, [docked]);

  if (!state || !canEdit || !compose.open) return null;

  const customerFor = (id: string) =>
    state.customers.find((x) => x.id === id) ?? null;
  const customer = custId ? customerFor(custId) : null;
  const title = customer
    ? `New invoice — ${customer.firstName} ${customer.lastName}`.trim()
    : "New invoice";

  /**
   * Default due date for a customer: today + their type's terms
   * (commercial Net 30, residential due on receipt, both changeable
   * in Invoice settings).
   */
  const termsDaysFor = (id: string) => {
    const c = customerFor(id);
    return c?.type === "commercial"
      ? (state.settings.commercialTermsDays ?? 30)
      : (state.settings.residentialTermsDays ?? 0);
  };
  const defaultDueFor = (id: string) =>
    addDaysISO(todayStr(), termsDaysFor(id));
  /** Picking a customer re-fills the due date from their terms, unless
   * the due date was already edited by hand on this invoice. */
  const pickCustomer = (id: string) => {
    updateComposeDraft(
      dueTouched ? { custId: id } : { custId: id, due: defaultDueFor(id) },
    );
  };

  const buildBlank = (ids?: { id: string; lineId: string }): Invoice | null =>
    custId
      ? draftInvoice(
          { custId, desc, amount, due },
          {
            id: ids?.id ?? uid(),
            lineId: ids?.lineId ?? uid(),
            number: nextInvoiceNumber(state.invoices),
            today: todayStr(),
            defaultDue: defaultDueFor(custId),
          },
        )
      : null;
  // Worked out from the live draft each time, so it never goes stale.
  const previewInvoice = previewOpen ? buildBlank({ id: "preview", lineId: "preview-line" }) : null;

  const newSendBlocked = custId
    ? sendBlockedReason(customerFor(custId))
    : "Choose a customer first.";
  const ready = !!custId && !!desc.trim();

  /** Save for later: a draft invoice, not sent anywhere. */
  const saveForLater = () => {
    const inv = buildBlank();
    if (!inv) return;
    saveInvoice(inv);
    closeWindow(finishCompose);
    // Open it in the side panel with "Send" as the next step.
    openInvoice(inv.id, { justCreated: true });
  };

  /**
   * Save, then open it with the email ready to check: the person sending
   * decides there whether to ask for a review, then presses Email invoice.
   */
  const sendBlank = () => {
    const inv = buildBlank();
    if (!inv || newSendBlocked) return;
    saveInvoice(inv);
    closeWindow(finishCompose);
    openInvoice(inv.id, { justCreated: true });
  };

  /** Close and clear; the next draft starts without the old preview or question. */
  const closeWindow = (close: () => void) => {
    setPreviewOpen(false);
    setConfirmingDiscard(false);
    close();
  };

  /** Close (× or Cancel): asks first when something would be lost. */
  const askClose = () => {
    if (draftHasContent(compose.draft)) setConfirmingDiscard(true);
    else closeWindow(discardCompose);
  };

  if (compose.minimized) {
    return (
      <div
        role="dialog"
        aria-label={`${title} (minimized)`}
        className="fixed inset-x-0 bottom-0 z-40 sm:inset-x-auto sm:right-44 sm:w-80"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center gap-1 bg-slate-800 py-1 pl-4 pr-1 text-white shadow-2xl sm:rounded-t-xl">
          <button
            ref={restoreRef}
            onClick={restoreCompose}
            className={`min-h-11 min-w-0 flex-1 truncate rounded-lg text-left text-sm font-semibold ${focusRing} focus-visible:ring-offset-slate-800`}
            aria-label={`Restore ${title}`}
          >
            {title}
          </button>
          <button
            onClick={restoreCompose}
            aria-label="Restore"
            title="Restore"
            className={headerBtn}
          >
            ▴
          </button>
          <button
            onClick={() => {
              restoreCompose();
              askClose();
            }}
            aria-label="Close"
            title="Close"
            className={headerBtn}
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  const size = compose.expanded
    ? "inset-x-0 bottom-0 top-0 sm:inset-auto sm:bottom-4 sm:left-1/2 sm:top-4 sm:w-[min(960px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:rounded-2xl"
    : "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl sm:inset-x-auto sm:right-44 sm:max-h-[80vh] sm:w-[min(520px,calc(100vw-12rem))]";

  return (
    <div
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          // A question on screen goes away first; then the window minimizes.
          if (confirmingDiscard) setConfirmingDiscard(false);
          else minimizeCompose();
        }
      }}
      className={`fixed z-40 flex flex-col overflow-hidden border border-slate-300 bg-white shadow-2xl ${size}`}
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingTop: compose.expanded ? "env(safe-area-inset-top)" : undefined,
      }}
    >
      <div className="flex shrink-0 items-center gap-1 bg-slate-800 py-1 pl-4 pr-1 text-white">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </h2>
        <button
          onClick={minimizeCompose}
          aria-label="Minimize"
          title="Minimize (Esc)"
          className={headerBtn}
        >
          _
        </button>
        <button
          onClick={toggleExpandCompose}
          aria-label={compose.expanded ? "Restore size" : "Expand"}
          title={compose.expanded ? "Restore size" : "Expand"}
          className={headerBtn}
        >
          {compose.expanded ? "⤡" : "⤢"}
        </button>
        <button
          onClick={askClose}
          aria-label="Close"
          title="Close"
          className={headerBtn}
        >
          ×
        </button>
      </div>

      {confirmingDiscard && (
        <div
          role="alertdialog"
          aria-label="Discard this draft?"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          <span className="min-w-0 flex-1 font-semibold">
            Discard this draft?
          </span>
          <button
            onClick={() => {
              closeWindow(discardCompose);
            }}
            className={`rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 ${focusRing}`}
            autoFocus
          >
            Discard
          </button>
          <button
            onClick={() => setConfirmingDiscard(false)}
            className={`${secondaryBtn()} ${focusRing}`}
          >
            Keep editing
          </button>
        </div>
      )}

      <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className={`grid gap-3 ${compose.expanded ? "sm:grid-cols-2" : ""}`}>
          <div>
            <label className={labelCls()}>Customer</label>
            <CustomerPicker value={custId} onChange={pickCustomer} />
          </div>
          <div>
            <label className={labelCls()} htmlFor="compose-due">
              Due date
            </label>
            <input
              id="compose-due"
              type="date"
              className={inputCls()}
              value={due}
              onChange={(e) =>
                updateComposeDraft({ due: e.target.value, dueTouched: true })
              }
            />
            {custId && (
              <p className="mt-1 text-xs text-slate-500">
                {termsLabel(termsDaysFor(custId))} — filled in from
                Invoice settings; change it here for this invoice only.
              </p>
            )}
          </div>
          <div>
            <label className={labelCls()} htmlFor="compose-desc">
              Description
            </label>
            <input
              id="compose-desc"
              className={inputCls()}
              value={desc}
              onChange={(e) => updateComposeDraft({ desc: e.target.value })}
              placeholder="e.g. Crown clean — silver maple"
            />
          </div>
          <div>
            <label className={labelCls()}>Amount</label>
            <MoneyInput
              value={amount}
              onChange={(v) => updateComposeDraft({ amount: v })}
            />
          </div>
        </div>
        {customer && <BillToEditor key={customer.id} customer={customer} />}
        <p className="text-xs text-slate-500">
          Save for later keeps a draft. Preview shows exactly what the
          customer would receive — a thank-you and the full invoice in
          the email body, no PDF. Save and email opens it with the email
          ready: choose whether to ask for a review, then press Email
          invoice.
        </p>
        {customer && newSendBlocked && <NeedsEmail customer={customer} />}
        {previewInvoice &&
          (() => {
            const c = customerFor(previewInvoice.customerId);
            return c ? (
              <EmailPreview
                email={invoiceEmailPreview(
                  previewInvoice,
                  c,
                  state.settings.company,
                  false,
                )}
              />
            ) : null;
          })()}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
        <button
          onClick={sendBlank}
          disabled={!ready || newSendBlocked !== null}
          title={newSendBlocked ?? undefined}
          className={`${primaryBtn()} ${focusRing}`}
        >
          Save and email…
        </button>
        <button
          onClick={saveForLater}
          disabled={!ready}
          className={`${secondaryBtn()} ${focusRing} disabled:opacity-50`}
        >
          Save for later
        </button>
        <button
          onClick={() => setPreviewOpen(true)}
          disabled={!ready}
          className={`${secondaryBtn()} ${focusRing} disabled:opacity-50`}
        >
          Preview email
        </button>
        <button
          onClick={askClose}
          className={`${secondaryBtn()} ${focusRing}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
