import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Customer } from "../types";
import { inputCls, labelCls } from "./ui";

/**
 * Bill-to details, editable right on the invoice. Every field writes
 * back to the customer profile (saveCustomer) when you leave the
 * field, so fixing missing info here fixes it everywhere — the
 * customer page, the next invoice, the email. Empty fields are flagged
 * "Missing" in amber. Commercial customers also get billing company
 * and PO number.
 */
function BillField({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const missing = value.trim() === "";
  return (
    <div>
      <label className={labelCls()}>
        {label}
        {missing && (
          <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
            Missing
          </span>
        )}
      </label>
      <input
        className={`${inputCls()} ${
          missing ? "border-amber-400 bg-amber-50" : ""
        }`}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = draft.trim();
          if (v !== value) onSave(v);
          else setDraft(value);
        }}
      />
    </div>
  );
}

const FIELDS: Array<{
  key: keyof Customer;
  label: string;
  commercialOnly?: boolean;
}> = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "zip", label: "ZIP" },
  { key: "companyName", label: "Billing company", commercialOnly: true },
  { key: "poNumber", label: "PO number", commercialOnly: true },
];

export default function BillToEditor({ customer }: { customer: Customer }) {
  const { saveCustomer, canEdit } = useStore();
  const save = (patch: Partial<Customer>) =>
    saveCustomer({ ...customer, ...patch });
  const visible = FIELDS.filter(
    (f) => !f.commercialOnly || customer.type === "commercial",
  );
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm font-bold text-slate-900">
        Bill to — saved to the customer profile
      </p>
      <p className="text-xs text-slate-500">
        Fill in anything missing here; it updates{" "}
        {customer.firstName || "this customer"}&apos;s profile everywhere,
        not just this invoice.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {visible.map((f) => (
          <BillField
            key={f.key}
            label={f.label}
            value={String(customer[f.key] ?? "")}
            disabled={!canEdit}
            onSave={(v) => save({ [f.key]: v } as Partial<Customer>)}
          />
        ))}
      </div>
    </div>
  );
}
