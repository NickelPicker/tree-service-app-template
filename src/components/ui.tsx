import { useEffect, useState } from "react";
import type {
  DiscountType,
  EstimateStatus,
  InvoiceStatus,
  JobStatus,
} from "../types";
import { estimateTotals } from "../email";
import { ESTIMATE_STATUS_LABELS } from "../estimateStatus";

export function lineSubtotal(
  lines: Array<{ quantity: number; unitPrice: number }>,
): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
}

export function withTax(subtotal: number, taxRate: number): number {
  return subtotal * (1 + taxRate / 100);
}

export function docTotal(
  lines: Array<{ quantity: number; unitPrice: number }>,
  taxRate: number,
): number {
  return withTax(lineSubtotal(lines), taxRate);
}

/** Discount-aware totals for estimates (tax applies after the discount). */
export function docTotals(
  lines: Array<{ quantity: number; unitPrice: number }>,
  taxRate: number,
  discountType: DiscountType,
  discountValue: number,
) {
  return estimateTotals(lines, taxRate, discountType, discountValue);
}

/**
 * Money input with a $ prefix and no leading zero. Empty means blank
 * (value 0); typing replaces rather than appending to a "0" — a typed
 * "05" becomes "5", never "05". Sub-dollar values like "0.50" still work.
 */
export function MoneyInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === 0 ? "" : String(value));
  useEffect(() => {
    const parsed = text === "" || text === "." ? 0 : Number(text);
    if (parsed !== value) setText(value === 0 ? "" : String(value));
    // Sync only when the parent value changed from outside this input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const handle = (raw: string) => {
    let v = raw.replace(/[^0-9.]/g, "");
    const dot = v.indexOf(".");
    if (dot !== -1) {
      v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
    }
    v = v.replace(/^0+(?=\d)/, "");
    setText(v);
    onChange(v === "" || v === "." ? 0 : Number(v));
  };
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="text-sm font-semibold text-slate-500">
        $
      </span>
      <input
        inputMode="decimal"
        className={inputCls()}
        value={text}
        placeholder={placeholder ?? "0.00"}
        onChange={(e) => handle(e.target.value)}
        onBlur={onBlur}
      />
    </span>
  );
}

/** Whole-number quantity input with the same no-leading-zero behavior. */
export function QtyInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    const parsed = text === "" ? 0 : Number(text);
    if (parsed !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const handle = (raw: string) => {
    const v = raw.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
    setText(v);
    onChange(v === "" ? 0 : Number(v));
  };
  return (
    <input
      inputMode="numeric"
      className={inputCls()}
      value={text}
      onChange={(e) => handle(e.target.value)}
    />
  );
}

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-sky-100 text-sky-800",
  in_progress: "bg-amber-100 text-amber-800",
  done: "bg-emerald-100 text-emerald-800",
  draft: "bg-slate-200 text-slate-700",
  sent: "bg-sky-100 text-sky-800",
  accepted: "bg-emerald-100 text-emerald-800",
  closed: "bg-slate-100 text-slate-500",
  unpaid: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  overdue: "bg-red-100 text-red-800",
  partial: "bg-violet-100 text-violet-800",
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  done: "Done",
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  closed: ESTIMATE_STATUS_LABELS.closed,
  unpaid: "Unpaid",
  paid: "Paid",
  overdue: "Overdue",
  partial: "Partially paid",
};

export function StatusBadge({
  status,
}: {
  status: JobStatus | EstimateStatus | InvoiceStatus;
}) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[status] ?? "bg-slate-200 text-slate-700"}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function inputCls(): string {
  return "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600";
}

export function labelCls(): string {
  return "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
}

export function primaryBtn(): string {
  return "rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50";
}

export function secondaryBtn(): string {
  return "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50";
}

export function dangerBtn(): string {
  return "rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50";
}

/**
 * Consistent clickable affordance for anything that opens a record:
 * pointer cursor + emerald text + underline on hover. Used by every
 * page for job / employee / customer / estimate / invoice references.
 */
export function linkCls(): string {
  return "cursor-pointer font-semibold text-emerald-700 hover:underline";
}
