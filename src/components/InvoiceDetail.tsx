import { useEffect, useState } from "react";
import { sendBlockedReason } from "../sendReady";
import { showFlash } from "../flash";
import NeedsEmail from "./NeedsEmail";
import { useLoadedState, useStore } from "../store";
import type { DiscountType, Invoice, PaymentMethod } from "../types";
import {
  PAYMENT_METHODS,
  paymentMethodLabel,
} from "../payments";
import { jobValue, priceReplaced } from "../jobValue";
import { priceOf, priceText } from "../priceChange";
import { OldPrice } from "./JobPriceChanges";
import { invoiceTotal, splitsPaidTotal } from "../splits";
import { daysBetweenISO, fmtDate, money, termsLabel } from "../utils";
import { invoiceEmailPreview, invoicePayerEmailPreview } from "../invoicePreview";
import {
  companyReviewLink,
  invoiceSendText,
  loadPayerSends,
  payerMayHaveGone,
  sendMayHaveGone,
  type InvoiceSendResult,
  type PayerSendResult,
} from "../invoiceSend";
import { emailablePayers, payerEmailCount, splitCheck } from "../splitPayers";
import { useDoubleConfirm } from "../useDoubleConfirm";
import {
  loadReceiptStates,
  receiptSendText,
  receiptsToConfirm,
  unpaidPayerIds,
  type ReceiptPayerResult,
  type ReceiptSendResult,
  type ReceiptState,
} from "../paymentReceipts";
import SplitPayers from "./SplitPayers";
import AuditList from "./AuditLog";
import BillToEditor from "./BillToEditor";
import EmailPreview from "./EmailPreview";
import HowToPay from "./HowToPay";
import { invoiceBillsReplacedPrice, invoiceEmailStatus, invoiceWasEmailed, okToSendZeroInvoice } from "../invoiceMaking";
import {
  docTotals,
  inputCls,
  linkCls,
  MoneyInput,
  primaryBtn,
  secondaryBtn,
  StatusBadge,
} from "./ui";

/**
 * The one invoice detail view, shared by the Invoices page and the
 * global detail drawer: lines + total, mark paid, the send/preview
 * email block, linked job/estimate (each opens its drawer), and the
 * full change history.
 */
export default function InvoiceDetail(
  props: Parameters<typeof InvoiceDetailLoaded>[0],
) {
  const { state } = useStore();
  if (!state) return null;
  return <InvoiceDetailLoaded {...props} />;
}

function InvoiceDetailLoaded({
  invoice,
  justCreated = false,
}: {
  invoice: Invoice;
  /** Just made from an estimate or job: lead with "Send" as the next step. */
  justCreated?: boolean;
}) {
  const {
    canEdit,
    saveInvoice,
    markInvoicePaid,
    markSplitPaid,
    queueInvoiceEmail,
    sendPaymentReceipts,
    openJob,
    openEstimate,
    openCustomer,
    stopInvoiceAutoSend,
  } = useStore();
  const state = useLoadedState();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const autoEmailsOn =
    state.settings.autoEmails === true &&
    state.automations.some((r) => r.kind === "invoice_send" && r.enabled);
  const autoLine = invoiceEmailStatus(invoice, autoEmailsOn);
  const [showEmail, setShowEmail] = useState(false);
  // How the customer paid, picked when the invoice is marked paid.
  // Empty until chosen — the method is recorded, never guessed.
  const [payMethod, setPayMethod] = useState<"" | PaymentMethod>("");
  const showMoney = useStore().showMoney;

  const customer = state.customers.find((c) => c.id === invoice.customerId) ?? null;
  // No email on the customer: Send is greyed out with the reason.
  // (A split invoice is emailed to its payers, not to the customer.)
  const sendBlocked = (invoice.splits ?? []).length > 0 ? null : sendBlockedReason(customer);
  // "Ask for a review in this email": off by default, chosen per
  // invoice by the person sending it (business rule). Needs the
  // review link from Invoice settings.
  const reviewUrl = companyReviewLink(state.settings.company);
  const [askReview, setAskReview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<InvoiceSendResult | null>(null);
  // "Email again" asks first, on the page (business rule).
  const [confirmAgain, setConfirmAgain] = useState(false);
  // An earlier send may have reached the customer without being recorded
  // (the server said "may-have-sent", or Gmail took it but recording
  // failed): from then on only "Email again", with its confirm, sends.
  const [mayHaveSent, setMayHaveSent] = useState(false);
  // Split invoices (business rule): each payer is emailed their own
  // share. Per payer: when the sends log says they were last emailed
  // (null = could not be read), who may have been emailed without it
  // being recorded, and the last press's result.
  const [payerSent, setPayerSent] = useState<Map<string, string> | null>(null);
  const [payerMaybe, setPayerMaybe] = useState<Set<string>>(() => new Set());
  const [payerResults, setPayerResults] = useState<Map<string, PayerSendResult>>(() => new Map());
  const [confirmPayerId, setConfirmPayerId] = useState<string | null>(null);
  const [previewPayerId, setPreviewPayerId] = useState<string>("");
  // Payment receipts (split invoices): each payment's receipt state from
  // the sends log, the last result per payer, and "Resend receipt"'s confirm.
  const [receipts, setReceipts] = useState<Map<string, ReceiptState> | null>(null);
  const [receiptResults, setReceiptResults] = useState<Map<string, ReceiptPayerResult>>(() => new Map());
  const [confirmReceiptId, setConfirmReceiptId] = useState<string | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const { confirmEmails, dialog: doubleConfirmDialog } = useDoubleConfirm();
  useEffect(() => {
    setReceipts(null);
    setReceiptResults(new Map());
    setConfirmReceiptId(null);
    setReceiptBusy(false);
  }, [invoice.id]);
  useEffect(() => {
    setAskReview(false);
    setSendResult(null);
    setSending(false);
    setConfirmAgain(false);
    setMayHaveSent(false);
    setPayerSent(null);
    setPayerMaybe(new Set());
    setPayerResults(new Map());
    setConfirmPayerId(null);
    setPreviewPayerId("");
  }, [invoice.id]);
  const isSplit = (invoice.splits ?? []).length > 0;
  useEffect(() => {
    if (!isSplit || !canEdit) return;
    let live = true;
    void loadPayerSends(invoice.id).then((m) => {
      if (live && m) setPayerSent(m);
    });
    void loadReceiptStates(invoice.id).then((m) => {
      if (live && m) setReceipts(m);
    });
    return () => {
      live = false;
    };
  }, [invoice.id, isSplit, canEdit]);
  /** Email receipts to these payers (just marked paid, or "Resend receipt"). */
  const emailReceipts = (splitIds: string[], again: boolean, confirmed: number) => {
    setConfirmReceiptId(null);
    if (splitIds.length === 0) return;
    setReceiptBusy(true);
    sendPaymentReceipts(invoice.id, {
      splitIds,
      again,
      confirmed,
      onResult: (r: ReceiptSendResult) => {
        setReceiptBusy(false);
        setReceiptResults((old) => {
          const next = new Map(old);
          for (const p of r.payers) next.set(p.id, p);
          return next;
        });
        if (r.sent > 0) {
          void loadReceiptStates(invoice.id).then((m) => {
            if (m) setReceipts(m);
          });
        }
        showFlash(receiptSendText(r));
      },
    });
  };
  /** One payer's "Mark paid": they get a receipt for their own payment only. */
  const markPayerPaid = (splitId: string, paid: boolean) => {
    const count = paid ? receiptsToConfirm(invoice, [splitId]) : 0;
    markSplitPaid(invoice.id, splitId, paid);
    if (count > 0) emailReceipts([splitId], false, count);
  };
  /** "Mark as paid" on the whole invoice: a split invoice's unpaid payers each get a receipt. */
  const markAllPaid = async (method?: PaymentMethod) => {
    const ids = isSplit ? unpaidPayerIds(invoice) : [];
    const count = isSplit ? receiptsToConfirm(invoice, ids) : 0;
    // Owner's rule: more than 3 emails at once need both "are you sure" steps.
    if (
      count > 0 &&
      !(await confirmEmails(count, `Each payer marked paid gets a receipt for their own payment only.`))
    ) {
      return;
    }
    markInvoicePaid(invoice.id, method);
    if (count > 0) emailReceipts(ids, false, count);
  };
  const emailedBefore = invoiceWasEmailed(invoice) || mayHaveSent;
  const emailedOn = invoice.emailedAt ?? invoice.autoSentAt ?? null;
  // Split: the shares must add up before anyone is emailed.
  const split = splitCheck(invoice);
  const splitBlocked = isSplit && !split.ok;
  const emailable = isSplit ? emailablePayers(invoice) : [];
  const knownSent = new Set(payerSent ? payerSent.keys() : []);
  const payerNotYet = emailable.filter((s) => !knownSent.has(s.id) && !payerMaybe.has(s.id));
  const splitEmailedBefore = emailable.some((s) => knownSent.has(s.id) || payerMaybe.has(s.id));
  const pressEmail = () => {
    if (isSplit) {
      if (payerNotYet.length > 0) void sendToPayers(false);
      else setConfirmAgain(true);
      return;
    }
    if (emailedBefore) setConfirmAgain(true);
    else send();
  };
  /** Email the payers their shares: all of them, or `only` some ("Email again" for one). */
  const sendToPayers = async (again: boolean, only?: string[]) => {
    setConfirmAgain(false);
    setConfirmPayerId(null);
    if (!isSplit || splitBlocked || sending) return;
    const count = payerEmailCount(invoice, { again, only, knownSent });
    // Owner's rule: more than 3 emails at once need both "are you sure" steps.
    if (!(await confirmEmails(count, `Each payer gets invoice ${invoice.number} with only their own share.`))) return;
    setSending(true);
    setSendResult(null);
    queueInvoiceEmail(invoice.id, {
      askReview: askReview && reviewUrl !== "",
      again,
      splitIds: only,
      confirmed: count,
      onResult: (r) => {
        setSending(false);
        setSendResult(r);
        const now = new Date().toISOString();
        if (r.payers) {
          const results = new Map(r.payers.map((p) => [p.id, p]));
          setPayerResults((old) => {
            const next = new Map(old);
            for (const [id, p] of results) next.set(id, p);
            return next;
          });
          setPayerSent((old) => {
            const next = new Map(old ?? []);
            for (const p of r.payers ?? []) if (p.sent > 0 && p.marked !== false) next.set(p.id, r.emailedAt ?? now);
            return next;
          });
          setPayerMaybe((old) => {
            const next = new Set(old);
            for (const p of r.payers ?? []) if (payerMayHaveGone(p)) next.add(p.id);
            return next;
          });
        }
        showFlash(invoiceSendText(r));
      },
    });
  };
  const send = () => {
    setConfirmAgain(false);
    if (isSplit) {
      void sendToPayers(true);
      return;
    }
    if (sendBlocked || sending) return;
    if (!okToSendZeroInvoice(invoiceTotal(invoice))) return;
    setSending(true);
    setSendResult(null);
    queueInvoiceEmail(invoice.id, {
      askReview: askReview && reviewUrl !== "",
      again: emailedBefore,
      onResult: (r) => {
        setSending(false);
        setSendResult(r);
        if (sendMayHaveGone(r)) setMayHaveSent(true);
        showFlash(
          r.sent > 0
            ? `Invoice ${invoice.number} emailed to ${customer?.email ?? "the customer"}.`
            : invoiceSendText(r),
        );
      },
    });
  };
  const job = invoice.jobId
    ? (state.jobs.find((j) => j.id === invoice.jobId) ?? null)
    : null;
  const estimate = invoice.estimateId
    ? (state.estimates.find((e) => e.id === invoice.estimateId) ?? null)
    : null;
  // Money is hidden for Crew viewers, same rule as everywhere else.
  const linkedJobValue = job ? jobValue(state, job) : null;

  // Discount-aware totals, exactly like estimates: discount before tax.
  const discountType: DiscountType = invoice.discountType ?? "none";
  const discountValue: number = invoice.discountValue ?? 0;
  const totals = docTotals(
    invoice.lines,
    invoice.taxRate,
    discountType,
    discountValue,
  );

  // Draft for the discount editor below. It resets whenever a different
  // invoice is opened; saving writes through saveInvoice, which
  // audit-logs the discount change field by field.
  const [draftType, setDraftType] = useState<DiscountType>(discountType);
  const [draftValue, setDraftValue] = useState<number>(discountValue);
  useEffect(() => {
    setDraftType(invoice.discountType ?? "none");
    setDraftValue(invoice.discountValue ?? 0);
    setPayMethod("");
    // Reset only when the opened invoice changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);
  const discountChanged =
    draftType !== discountType || draftValue !== discountValue;
  const handleSaveDiscount = () => {
    if (!discountChanged) return;
    saveInvoice({
      ...invoice,
      discountType: draftType,
      discountValue: draftValue,
    });
  };

  return (
    <section className="h-fit rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {justCreated && !invoice.emailQueuedAt && (
        <div className="mb-4 space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3">
          <p className="text-sm font-bold text-emerald-900">
            Invoice {invoice.number} is made. Next step: send it to the customer.
          </p>
          {sendBlocked && customer ? (
            <NeedsEmail customer={customer} />
          ) : (
            <p className="text-sm text-emerald-900">
              Check the email below (and whether to ask for a review),
              then press Email invoice.
            </p>
          )}
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {invoice.number}
          </h2>
          <p className="text-sm text-slate-600">
            {customer ? (
              <button
                onClick={() => openCustomer(customer.id)}
                className={linkCls()}
              >
                {customer.firstName} {customer.lastName}
              </button>
            ) : (
              "Unknown customer"
            )}
          </p>
          <p className="text-sm text-slate-500">
            Issued {fmtDate(invoice.issuedDate)} ·{" "}
            {canEdit && invoice.status !== "paid" ? (
              <>
                Due{" "}
                <input
                  type="date"
                  aria-label="Due date"
                  className="rounded border border-slate-300 px-1 py-0.5 text-sm"
                  value={invoice.dueDate}
                  onChange={(e) => {
                    if (e.target.value) {
                      saveInvoice({ ...invoice, dueDate: e.target.value });
                    }
                  }}
                />{" "}
                <span className="text-xs">
                  (
                  {termsLabel(
                    daysBetweenISO(invoice.issuedDate, invoice.dueDate),
                  )}
                  )
                </span>
              </>
            ) : (
              <>Due {fmtDate(invoice.dueDate)}</>
            )}
            {invoice.paidDate && ` · Paid ${fmtDate(invoice.paidDate)}`}
            {invoice.status === "paid" && showMoney && (
              <> · via {paymentMethodLabel(invoice.paymentMethod)}</>
            )}
          </p>
          {invoice.autoCreated && (
            <p className="text-xs text-slate-500">
              Made automatically when the job was marked done.
            </p>
          )}
          {autoLine && (
            <div
              className={`mt-1 flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-sm ${
                invoice.autoSendStatus === "waiting" && autoEmailsOn
                  ? "bg-amber-50 text-amber-900"
                  : "bg-slate-50 text-slate-700"
              }`}
            >
              <span>
                {autoLine}
                {invoice.autoSendStatus === "waiting" && autoEmailsOn && (
                  <span className="text-xs"> (at the next hourly check)</span>
                )}
              </span>
              {invoice.autoSendStatus === "waiting" && canEdit && (
                <button
                  className={secondaryBtn()}
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true);
                    setStopError(null);
                    void stopInvoiceAutoSend(invoice.id).then((err) => {
                      setStopping(false);
                      setStopError(err);
                    });
                  }}
                >
                  {stopping ? "Stopping…" : "Stop"}
                </button>
              )}
              {stopError && <span className="text-red-700">{stopError}</span>}
            </div>
          )}
          {job && (
            <p className="text-sm text-slate-600">
              Job:{" "}
              <button onClick={() => openJob(job.id)} className={linkCls()}>
                {job.title}
              </button>
              {linkedJobValue !== null && showMoney && (
                <> · {money(linkedJobValue)}</>
              )}
            </p>
          )}
          {job && showMoney && priceReplaced(job) && invoiceBillsReplacedPrice(state, job, invoice) && (
            <p className="text-sm text-slate-700" data-testid="invoice-climber-price">
              A Climber changed the job&apos;s price: <OldPrice amount={job.replacedPrice ?? null} />
              <span className="font-semibold">{priceText(priceOf(job), job.estimatedHours)}</span>. The new
              price replaces the estimate&apos;s.
            </p>
          )}
          {job && showMoney && priceReplaced(job) && !invoiceBillsReplacedPrice(state, job, invoice) && (
            <p className="rounded-lg bg-amber-50 px-2 py-1 text-sm text-amber-900" data-testid="invoice-old-price">
              A Climber changed the job&apos;s price to{" "}
              <span className="font-semibold">{priceText(priceOf(job), job.estimatedHours)}</span>. This invoice
              does not bill that price.
            </p>
          )}
          {customer?.type === "commercial" && (
            <p className="mt-1 rounded-lg bg-sky-50 px-2 py-1 text-xs text-sky-900">
              Commercial — {customer.companyName ?? customer.company}
              {customer.projectName ? ` · ${customer.projectName}` : ""}
              {customer.projectNumber ? ` (${customer.projectNumber})` : ""}
              {customer.poNumber ? ` · PO ${customer.poNumber}` : ""}
              {customer.billingTerms ? ` · ${customer.billingTerms}` : ""}
            </p>
          )}
          {estimate && (
            <p className="text-sm text-slate-600">
              Estimate:{" "}
              <button
                onClick={() => openEstimate(estimate.id)}
                className={linkCls()}
              >
                {estimate.title}
              </button>
            </p>
          )}
        </div>
        <StatusBadge status={invoice.status} />
      </div>
      {customer && (
        <div className="mt-3">
          <BillToEditor key={customer.id} customer={customer} />
        </div>
      )}
      <table className="mt-3 w-full text-sm">
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id} className="border-b border-slate-100">
              <td className="py-2 pr-2 text-slate-800">{l.description}</td>
              <td className="py-2 text-right text-slate-500">
                {l.quantity} × {money(l.unitPrice)}
              </td>
              <td className="py-2 pl-2 text-right font-semibold text-slate-900">
                {money(l.quantity * l.unitPrice)}
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-2 text-slate-600" colSpan={2}>
              Subtotal
            </td>
            <td className="py-2 text-right font-semibold text-slate-900">
              {money(totals.subtotal)}
            </td>
          </tr>
          {discountType !== "none" && (
            <tr>
              <td className="py-2 text-emerald-800" colSpan={2}>
                Discount (
                {discountType === "percent"
                  ? `${discountValue}%`
                  : money(discountValue)}
                )
              </td>
              <td className="py-2 text-right font-semibold text-emerald-800">
                −{money(totals.discount)}
              </td>
            </tr>
          )}
          <tr>
            <td className="py-2 text-slate-600" colSpan={2}>
              Tax ({invoice.taxRate}%)
            </td>
            <td className="py-2 text-right font-semibold text-slate-900">
              {money(totals.tax)}
            </td>
          </tr>
          <tr>
            <td className="py-2 font-bold text-slate-900" colSpan={2}>
              Total
            </td>
            <td className="py-2 text-right font-bold text-slate-900">
              {money(totals.total)}
            </td>
          </tr>
        </tbody>
      </table>
      <HowToPay invoiceNumber={invoice.number} showSetupHint />
      <SplitPayers
        invoice={invoice}
        customerName={customer ? `${customer.firstName} ${customer.lastName}`.trim() || "the customer" : "the customer"}
        canEdit={canEdit}
        onSave={(splits) => saveInvoice({ ...invoice, splits })}
        onMarkPaid={markPayerPaid}
        receipts={receipts}
        receiptResults={receiptResults}
        receiptBusy={receiptBusy}
        confirmReceiptId={confirmReceiptId}
        onAskResendReceipt={(id) => setConfirmReceiptId(id)}
        onConfirmResendReceipt={(id, again) => emailReceipts([id], again, 1)}
        onCancelResendReceipt={() => setConfirmReceiptId(null)}
        lastEmailed={payerSent}
        maybeEmailed={payerMaybe}
        results={payerResults}
        sending={sending}
        confirmPayerId={confirmPayerId}
        onAskAgain={(id) => setConfirmPayerId(id)}
        onConfirmAgain={(id) => void sendToPayers(true, [id])}
        onCancelAgain={() => setConfirmPayerId(null)}
      />
      {isSplit && (
        <p className="mt-2 text-sm text-slate-600">
          Paid so far {money(splitsPaidTotal(invoice.splits ?? [], invoice))} of {money(invoiceTotal(invoice))} ·
          Status <span className="font-semibold">{invoice.status}</span>
        </p>
      )}
      {canEdit && (
        <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-bold text-slate-900">Discount</p>
          <div className="flex flex-wrap gap-2">
            <select
              className={inputCls()}
              value={draftType}
              onChange={(e) =>
                setDraftType(e.target.value as DiscountType)
              }
            >
              <option value="none">No discount</option>
              <option value="percent">Percent off</option>
              <option value="fixed">Fixed $ off</option>
            </select>
            {draftType === "percent" && (
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="1"
                  className={inputCls()}
                  value={draftValue}
                  onChange={(e) => setDraftValue(Number(e.target.value))}
                />
                <span className="text-sm font-semibold text-slate-500">%</span>
              </span>
            )}
            {draftType === "fixed" && (
              <MoneyInput
                value={draftValue}
                onChange={(n) => setDraftValue(n)}
              />
            )}
          </div>
          <button
            onClick={handleSaveDiscount}
            disabled={!discountChanged}
            className={secondaryBtn()}
          >
            Save discount
          </button>
        </div>
      )}
      {invoice.status !== "paid" && canEdit && (
        <div className="mt-3 space-y-2">
          {showMoney ? (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  How did they pay?
                </label>
                <select
                  className={inputCls()}
                  value={payMethod}
                  onChange={(e) =>
                    setPayMethod(e.target.value as "" | PaymentMethod)
                  }
                >
                  <option value="">Choose…</option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => {
                  if (payMethod) void markAllPaid(payMethod);
                }}
                disabled={!payMethod}
                className={primaryBtn()}
              >
                Mark as paid
              </button>
            </div>
          ) : (
            <button
              onClick={() => void markAllPaid()}
              className={`${primaryBtn()} mt-3`}
            >
              Mark as paid
            </button>
          )}
          <p className="text-xs text-slate-500">
            The method is recorded on the invoice — it feeds the
            &ldquo;Who pays by what&rdquo; report on the Invoices page.
          </p>
        </div>
      )}
      {invoice.status === "paid" &&
        !invoice.paymentMethod &&
        canEdit &&
        showMoney && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">
              Payment method not recorded — this invoice was paid before
              methods were tracked.
            </p>
            <select
              className={inputCls()}
              value=""
              aria-label="Record payment method"
              onChange={(e) => {
                const m = e.target.value as PaymentMethod;
                if (m) saveInvoice({ ...invoice, paymentMethod: m });
              }}
            >
              <option value="">Record how they paid…</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}

      <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm font-bold text-slate-900">
          {isSplit
            ? "Send to payers — each payer gets the invoice with only their own share"
            : "Send to customer — thank-you and the full invoice in one email"}
        </p>
        {isSplit && (
          <p className="text-sm text-slate-700">
            {emailable.length === 0
              ? "No payer can be emailed yet: each needs an email address, an unpaid share above $0."
              : `${emailable.length} payer${emailable.length === 1 ? "" : "s"} will be emailed, each to their own address; no payer sees another payer's email or share.`}
            {emailable.length > 3 && " More than 3 emails need two “are you sure” steps."}
          </p>
        )}
        {emailedBefore && !isSplit && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            Emailed{emailedOn ? ` ${fmtDate(emailedOn.slice(0, 10))}` : ""}.
          </div>
        )}
        {!emailedBefore && invoice.emailQueuedAt && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Not sent: this was only marked &ldquo;queued&rdquo; on{" "}
            {fmtDate(invoice.emailQueuedAt.slice(0, 10))}; no email went
            out. Press Email invoice to send it.
          </div>
        )}
        {isSplit && invoice.emailedAt && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            At least one payer was emailed{` ${fmtDate(invoice.emailedAt.slice(0, 10))}`}. Each payer&apos;s status is
            under Split between payers.
          </div>
        )}
        {splitBlocked && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Not ready to email: {split.problem ?? "the payers' shares must add up to the total."}
          </div>
        )}
        <label
          className={`flex items-start gap-2 text-sm ${
            reviewUrl ? "text-slate-800" : "text-slate-400"
          }`}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={askReview && reviewUrl !== ""}
            disabled={!canEdit || reviewUrl === ""}
            onChange={(e) => {
              setAskReview(e.target.checked);
              setSendResult(null);
            }}
          />
          <span>
            <span className="font-semibold">Ask for a review in this email</span>
            <span className="block text-xs text-slate-500">
              {reviewUrl
                ? "Adds a \u201cReview us\u201d button. Only tick it for a customer you know was happy."
                : "Add your review link in Invoice settings"}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowEmail(!showEmail)}
            className={secondaryBtn()}
          >
            {showEmail ? "Hide email preview" : "Preview email"}
          </button>
          <button
            onClick={pressEmail}
            disabled={
              !canEdit ||
              sending ||
              confirmAgain ||
              confirmPayerId !== null ||
              sendBlocked !== null ||
              splitBlocked ||
              (isSplit && emailable.length === 0)
            }
            title={sendBlocked ?? (splitBlocked ? (split.problem ?? undefined) : undefined)}
            className={primaryBtn()}
          >
            {sending
              ? "Sending…"
              : isSplit
                ? payerNotYet.length > 0
                  ? `Email ${payerNotYet.length} payer${payerNotYet.length === 1 ? "" : "s"} their share`
                  : splitEmailedBefore
                    ? "Email again"
                    : "Email payers"
                : emailedBefore
                  ? "Email again"
                  : "Email invoice"}
          </button>
        </div>
        {confirmAgain && (
          <div
            role="alertdialog"
            aria-label="Email this invoice again?"
            className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
          >
            <p className="text-sm font-semibold text-amber-900">
              Email this invoice again?
            </p>
            <p className="text-sm text-amber-900">
              {isSplit ? (
                <>
                  All {emailable.length} payer{emailable.length === 1 ? "" : "s"} will get their share again
                  (a second copy for anyone who already got it). To email just one payer, use their
                  &ldquo;Email again&rdquo; under Split between payers.
                </>
              ) : invoiceWasEmailed(invoice) ? (
                <>
                  {customer?.firstName || "The customer"} already got it
                  {emailedOn ? ` on ${fmtDate(emailedOn.slice(0, 10))}` : ""}.
                  They will get a second copy.
                </>
              ) : (
                <>
                  The earlier email may have gone through (its sending
                  didn&apos;t finish recording). If it did,{" "}
                  {customer?.firstName || "the customer"} will get a second
                  copy.
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={send} className={primaryBtn()}>
                Yes, email again
              </button>
              <button
                onClick={() => setConfirmAgain(false)}
                className={secondaryBtn()}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {sendResult && (
          <p
            role="status"
            className={`rounded-lg px-3 py-2 text-sm ${
              sendResult.sent > 0
                ? "bg-emerald-50 text-emerald-900"
                : "bg-amber-50 text-amber-900"
            }`}
          >
            {invoiceSendText(sendResult)}
          </p>
        )}
        {sendBlocked && customer && !justCreated && (
          <NeedsEmail customer={customer} />
        )}
        {isSplit && showEmail && emailable.length > 0 && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              Preview the email of
              <select
                className={inputCls()}
                value={previewPayerId || emailable[0].id}
                onChange={(e) => setPreviewPayerId(e.target.value)}
              >
                {emailable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.recipientName}
                  </option>
                ))}
              </select>
            </label>
            <EmailPreview
              email={invoicePayerEmailPreview(
                invoice,
                emailable.find((s) => s.id === previewPayerId) ?? emailable[0],
                state.settings.company,
                askReview && reviewUrl !== "",
              )}
            />
          </div>
        )}
        {!isSplit && (showEmail || justCreated) &&
          (customer ? (
            <EmailPreview
              email={invoiceEmailPreview(
                invoice,
                customer,
                state.settings.company,
                askReview && reviewUrl !== "",
              )}
            />
          ) : null)}
      </div>
      {doubleConfirmDialog}
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          History — every change to this invoice
        </p>
        <AuditList
          entries={state.auditLog.filter((e) => e.entityId === invoice.id)}
          emptyText="No changes recorded yet. Every edit will appear here with who made it and when."
        />
      </div>
    </section>
  );
}
