import { useState } from "react";
import { useStore } from "../store";
import type { Customer } from "../types";
import { isEmailAddress, sendBlockedReason } from "../sendReady";
import { inputCls, secondaryBtn } from "./ui";

/**
 * Shown next to a greyed-out Send button when the customer has no
 * email: "Add Dana's email to send this", with a box to add it right
 * here (it saves on the customer, so it is fixed everywhere).
 */
export default function NeedsEmail({ customer }: { customer: Customer }) {
  const { saveCustomer, canEdit } = useStore();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reason = sendBlockedReason(customer);
  if (!reason) return null;
  const save = () => {
    const v = email.trim();
    if (!isEmailAddress(v)) {
      setError("That doesn't look like an email address (it needs an @ and a dot).");
      return;
    }
    saveCustomer({ ...customer, email: v });
    setEmail("");
    setError(null);
  };
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-semibold">{reason}</p>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            className={`${inputCls()} min-h-11 max-w-xs flex-1`}
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            aria-label="Customer email"
          />
          <button onClick={save} disabled={!email.trim()} className={`${secondaryBtn()} min-h-11`}>
            Save email
          </button>
        </div>
      )}
      {error && <p className="text-red-700">{error}</p>}
    </div>
  );
}
