import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { findDuplicates, primaryAddress } from "../addresses";
import {
  customerSuggestions,
  splitName,
  visitsOnDay,
} from "../salesCalendar";
import { customerDisplayName } from "../salesQueue";
import {
  customerCoords,
  formatVisitTime,
  suggestEstimateTime,
  visitSlotOptions,
} from "../scheduling";
import { fmtDateLong, todayStr } from "../utils";
import { showFlash } from "../flash";
import DuplicateCustomerWarning from "./DuplicateCustomerWarning";
import { SuggestCustomerEditForm, useSuggestsInsteadOfEditing } from "./CustomerSuggestions";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";
import type { Customer } from "../types";

/**
 * Sales calendar "Create estimate" — one form for both cases
 * (business rule): type the customer's name; if we already have
 * them, pick the suggestion and their phone, address and email fill
 * in; if not, fill those in and the customer is added. Optionally a
 * visit day and time (suggested half-hour slot, editable) so it shows
 * on the Sales calendar. "Create & write estimate" then opens the
 * estimate itself to write. The customer's open draft (no visit yet)
 * is reused instead of starting a second one
 * (src/salesCalendar.ts planCreateEstimate).
 */
export default function CreateEstimateForm({
  initialDate,
  onClose,
}: {
  /** The day the form was opened from (null = no visit yet). */
  initialDate: string | null;
  onClose: () => void;
}) {
  const { state, createSalesEstimate, openEstimate } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Customer | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(initialDate ?? "");
  const [time, setTime] = useState("");
  const [timeTouched, setTimeTouched] = useState(false);
  const [suggestion, setSuggestion] = useState<{ date: string; reason: string } | null>(null);
  const [addAnyway, setAddAnyway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const suggestsInstead = useSuggestsInsteadOfEditing();

  const suggestions = useMemo(
    () => (state && !picked ? customerSuggestions(state.customers, name) : []),
    [state, name, picked],
  );
  const { firstName, lastName } = splitName(name);
  const duplicates = useMemo(
    () =>
      state && !picked && name.trim() !== ""
        ? findDuplicates(state.customers, { firstName, lastName, phone, email, address })
        : [],
    [state, picked, name, firstName, lastName, phone, email, address],
  );

  // Suggested half-hour slot for the chosen day (re-checked when the
  // day or the customer changes), unless a time was picked by hand.
  useEffect(() => {
    if (!state || !date) return;
    let cancelled = false;
    (async () => {
      const coords = picked ? await customerCoords(picked) : null;
      if (cancelled) return;
      const s = await suggestEstimateTime(state, date, coords);
      if (cancelled) return;
      setSuggestion({ date, reason: s ? s.reason : "No free half-hour slot that day — pick a time." });
      if (!timeTouched) setTime(s ? s.time : "");
    })();
    return () => {
      cancelled = true;
    };
  }, [state, date, picked, timeTouched]);

  if (!state) return null;

  const pick = (c: Customer) => {
    const a = primaryAddress(c);
    setPicked(c);
    setName(customerDisplayName(c));
    setPhone(c.phone);
    setEmail(c.email);
    setAddress(a?.street ?? c.address);
    setCity(a?.city ?? c.city);
    setZip(a?.zip ?? c.zip);
    setAddAnyway(false);
    setError(null);
  };
  const unpick = () => {
    setPicked(null);
    setSuggesting(false);
    setPhone("");
    setEmail("");
    setAddress("");
    setCity("");
    setZip("");
  };

  const slotTaken =
    date !== "" && time !== "" && visitsOnDay(state.estimates, date).some((v) => v.visitTime === time);

  const submit = (write: boolean) => {
    setError(null);
    if (!picked) {
      if (name.trim() === "") return setError("Type the customer's name.");
      if (phone.trim() === "") return setError("Add a phone number for the new customer.");
      if (date && address.trim() === "")
        return setError("Add the address for the visit.");
      if (duplicates.length > 0 && !addAnyway)
        return setError("This looks like a customer we already have — pick them above, or choose “add as a new customer anyway”.");
    }
    if (date && !time) return setError("Choose a time for the visit.");
    if (slotTaken) return setError("That time is already booked that day — pick another.");
    if (!write && !date) return setError("Pick a visit day, or use “Create & write estimate”.");
    const id = createSalesEstimate({
      customerId: picked?.id ?? null,
      newCustomer: picked ? null : { name, phone, email, address, city, zip },
      title,
      notes,
      visitDate: date || null,
      visitTime: date ? time : null,
    });
    if (!id) return setError("Could not find that customer — try again.");
    onClose();
    if (write) {
      openEstimate(id);
    } else {
      showFlash(`Visit booked: ${fmtDateLong(date)}, ${formatVisitTime(time)} — ${name.trim()}.`);
    }
  };

  const slots = visitSlotOptions();
  const takenTimes = new Set(
    date ? visitsOnDay(state.estimates, date).map((v) => v.visitTime) : [],
  );

  return (
    <div className="space-y-4" aria-label="Create estimate">
      <div className="relative">
        <label className={labelCls()} htmlFor="ce-name">
          Customer name
        </label>
        <input
          id="ce-name"
          className={inputCls()}
          value={name}
          autoFocus
          autoComplete="off"
          placeholder="Type a name or phone number…"
          onChange={(e) => {
            if (picked) unpick();
            setName(e.target.value);
            setAddAnyway(false);
          }}
        />
        {suggestions.length > 0 && (
          <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg" role="listbox">
            {suggestions.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => pick(c)}
                  className="block w-full px-3 py-2 text-left hover:bg-emerald-50"
                >
                  <span className="block text-sm font-semibold text-slate-900">
                    {customerDisplayName(c)}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {[c.phone, primaryAddress(c)?.street ?? c.address].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked ? (
          <p className="mt-1 text-xs font-semibold text-emerald-800">
            ✓ Existing customer — details filled in.{" "}
            <button type="button" onClick={unpick} className="underline">
              Not them
            </button>
            {suggestsInstead && !suggesting && (
              <>
                {" · "}
                <button type="button" onClick={() => setSuggesting(true)} className="underline">
                  Suggest a change
                </button>
              </>
            )}
          </p>
        ) : (
          name.trim().length >= 2 && (
            <p className="mt-1 text-xs text-slate-500">
              No match picked — fill in the details below to add a new customer.
            </p>
          )
        )}
      </div>

      {picked && suggesting && (
        <SuggestCustomerEditForm customer={picked} onClose={() => setSuggesting(false)} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()} htmlFor="ce-phone">Phone</label>
          <input id="ce-phone" className={inputCls()} value={phone} disabled={!!picked} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className={labelCls()} htmlFor="ce-email">Email (optional)</label>
          <input id="ce-email" className={inputCls()} value={email} disabled={!!picked} type="email" onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()} htmlFor="ce-address">Address</label>
          <input id="ce-address" className={inputCls()} value={address} disabled={!!picked} placeholder="Street" onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <label className={labelCls()} htmlFor="ce-city">City</label>
          <input id="ce-city" className={inputCls()} value={city} disabled={!!picked} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div>
          <label className={labelCls()} htmlFor="ce-zip">ZIP</label>
          <input id="ce-zip" className={inputCls()} value={zip} disabled={!!picked} inputMode="numeric" onChange={(e) => setZip(e.target.value)} />
        </div>
      </div>

      {!picked && !addAnyway && duplicates.length > 0 && (
        <DuplicateCustomerWarning
          matches={duplicates}
          onUseExisting={(id) => {
            const c = state.customers.find((x) => x.id === id);
            if (c) pick(c);
          }}
          onAddAnyway={() => setAddAnyway(true)}
        />
      )}

      <div>
        <label className={labelCls()} htmlFor="ce-title">What is it for?</label>
        <input id="ce-title" className={inputCls()} value={title} placeholder="e.g. oak removal" onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()} htmlFor="ce-date">Visit day (optional)</label>
          <input
            id="ce-date"
            type="date"
            className={inputCls()}
            value={date}
            min={todayStr()}
            onChange={(e) => {
              setDate(e.target.value);
              setTimeTouched(false);
            }}
          />
        </div>
        <div>
          <label className={labelCls()} htmlFor="ce-time">Time</label>
          <select
            id="ce-time"
            className={inputCls()}
            value={time}
            disabled={!date}
            onChange={(e) => {
              setTime(e.target.value);
              setTimeTouched(true);
            }}
          >
            <option value="">{date ? "Choose a time" : "Pick a day first"}</option>
            {slots.map((t) => (
              <option key={t} value={t}>
                {formatVisitTime(t)}
                {takenTimes.has(t) ? " (booked)" : ""}
              </option>
            ))}
          </select>
          {date && suggestion?.date === date && !timeTouched && (
            <p className="mt-1 text-xs text-slate-500">Suggested: {suggestion.reason}</p>
          )}
        </div>
      </div>

      <div>
        <label className={labelCls()} htmlFor="ce-notes">Notes (optional)</label>
        <textarea id="ce-notes" className={inputCls()} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, what the customer said…" />
      </div>

      {error && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => submit(true)} className={primaryBtn()}>
          Create &amp; write estimate →
        </button>
        {date && (
          <button type="button" onClick={() => submit(false)} className={secondaryBtn()}>
            Book the visit, write it later
          </button>
        )}
        <button type="button" onClick={onClose} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
