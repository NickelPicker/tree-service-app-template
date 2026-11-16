import { useState } from "react";
import type { Invoice, InvoiceSplit } from "../types";
import { splitAmount } from "../splits";
import { newPayerDefault, payerEmailOk, splitCheck } from "../splitPayers";
import { payerSendText, type PayerSendResult } from "../invoiceSend";
import {
  receiptIsResend,
  receiptPayerText,
  receiptSentAt,
  type ReceiptPayerResult,
  type ReceiptState,
} from "../paymentReceipts";
import { fmtDate, money, uid } from "../utils";
import { inputCls, MoneyInput, primaryBtn, secondaryBtn } from "./ui";

/**
 * "Split between payers" on an invoice: the office adds payers (name,
 * email, a percent of the total or a dollar amount), sees each payer's
 * share and whether the shares add up to the total, edits or removes a
 * payer, marks a share paid, and sees each payer's email status (with
 * "Email again" for one payer). A payer marked paid is emailed a receipt
 * for their own payment ("Receipt sent", with "Resend receipt").
 * See src/splitPayers.ts and src/paymentReceipts.ts.
 */
export default function SplitPayers({
  invoice,
  customerName,
  canEdit,
  onSave,
  onMarkPaid,
  lastEmailed,
  maybeEmailed,
  results,
  sending,
  confirmPayerId,
  onAskAgain,
  onConfirmAgain,
  onCancelAgain,
  receipts = null,
  receiptResults = new Map(),
  receiptBusy = false,
  confirmReceiptId = null,
  onAskResendReceipt = () => {},
  onConfirmResendReceipt = () => {},
  onCancelResendReceipt = () => {},
}: {
  invoice: Invoice;
  customerName: string;
  canEdit: boolean;
  onSave: (splits: InvoiceSplit[]) => void;
  onMarkPaid: (splitId: string, paid: boolean) => void;
  /** Payer id → when the sends log says they were last emailed; null = unknown. */
  lastEmailed: Map<string, string> | null;
  /** Payers who may have been emailed without it being recorded. */
  maybeEmailed: Set<string>;
  /** The last press's result per payer. */
  results: Map<string, PayerSendResult>;
  sending: boolean;
  confirmPayerId: string | null;
  onAskAgain: (splitId: string) => void;
  onConfirmAgain: (splitId: string) => void;
  onCancelAgain: () => void;
  /** Each payment's receipt state ("<split id>|<paid day>"); null = unknown. */
  receipts?: Map<string, ReceiptState> | null;
  /** The last receipt result per payer. */
  receiptResults?: Map<string, ReceiptPayerResult>;
  receiptBusy?: boolean;
  confirmReceiptId?: string | null;
  onAskResendReceipt?: (splitId: string) => void;
  /** `again`: true only for "Resend receipt" (a receipt is known to have gone). */
  onConfirmResendReceipt?: (splitId: string, again: boolean) => void;
  onCancelResendReceipt?: () => void;
}) {
  const splits = invoice.splits ?? [];
  const check = splitCheck(invoice);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<"percentage" | "fixed">("percentage");
  const [value, setValue] = useState<number | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<InvoiceSplit | null>(null);

  const shownValue = value ?? newPayerDefault(invoice, kind);
  const showForm = canEdit && (open || splits.length > 0);
  const add = () => {
    if (name.trim() === "") return;
    onSave([
      ...splits,
      {
        id: uid(),
        recipientName: name.trim(),
        recipientEmail: email.trim(),
        kind,
        value: shownValue,
        paid: false,
        paidDate: null,
      },
    ]);
    setName("");
    setEmail("");
    setValue(null);
  };
  const saveEdit = () => {
    if (!draft || draft.recipientName.trim() === "") return;
    onSave(
      splits.map((s) =>
        s.id === draft.id
          ? { ...draft, recipientName: draft.recipientName.trim(), recipientEmail: draft.recipientEmail.trim() }
          : s,
      ),
    );
    setEditId(null);
    setDraft(null);
  };

  return (
    <div id="split-payers" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm font-bold text-slate-900">Split between payers</p>
      {splits.length === 0 ? (
        <div className="mt-1 space-y-2">
          <p className="text-sm text-slate-600">
            One payer: the full {money(check.total)} is billed to {customerName}. Split it to bill several
            people, each for their own share (a percent or a dollar amount); each payer is emailed only
            their share.
          </p>
          {canEdit && !open && (
            <button onClick={() => setOpen(true)} className={secondaryBtn()}>
              + Split this invoice between payers
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-600">
            Each payer is emailed the invoice with only their own share. Invoice total {money(check.total)}.
          </p>
          <ul className="mt-2 space-y-2">
            {splits.map((s) => {
              const sentAt = lastEmailed?.get(s.id) ?? null;
              const result = results.get(s.id);
              const emailed = sentAt !== null || maybeEmailed.has(s.id);
              const receiptAt = receiptSentAt(receipts, s);
              const receiptResult = receiptResults.get(s.id);
              const editing = editId === s.id && draft;
              return (
                <li key={s.id} className="rounded-lg border border-slate-200 bg-white p-2 text-sm">
                  {editing ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        className={inputCls()}
                        aria-label="Payer name"
                        value={draft.recipientName}
                        onChange={(e) => setDraft({ ...draft, recipientName: e.target.value })}
                      />
                      <input
                        className={inputCls()}
                        aria-label="Payer email"
                        type="email"
                        value={draft.recipientEmail}
                        placeholder="Payer email"
                        onChange={(e) => setDraft({ ...draft, recipientEmail: e.target.value })}
                      />
                      <ShareInput
                        kind={draft.kind}
                        value={draft.value}
                        onKind={(k) => setDraft({ ...draft, kind: k })}
                        onValue={(v) => setDraft({ ...draft, value: v })}
                      />
                      <div className="flex gap-2">
                        <button onClick={saveEdit} disabled={draft.recipientName.trim() === ""} className={primaryBtn()}>
                          Save payer
                        </button>
                        <button
                          onClick={() => {
                            setEditId(null);
                            setDraft(null);
                          }}
                          className={secondaryBtn()}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">
                          {s.recipientName}
                          {s.recipientEmail ? (
                            <span className="ml-1 font-normal text-slate-500">({s.recipientEmail})</span>
                          ) : null}
                        </span>
                        <span className="font-bold text-slate-900">{money(splitAmount(s, invoice))}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        <span>{s.kind === "percentage" ? `${s.value}% of the total` : `Fixed ${money(s.value)}`}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold ${
                            s.paid ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {s.paid ? `Paid${s.paidDate ? ` ${fmtDate(s.paidDate)}` : ""}` : "Unpaid"}
                        </span>
                        {!payerEmailOk(s.recipientEmail) && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                            Needs an email to be emailed their share
                          </span>
                        )}
                        {sentAt && (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-800">
                            Emailed {fmtDate(sentAt.slice(0, 10))}
                          </span>
                        )}
                        {receiptAt && (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-800">
                            Receipt sent {fmtDate(receiptAt.slice(0, 10))}
                          </span>
                        )}
                        {canEdit && (
                          <>
                            <button
                              onClick={() => onMarkPaid(s.id, !s.paid)}
                              className="font-semibold text-emerald-700 underline"
                            >
                              {s.paid ? "Mark unpaid" : "Mark paid"}
                            </button>
                            <button
                              onClick={() => {
                                setEditId(s.id);
                                setDraft({ ...s });
                              }}
                              className="font-semibold text-slate-700 underline"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => onSave(splits.filter((x) => x.id !== s.id))}
                              className="font-semibold text-red-700 underline"
                            >
                              Remove
                            </button>
                            {s.paid && s.paidDate && payerEmailOk(s.recipientEmail) && (
                              <button
                                onClick={() => onAskResendReceipt(s.id)}
                                disabled={receiptBusy || confirmReceiptId !== null}
                                className="font-semibold text-sky-800 underline disabled:opacity-50"
                              >
                                {receiptAt ? "Resend receipt" : "Send receipt"}
                              </button>
                            )}
                            {emailed && !s.paid && (
                              <button
                                onClick={() => onAskAgain(s.id)}
                                disabled={sending || confirmPayerId !== null}
                                className="font-semibold text-sky-800 underline disabled:opacity-50"
                              >
                                Email {s.recipientName.split(" ")[0] || "this payer"} again
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {result && (
                        <p
                          role="status"
                          className={`mt-1 rounded px-2 py-1 text-xs ${
                            result.sent > 0 ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
                          }`}
                        >
                          {payerSendText(result)}
                        </p>
                      )}
                      {receiptResult && (
                        <p
                          role="status"
                          className={`mt-1 rounded px-2 py-1 text-xs ${
                            receiptResult.sent > 0 ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
                          }`}
                        >
                          {receiptPayerText(receiptResult)}
                        </p>
                      )}
                      {confirmReceiptId === s.id && (
                        <div
                          role="alertdialog"
                          aria-label={`Email ${s.recipientName} a receipt?`}
                          className="mt-2 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-2"
                        >
                          <p className="text-sm text-amber-900">
                            {receiptAt
                              ? `Email ${s.recipientName} their receipt again? They already got it on ${fmtDate(receiptAt.slice(0, 10))}.`
                              : `Email ${s.recipientName} a receipt for their payment?`}{" "}
                            It shows only their own payment. No other payer is emailed.
                          </p>
                          <div className="flex gap-2">
                            <button onClick={() => onConfirmResendReceipt(s.id, receiptIsResend(receiptAt))} className={primaryBtn()}>
                              Yes, send receipt
                            </button>
                            <button onClick={onCancelResendReceipt} className={secondaryBtn()}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      {confirmPayerId === s.id && (
                        <div
                          role="alertdialog"
                          aria-label={`Email ${s.recipientName} again?`}
                          className="mt-2 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-2"
                        >
                          <p className="text-sm text-amber-900">
                            Email {s.recipientName} their share again? {sentAt ? "They already got it" : "The earlier email may have gone through"}
                            {sentAt ? ` on ${fmtDate(sentAt.slice(0, 10))}` : ""}; they will get a second copy. No
                            other payer is emailed.
                          </p>
                          <div className="flex gap-2">
                            <button onClick={() => onConfirmAgain(s.id)} className={primaryBtn()}>
                              Yes, email again
                            </button>
                            <button onClick={onCancelAgain} className={secondaryBtn()}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <p
            className={`mt-2 rounded-lg px-2 py-1 text-sm ${
              check.ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
            }`}
          >
            {check.ok
              ? `✓ Shares add up: ${money(check.covered)} of ${money(check.total)}.`
              : `⚠️ ${check.problem ?? ""} Shares so far ${money(check.covered)} of ${money(check.total)}${
                  check.left > 0 ? ` (${money(check.left)} not assigned yet)` : ""
                }. Payers can be emailed once the shares add up.`}
          </p>
        </>
      )}
      {showForm && (
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Add a payer</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className={inputCls()}
              value={name}
              aria-label="New payer name"
              onChange={(e) => setName(e.target.value)}
              placeholder="Payer name"
            />
            <input
              className={inputCls()}
              type="email"
              value={email}
              aria-label="New payer email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Payer email (to email their share)"
            />
            <ShareInput
              kind={kind}
              value={shownValue}
              onKind={(k) => {
                setKind(k);
                setValue(null);
              }}
              onValue={(v) => setValue(v)}
            />
            <button onClick={add} disabled={name.trim() === ""} className={secondaryBtn()}>
              + Add payer
            </button>
          </div>
          {splits.length === 0 && (
            <p className="text-xs text-slate-500">
              Tip: add {customerName} as the first payer too if they pay part of it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ShareInput({
  kind,
  value,
  onKind,
  onValue,
}: {
  kind: "percentage" | "fixed";
  value: number;
  onKind: (k: "percentage" | "fixed") => void;
  onValue: (v: number) => void;
}) {
  return (
    <div className="flex gap-2">
      <select
        className={inputCls()}
        aria-label="Split by"
        value={kind}
        onChange={(e) => onKind(e.target.value as "percentage" | "fixed")}
      >
        <option value="percentage">Percent of total</option>
        <option value="fixed">Dollar amount</option>
      </select>
      {kind === "percentage" ? (
        <span className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            max={100}
            step="any"
            aria-label="Percent"
            className={inputCls()}
            value={value}
            onChange={(e) => onValue(Number(e.target.value))}
          />
          <span className="text-sm font-semibold text-slate-500">%</span>
        </span>
      ) : (
        <MoneyInput value={value} onChange={onValue} />
      )}
    </div>
  );
}
