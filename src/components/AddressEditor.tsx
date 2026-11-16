import type { CustomerAddress } from "../types";
import { blankAddress } from "../addresses";
import { inputCls, labelCls, secondaryBtn } from "./ui";

/**
 * The multi-address editor for the customer form: every address on
 * the customer as its own card, with a label, street, city, state,
 * ZIP, a Primary radio, and remove. One address always stays —
 * removing the last one is not allowed, and removing the primary
 * promotes the next address.
 */
export default function AddressEditor({
  addresses,
  onChange,
  disabled = false,
}: {
  addresses: CustomerAddress[];
  onChange: (next: CustomerAddress[]) => void;
  disabled?: boolean;
}) {
  const setOne = (id: string, patch: Partial<CustomerAddress>) =>
    onChange(addresses.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const setPrimary = (id: string) =>
    onChange(addresses.map((a) => ({ ...a, isPrimary: a.id === id })));

  const remove = (id: string) => {
    if (addresses.length <= 1) return;
    const rest = addresses.filter((a) => a.id !== id);
    // Removing the primary promotes the first remaining address.
    if (!rest.some((a) => a.isPrimary) && rest.length > 0) {
      rest[0] = { ...rest[0], isPrimary: true };
    }
    onChange(rest);
  };

  return (
    <div className="space-y-2">
      {addresses.map((a, i) => (
        <div
          key={a.id}
          className={`rounded-xl border p-3 ${
            a.isPrimary
              ? "border-emerald-300 bg-emerald-50/50"
              : "border-slate-200 bg-white"
          }`}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <input
                type="radio"
                name="primary-address"
                checked={a.isPrimary}
                disabled={disabled}
                onChange={() => setPrimary(a.id)}
              />
              Primary
              {a.isPrimary && (
                <span className="text-xs font-semibold text-emerald-700">
                  — this is the address jobs use unless another is picked
                </span>
              )}
            </label>
            {addresses.length > 1 && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(a.id)}
                className="rounded-lg px-2 py-0.5 text-lg leading-none text-slate-400 hover:text-red-600"
                title="Remove this address"
              >
                ×
              </button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={labelCls()}>Label</label>
              <input
                className={inputCls()}
                value={a.label}
                disabled={disabled}
                placeholder={i === 0 ? "Home" : "e.g. Rental, Mom's house"}
                onChange={(e) => setOne(a.id, { label: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls()}>Street address</label>
              <input
                className={inputCls()}
                value={a.street}
                disabled={disabled}
                onChange={(e) => setOne(a.id, { street: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls()}>City</label>
              <input
                className={inputCls()}
                value={a.city}
                disabled={disabled}
                onChange={(e) => setOne(a.id, { city: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls()}>State</label>
                <input
                  className={inputCls()}
                  value={a.state}
                  disabled={disabled}
                  maxLength={2}
                  onChange={(e) =>
                    setOne(a.id, { state: e.target.value.toUpperCase() })
                  }
                />
              </div>
              <div>
                <label className={labelCls()}>ZIP</label>
                <input
                  className={inputCls()}
                  value={a.zip}
                  disabled={disabled}
                  onChange={(e) => setOne(a.id, { zip: e.target.value })}
                />
              </div>
            </div>
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...addresses, blankAddress(false)])}
        className={secondaryBtn()}
      >
        + Add another address
      </button>
    </div>
  );
}
