import { useStore } from "../store";
import { paymentDetails } from "../payments";

/**
 * The "How to pay" box on every invoice the customer sees — the
 * invoice detail, the customer portal, and (as plain text) the
 * invoice email. Short: the ways to pay the business offers, plus
 * the memo instruction with the invoice number. The details come
 * from the company profile (setup wizard, or Schedule → Calendar
 * settings → Company); when nothing is set there, the box stays
 * hidden instead of showing blanks.
 */
export default function HowToPay({
  invoiceNumber,
  showSetupHint,
}: {
  invoiceNumber: string;
  /** On internal pages, point the owner at where to fill this in. */
  showSetupHint?: boolean;
}) {
  const { state } = useStore();
  const { zelleNumber, checkPayee, checkMailingAddress } = paymentDetails(
    state?.settings.company,
  );
  if (!zelleNumber && !checkPayee) {
    if (!showSetupHint) return null;
    return (
      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm text-slate-600">
          No payment details yet — add how customers pay you in
          Schedule → Calendar settings → Company, and the
          &ldquo;How to pay&rdquo; box will show on this invoice.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
      <p className="text-sm font-bold text-emerald-900">How to pay</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-emerald-900">
        {zelleNumber && <li>Zelle — send to {zelleNumber}.</li>}
        {checkPayee && (
          <li>
            Check — payable to {checkPayee}
            {checkMailingAddress ? `, mail to ${checkMailingAddress}.` : "."}
          </li>
        )}
      </ul>
      <p className="mt-1 text-sm text-emerald-900">
        Please note the payment method and put invoice {invoiceNumber} in
        the memo.
      </p>
    </div>
  );
}
