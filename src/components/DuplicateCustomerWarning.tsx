import type { DuplicateMatch } from "../addresses";
import { addressLine, customerAddresses } from "../addresses";
import { primaryBtn, secondaryBtn } from "./ui";

/**
 * The duplicate safeguard, shared by the Customers page form and the
 * inline add in the customer picker. Shows every existing customer
 * that looks like the same person, with the reason it matched, and
 * lets the user open the existing record instead — or add anyway.
 * It never blocks by itself; the caller decides whether saving needs
 * the explicit "add anyway".
 */
export default function DuplicateCustomerWarning({
  matches,
  onUseExisting,
  onAddAnyway,
  addAnywayLabel = "No — add as a new customer anyway",
}: {
  matches: DuplicateMatch[];
  /** Open the existing customer (pick it in a picker, or open it for editing on the Customers page). */
  onUseExisting: (customerId: string) => void;
  /** The user confirmed this really is a new person; allow the save. */
  onAddAnyway: () => void;
  addAnywayLabel?: string;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 p-3">
      <p className="text-sm font-bold text-red-800">
        ⚠ Already in the system? {matches.length === 1 ? "This looks" : "These look"} like the same person — check before adding a duplicate.
      </p>
      <ul className="mt-2 space-y-2">
        {matches.map(({ customer: c, reasons }) => {
          const primary = customerAddresses(c)[0];
          return (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-white p-2"
            >
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-slate-900">
                  {`${c.firstName} ${c.lastName}`.trim() || c.company || "Unnamed customer"}
                </p>
                <p className="truncate text-slate-500">
                  {primary ? addressLine(primary) : "No address on file"}
                  {c.phone ? ` · ${c.phone}` : ""}
                  {c.email ? ` · ${c.email}` : ""}
                </p>
                <p className="text-xs font-semibold text-red-700">
                  Matched: {reasons.join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onUseExisting(c.id)}
                className={primaryBtn()}
              >
                Use this one
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onAddAnyway}
        className={`${secondaryBtn()} mt-2`}
      >
        {addAnywayLabel}
      </button>
    </div>
  );
}
