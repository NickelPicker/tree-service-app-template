import { useEffect, useMemo, useRef, useState } from "react";
import { customerMatches } from "../customerSearch";
import type { KeyboardEvent } from "react";
import { useStore } from "../store";
import type { Customer, CustomerType } from "../types";
import { findDuplicates } from "../addresses";
import { isBlankCustomer, uid } from "../utils";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";
import DuplicateCustomerWarning from "./DuplicateCustomerWarning";

export function customerDisplayName(c: Customer): string {
  const name = `${c.firstName} ${c.lastName}`.trim();
  return name || c.company || "Unnamed customer";
}

const MAX_SHOWN = 50;

interface NewCustomerDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  zip: string;
  type: CustomerType;
  companyName: string;
}

const EMPTY_DRAFT: NewCustomerDraft = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  zip: "",
  type: "residential",
  companyName: "",
};

/**
 * Searchable customer picker — type a name, company, or phone number and
 * the list narrows across every customer in the company, not just the
 * first page of a dropdown. Arrow keys + Enter pick, Escape closes.
 *
 * When the person you typed is not in the system, the same dropdown
 * offers "+ Add new customer" and opens a small form right there —
 * first/last name required, the rest optional — that saves the
 * customer and selects them without ever leaving the page you are on
 * (estimate, job, invoice, or PHC). The typed name prefills the
 * first/last name fields.
 */
export default function CustomerPicker({
  value,
  onChange,
  disabled = false,
  placeholder = "Search customers by name, company, email, or phone…",
  autoFocus = false,
}: {
  value: string;
  onChange: (customerId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Put the cursor in the search box straight away (new estimate). */
  autoFocus?: boolean;
}) {
  const { state, saveCustomer } = useStore();
  const customers = state?.customers ?? [];
  const selected = customers.find((c) => c.id === value) ?? null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Inline add: the form lives inside the dropdown, so the outer
  // input's blur must not close it while the form is open — the ref
  // is the guard because it updates synchronously in the mouse event,
  // before the blur fires.
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const [draft, setDraft] = useState<NewCustomerDraft>(EMPTY_DRAFT);
  const [addError, setAddError] = useState("");
  // Duplicate safeguard: live matches for the typed name / phone /
  // email / address. Saving is blocked until the user either picks
  // the existing customer or confirms "add anyway".
  const [addAnyway, setAddAnyway] = useState(false);
  const dupMatches = useMemo(
    () =>
      findDuplicates(customers, {
        firstName: draft.firstName,
        lastName: draft.lastName,
        phone: draft.phone,
        email: draft.email,
        address: draft.address,
      }),
    [customers, draft],
  );
  const dupBlocked = dupMatches.length > 0 && !addAnyway;
  // A changed identity re-checks: the "add anyway" only covers the
  // exact details it was confirmed for.
  useEffect(() => {
    setAddAnyway(false);
  }, [
    draft.firstName,
    draft.lastName,
    draft.phone,
    draft.email,
    draft.address,
  ]);

  useEffect(() => {
    setQuery("");
    setHighlight(0);
  }, [value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Browse (no query): nameless customers stay out so they don't crowd
    // the list. Search: every customer is searchable, including nameless
    // ones (by email / phone / address).
    if (!q) return customers.filter((c) => !isBlankCustomer(c));
    // Phone numbers match on digits only (src/customerSearch.ts).
    return customers.filter((c) => customerMatches(c, q));
  }, [customers, query]);

  const shown = matches.slice(0, MAX_SHOWN);

  const pick = (c: Customer) => {
    onChange(c.id);
    setQuery("");
    setOpen(false);
  };

  const startAdding = () => {
    const words = query.trim().split(/\s+/).filter(Boolean);
    setDraft({
      ...EMPTY_DRAFT,
      firstName: words[0] ?? "",
      lastName: words.slice(1).join(" "),
    });
    setAddError("");
    addingRef.current = true;
    setAdding(true);
  };

  const cancelAdding = () => {
    addingRef.current = false;
    setAdding(false);
    setAddError("");
    setQuery("");
    setOpen(false);
  };

  const saveNewCustomer = () => {
    // Same rule as the Customers page: first and last name required.
    if (draft.firstName.trim() === "" || draft.lastName.trim() === "") {
      setAddError("First and last name are needed to add a customer.");
      return;
    }
    // Duplicate safeguard: don't save over an unacknowledged match.
    if (dupBlocked) {
      setAddError(
        "That looks like someone already in the system — pick the existing customer above, or confirm adding a new one.",
      );
      return;
    }
    const customer: Customer = {
      id: uid(),
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      company: "",
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      address: draft.address.trim(),
      city: draft.city.trim(),
      zip: draft.zip.trim(),
      addresses:
        draft.address.trim() !== "" ||
        draft.city.trim() !== "" ||
        draft.zip.trim() !== ""
          ? [
              {
                id: uid(),
                label: "Home",
                street: draft.address.trim(),
                city: draft.city.trim(),
                state: "CO",
                zip: draft.zip.trim(),
                isPrimary: true,
              },
            ]
          : [],
      propertyNotes: "",
      gateCode: "",
      notes: "",
      mapLat: null,
      mapLng: null,
      boundary: null,
      type: draft.type,
      companyName:
        draft.type === "commercial" && draft.companyName.trim() !== ""
          ? draft.companyName.trim()
          : null,
      projectName: null,
      projectNumber: null,
      poNumber: null,
      contractNumber: null,
      jobSiteAddress: null,
      billingTerms: null,
      contacts: [],
    };
    saveCustomer(customer);
    addingRef.current = false;
    setAdding(false);
    setDraft(EMPTY_DRAFT);
    setAddError("");
    setAddAnyway(false);
    setQuery("");
    setOpen(false);
    onChange(customer.id);
  };

  const set = (patch: Partial<NewCustomerDraft>) =>
    setDraft((p) => ({ ...p, ...patch }));

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && shown[highlight]) {
        e.preventDefault();
        pick(shown[highlight]);
      } else if (open && query.trim() !== "") {
        // Nothing matched — Enter opens the add form, prefilled.
        e.preventDefault();
        startAdding();
      }
    } else if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        className={`${inputCls()} ${selected && !disabled ? "pr-8" : ""}`}
        value={open ? query : selected ? customerDisplayName(selected) : query}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        autoFocus={autoFocus}
        onFocus={() => {
          setQuery("");
          setHighlight(0);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={() => {
          // While the add form is open, focus lives in the form —
          // don't let the outer input's blur close the panel.
          if (addingRef.current) return;
          setQuery("");
          setOpen(false);
        }}
        onKeyDown={handleKeyDown}
      />
      {selected && !disabled && (
        <button
          type="button"
          aria-label="Clear customer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(false);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          ×
        </button>
      )}
      {open && !disabled && adding && (
        <>
          {/* Clicking outside the form cancels it. */}
          <div
            className="fixed inset-0 z-20"
            onMouseDown={cancelAdding}
          />
          <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
            <p className="text-sm font-bold text-slate-900">
              Add new customer
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Saved right here — no need to leave this page. First and
              last name are required; the rest can be filled in later on
              the customer&apos;s profile.
            </p>
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveNewCustomer();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelAdding();
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls()}>First name *</label>
                  <input
                    className={inputCls()}
                    value={draft.firstName}
                    autoFocus
                    onChange={(e) => set({ firstName: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls()}>Last name *</label>
                  <input
                    className={inputCls()}
                    value={draft.lastName}
                    onChange={(e) => set({ lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls()}>Phone</label>
                  <input
                    type="tel"
                    inputMode="tel"
                    className={inputCls()}
                    value={draft.phone}
                    onChange={(e) => set({ phone: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls()}>Email</label>
                  <input
                    className={inputCls()}
                    value={draft.email}
                    onChange={(e) => set({ email: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className={labelCls()}>Address</label>
                <input
                  className={inputCls()}
                  value={draft.address}
                  onChange={(e) => set({ address: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls()}>City</label>
                  <input
                    className={inputCls()}
                    value={draft.city}
                    onChange={(e) => set({ city: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls()}>ZIP</label>
                  <input
                    className={inputCls()}
                    value={draft.zip}
                    onChange={(e) => set({ zip: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls()}>Type</label>
                  <select
                    className={inputCls()}
                    value={draft.type}
                    onChange={(e) =>
                      set({ type: e.target.value as CustomerType })
                    }
                  >
                    <option value="residential">Residential</option>
                    <option value="commercial">Commercial</option>
                  </select>
                </div>
                {draft.type === "commercial" && (
                  <div>
                    <label className={labelCls()}>Company name</label>
                    <input
                      className={inputCls()}
                      value={draft.companyName}
                      onChange={(e) =>
                        set({ companyName: e.target.value })
                      }
                    />
                  </div>
                )}
              </div>
              {addError && (
                <p className="text-xs font-semibold text-red-600">
                  {addError}
                </p>
              )}
              {adding && (
                <DuplicateCustomerWarning
                  matches={dupMatches}
                  onUseExisting={(id) => {
                    const c = customers.find((x) => x.id === id);
                    if (c) pick(c);
                  }}
                  onAddAnyway={() => {
                    setAddAnyway(true);
                    setAddError("");
                  }}
                />
              )}
              <div className="flex gap-2 pt-1">
                <button type="submit" className={primaryBtn()}>
                  Save &amp; select customer
                </button>
                <button
                  type="button"
                  onClick={cancelAdding}
                  className={secondaryBtn()}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      )}
      {open && !disabled && !adding && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {shown.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                  i === highlight ? "bg-emerald-50" : ""
                } hover:bg-emerald-50`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-slate-900">
                    {customerDisplayName(c)}
                    {c.company ? ` · ${c.company}` : ""}
                  </span>
                  <span className="block truncate text-slate-500">
                    {isBlankCustomer(c) && c.email
                      ? c.email
                      : `${c.address}, ${c.city}`}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-500">
              No customers match “{query}”.
            </li>
          )}
          {matches.length > MAX_SHOWN && (
            <li className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-500">
              Showing {MAX_SHOWN} of {matches.length} matches — keep typing
              to narrow it down.
            </li>
          )}
          <li className="border-t border-slate-100">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                startAdding();
              }}
              className="w-full px-3 py-2 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              + Add{" "}
              {query.trim() !== "" ? `“${query.trim()}” as a ` : ""}new
              customer…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
