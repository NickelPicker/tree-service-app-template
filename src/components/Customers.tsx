import { useEffect, useMemo, useState } from "react";
import { useDraft, useStore } from "../store";
import type { Customer } from "../types";
import { blankAddress, customerAddresses, findDuplicates } from "../addresses";
import { isBlankCustomer, uid } from "../utils";
import AddressEditor from "./AddressEditor";
import { addressLine, customerMatches } from "../customerSearch";
import DuplicateCustomerWarning from "./DuplicateCustomerWarning";
import CustomerOverview from "./CustomerOverview";
import TreeMap from "./TreeMap";
import {
  dangerBtn,
  inputCls,
  labelCls,
  primaryBtn,
  secondaryBtn,
} from "./ui";

type CustomerDraft = Omit<Customer, "id">;

const EMPTY_CUSTOMER: CustomerDraft = {
  firstName: "",
  lastName: "",
  company: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  zip: "",
  addresses: [],
  propertyNotes: "",
  gateCode: "",
  notes: "",
  mapLat: null,
  mapLng: null,
  boundary: null,
  type: "residential",
  companyName: null,
  projectName: null,
  projectNumber: null,
  poNumber: null,
  contractNumber: null,
  jobSiteAddress: null,
  billingTerms: null,
  contacts: [],
  noAutoEmails: false,
};

function CustomerForm({
  existing,
  onDone,
  onOpenExisting,
}: {
  existing: Customer | null;
  onDone: () => void;
  /** Open an existing customer for editing (duplicate safeguard). */
  onOpenExisting?: (id: string) => void;
}) {
  const { state, saveCustomer } = useStore();
  const draftKey = existing ? `customer-edit-${existing.id}` : "customer-new";
  const initial: CustomerDraft = existing
    ? {
        firstName: existing.firstName,
        lastName: existing.lastName,
        company: existing.company,
        phone: existing.phone,
        email: existing.email,
        address: existing.address,
        city: existing.city,
        zip: existing.zip,
        addresses:
          (existing.addresses ?? []).length > 0
            ? existing.addresses
            : customerAddresses(existing),
        propertyNotes: existing.propertyNotes,
        gateCode: existing.gateCode,
        notes: existing.notes,
        mapLat: existing.mapLat ?? null,
        mapLng: existing.mapLng ?? null,
        boundary: existing.boundary ?? null,
        type: existing.type ?? "residential",
        companyName: existing.companyName ?? null,
        projectName: existing.projectName ?? null,
        projectNumber: existing.projectNumber ?? null,
        poNumber: existing.poNumber ?? null,
        contractNumber: existing.contractNumber ?? null,
        jobSiteAddress: existing.jobSiteAddress ?? null,
        billingTerms: existing.billingTerms ?? null,
        contacts: existing.contacts ?? [],
        noAutoEmails: existing.noAutoEmails === true,
      }
    : { ...EMPTY_CUSTOMER, addresses: [blankAddress(true)] };
  const draft = useDraft<CustomerDraft>(draftKey, initial);

  // The form body calls more hooks, so it renders only once the draft
  // has loaded (an early return above those hooks breaks React's
  // rules of hooks when `restored` flips to true).
  if (!draft.restored) {
    return <p className="text-sm text-slate-500">Loading form…</p>;
  }
  return (
    <CustomerFormLoaded
      existing={existing}
      onDone={onDone}
      onOpenExisting={onOpenExisting}
      state={state}
      saveCustomer={saveCustomer}
      draft={draft}
    />
  );
}

function CustomerFormLoaded({
  existing,
  onDone,
  onOpenExisting,
  state,
  saveCustomer,
  draft,
}: {
  existing: Customer | null;
  onDone: () => void;
  onOpenExisting?: (id: string) => void;
  state: ReturnType<typeof useStore>["state"];
  saveCustomer: ReturnType<typeof useStore>["saveCustomer"];
  draft: ReturnType<typeof useDraft<CustomerDraft>>;
}) {
  const { value, setValue, hasDraft, discard } = draft;

  const set = (patch: Partial<CustomerDraft>) =>
    setValue((prev) => ({ ...prev, ...patch }));
  const canSave = value.firstName.trim() !== "" && value.lastName.trim() !== "";

  // The addresses the editor works with: the draft's list, or — for
  // a restored draft that predates multi-address — the customer's
  // current addresses (synthesized from the legacy fields when the
  // customer has no list yet), or one blank card for a new customer.
  const formAddresses = useMemo(() => {
    const list = value.addresses ?? [];
    if (list.length > 0) return list;
    if (existing) return customerAddresses(existing);
    return [blankAddress(true)];
  }, [value.addresses, existing]);

  // Duplicate safeguard (new customers only): live matches for the
  // typed name / phone / email / street. Saving is blocked until the
  // user opens the existing customer or confirms "add anyway".
  const isNew = existing === null;
  const [addAnyway, setAddAnyway] = useState(false);
  const dupMatches = useMemo(
    () =>
      isNew
        ? findDuplicates(state?.customers ?? [], {
            firstName: value.firstName,
            lastName: value.lastName,
            phone: value.phone,
            email: value.email,
            // The form edits addresses through the editor now — the
            // primary address is what the street match checks.
            address: formAddresses[0]?.street ?? "",
          })
        : [],
    [
      isNew,
      state?.customers,
      value.firstName,
      value.lastName,
      value.phone,
      value.email,
      formAddresses,
    ],
  );
  const dupBlocked = dupMatches.length > 0 && !addAnyway;
  // A changed identity re-checks: the "add anyway" only covers the
  // exact details it was confirmed for.
  useEffect(() => {
    setAddAnyway(false);
  }, [
    value.firstName,
    value.lastName,
    value.phone,
    value.email,
    formAddresses,
  ]);

  const handleSave = () => {
    if (!canSave) return;
    if (dupBlocked) return;
    saveCustomer({
      ...value,
      addresses: formAddresses,
      id: existing ? existing.id : uid(),
    });
    discard();
    onDone();
  };

  return (
    <div className="space-y-4">
      {hasDraft && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            Draft restored — your unsaved changes were kept automatically.
          </span>
          <button
            onClick={discard}
            className="shrink-0 font-semibold underline"
          >
            Discard draft
          </button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>First name *</label>
          <input
            className={inputCls()}
            value={value.firstName}
            onChange={(e) => set({ firstName: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls()}>Last name *</label>
          <input
            className={inputCls()}
            value={value.lastName}
            onChange={(e) => set({ lastName: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Company (optional)</label>
          <input
            className={inputCls()}
            value={value.company}
            onChange={(e) => set({ company: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls()}>Customer type</label>
          <select
            className={inputCls()}
            value={value.type ?? "residential"}
            onChange={(e) =>
              set({ type: e.target.value as CustomerDraft["type"] })
            }
          >
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
        </div>
      </div>

      {value.type === "commercial" && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
          <p className="mb-3 text-sm font-bold text-sky-900">
            Commercial details — project and billing
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls()}>Contracting company</label>
              <input
                className={inputCls()}
                value={value.companyName ?? ""}
                onChange={(e) =>
                  set({ companyName: e.target.value || null })
                }
                placeholder="e.g. Front Range Civil Group"
              />
            </div>
            <div>
              <label className={labelCls()}>Billing terms</label>
              <input
                className={inputCls()}
                value={value.billingTerms ?? ""}
                onChange={(e) =>
                  set({ billingTerms: e.target.value || null })
                }
                placeholder="e.g. Net 30"
              />
            </div>
            <div>
              <label className={labelCls()}>Project name</label>
              <input
                className={inputCls()}
                value={value.projectName ?? ""}
                onChange={(e) =>
                  set({ projectName: e.target.value || null })
                }
                placeholder="e.g. Harvard Gulch Stormwater Improvements"
              />
            </div>
            <div>
              <label className={labelCls()}>Project number</label>
              <input
                className={inputCls()}
                value={value.projectNumber ?? ""}
                onChange={(e) =>
                  set({ projectNumber: e.target.value || null })
                }
                placeholder="e.g. FR-2026-114"
              />
            </div>
            <div>
              <label className={labelCls()}>PO number</label>
              <input
                className={inputCls()}
                value={value.poNumber ?? ""}
                onChange={(e) => set({ poNumber: e.target.value || null })}
                placeholder="e.g. PO-88412"
              />
            </div>
            <div>
              <label className={labelCls()}>Contract number</label>
              <input
                className={inputCls()}
                value={value.contractNumber ?? ""}
                onChange={(e) =>
                  set({ contractNumber: e.target.value || null })
                }
                placeholder="e.g. C-2026-047"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls()}>
                Job-site address (may differ from billing address)
              </label>
              <input
                className={inputCls()}
                value={value.jobSiteAddress ?? ""}
                onChange={(e) =>
                  set({ jobSiteAddress: e.target.value || null })
                }
                placeholder="e.g. 123 Main St, Anytown, CO 12310"
              />
            </div>
          </div>
          <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Contacts
          </p>
          {(value.contacts ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No contacts yet.</p>
          ) : (
            <ul className="space-y-2">
              {(value.contacts ?? []).map((ct) => (
                <li
                  key={ct.id}
                  className="rounded-lg border border-slate-200 bg-white p-2"
                >
                  <div className="grid gap-2 sm:grid-cols-4">
                    <input
                      className={inputCls()}
                      value={ct.name}
                      onChange={(e) =>
                        set({
                          contacts: (value.contacts ?? []).map((x) =>
                            x.id === ct.id
                              ? { ...x, name: e.target.value }
                              : x,
                          ),
                        })
                      }
                      placeholder="Name"
                    />
                    <select
                      className={inputCls()}
                      value={ct.role}
                      onChange={(e) =>
                        set({
                          contacts: (value.contacts ?? []).map((x) =>
                            x.id === ct.id
                              ? {
                                  ...x,
                                  role: e.target.value as typeof ct.role,
                                }
                              : x,
                          ),
                        })
                      }
                    >
                      <option value="Project Manager">Project Manager</option>
                      <option value="Superintendent">Superintendent</option>
                      <option value="Accounts Payable">Accounts Payable</option>
                      <option value="Other">Other</option>
                    </select>
                    <input
                      className={inputCls()}
                      value={ct.email}
                      onChange={(e) =>
                        set({
                          contacts: (value.contacts ?? []).map((x) =>
                            x.id === ct.id
                              ? { ...x, email: e.target.value }
                              : x,
                          ),
                        })
                      }
                      placeholder="Email"
                    />
                    <div className="flex gap-2">
                      <input
                        className={inputCls()}
                        value={ct.phone}
                        onChange={(e) =>
                          set({
                            contacts: (value.contacts ?? []).map((x) =>
                              x.id === ct.id
                                ? { ...x, phone: e.target.value }
                                : x,
                            ),
                          })
                        }
                        placeholder="Phone"
                      />
                      <button
                        onClick={() =>
                          set({
                            contacts: (value.contacts ?? []).filter(
                              (x) => x.id !== ct.id,
                            ),
                          })
                        }
                        className="shrink-0 rounded-lg text-lg text-slate-400 hover:text-red-600"
                        title="Remove contact"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() =>
              set({
                contacts: [
                  ...(value.contacts ?? []),
                  {
                    id: uid(),
                    name: "",
                    role: "Project Manager",
                    email: "",
                    phone: "",
                  },
                ],
              })
            }
            className={`${secondaryBtn()} mt-2`}
          >
            + Add contact
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Project and PO numbers show on this customer&apos;s jobs,
            estimates, and invoices.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>Phone</label>
          <input
            type="tel"
            inputMode="tel"
            className={inputCls()}
            value={value.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls()}>Email</label>
          <input
            type="email"
            inputMode="email"
            className={inputCls()}
            value={value.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls()}>Gate code</label>
          <input
            className={inputCls()}
            value={value.gateCode}
            onChange={(e) => set({ gateCode: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={value.noAutoEmails === true}
              onChange={(e) => set({ noAutoEmails: e.target.checked })}
            />
            No automatic emails
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Tick this when the customer asks to stop reminders, thank-yous
            and review requests. Emails you send yourself still go.
          </p>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-bold text-slate-900">
          Addresses
          {formAddresses.length > 1 && (
            <span className="ml-2 text-xs font-semibold text-slate-500">
              {formAddresses.length} addresses — the job form will ask which one each job is at.
            </span>
          )}
        </p>
        <AddressEditor
          addresses={formAddresses}
          onChange={(next) => set({ addresses: next })}
        />
      </div>
      <div>
        <label className={labelCls()}>Property notes</label>
        <textarea
          className={inputCls()}
          rows={3}
          value={value.propertyNotes}
          onChange={(e) => set({ propertyNotes: e.target.value })}
          placeholder="Trees on site, access notes, hazards, pets…"
        />
      </div>
      <div>
        <label className={labelCls()}>General notes</label>
        <textarea
          className={inputCls()}
          rows={2}
          value={value.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
      <p className="text-xs text-slate-500">
        This form saves automatically as you type. If you leave and come
        back, your draft will be right where you left it.
      </p>
      {isNew && (
        <DuplicateCustomerWarning
          matches={dupMatches}
          onUseExisting={(id) => {
            if (onOpenExisting) onOpenExisting(id);
          }}
          onAddAnyway={() => setAddAnyway(true)}
        />
      )}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={primaryBtn()}
        >
          Save customer
        </button>
        <button onClick={onDone} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function letterFor(c: Customer): string {
  const name = (c.firstName || c.lastName || c.company || "").trim();
  const ch = name.charAt(0).toUpperCase();
  return ch >= "A" && ch <= "Z" ? ch : "#";
}

const ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

function CustomerDetail({
  customer,
  onEdit,
  onClose,
}: {
  customer: Customer;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { state, deleteCustomer, canEdit } = useStore();
  if (!state) return null;
  return (
    <div className="p-4">
      <CustomerOverview
        customer={customer}
        headerActions={
          <>
            {canEdit && (
              <button onClick={onEdit} className={`${secondaryBtn()} min-h-11`}>
                Edit
              </button>
            )}
            <button onClick={onClose} className={`${secondaryBtn()} min-h-11`}>
              Close
            </button>
          </>
        }
        treeMap={<TreeMap key={customer.id} customerId={customer.id} />}
        footer={
          canEdit ? (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${customer.firstName} ${customer.lastName} and their jobs, trees, estimates, and invoices?`,
                  )
                ) {
                  deleteCustomer(customer.id);
                  onClose();
                }
              }}
              className={dangerBtn()}
            >
              Delete customer
            </button>
          ) : null
        }
      />
    </div>
  );
}

export default function Customers() {
  const {
    state,
    canEdit,
    customerFocusId,
    setCustomerFocusId,
    canSeeAllCustomers,
    viewerId,
  } = useStore();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<"new" | "edit" | null>(null);

  // A customer drawer elsewhere can ask this page to select someone.
  useEffect(() => {
    if (customerFocusId) {
      setSelectedId(customerFocusId);
      setFormMode(null);
      setCustomerFocusId(null);
      const id = customerFocusId;
      setTimeout(() => {
        document
          .getElementById(`customer-row-${id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  }, [customerFocusId, setCustomerFocusId]);

  const filtered = useMemo(() => {
    if (!state) return [];
    // Per-user permission: without "all customers", the list shows
    // only the customers of jobs assigned to the viewer.
    let customers = state.customers;
    if (!canSeeAllCustomers) {
      const mine = new Set(
        state.jobs
          .filter((j) => j.crewIds.includes(viewerId))
          .map((j) => j.customerId),
      );
      customers = customers.filter((c) => mine.has(c.id));
    }
    const sorted = [...customers].sort(
      (a, b) =>
        (a.firstName || "").localeCompare(b.firstName || "", undefined, {
          sensitivity: "base",
        }) ||
        (a.lastName || "").localeCompare(b.lastName || "", undefined, {
          sensitivity: "base",
        }) ||
        (a.company || "").localeCompare(b.company || "", undefined, {
          sensitivity: "base",
        }),
    );
    const q = query.trim().toLowerCase();
    // Browse (no query): nameless customers stay out of the list so they
    // don't crowd it. Search: every customer is searchable, including
    // nameless ones (by email / phone / address).
    if (!q) return sorted.filter((c) => !isBlankCustomer(c));
    // Phone numbers match on digits only (src/customerSearch.ts).
    return sorted.filter((c) => customerMatches(c, q));
  }, [state, query, canSeeAllCustomers, viewerId]);

  const groups = useMemo(() => {
    const map = new Map<string, { customer: Customer; number: number }[]>();
    filtered.forEach((c, i) => {
      const letter = letterFor(c);
      const rows = map.get(letter) ?? [];
      rows.push({ customer: c, number: i + 1 });
      map.set(letter, rows);
    });
    return [...map.entries()].sort(([a], [b]) =>
      a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b),
    );
  }, [filtered]);

  const lettersPresent = useMemo(
    () => new Set(groups.map(([letter]) => letter)),
    [groups],
  );

  const scrollToSection = (letter: string) => {
    document
      .getElementById(`customer-section-${letter}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!state) return null;
  const selected = state.customers.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
        {canEdit && (
          <button
            onClick={() => {
              setFormMode("new");
              setSelectedId(null);
            }}
            className={primaryBtn()}
          >
            + New customer
          </button>
        )}
      </div>

      {formMode && (
        <section
          id="customer-form"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <h2 className="mb-3 text-base font-bold text-slate-900">
            {formMode === "new"
              ? "New customer"
              : `Edit ${selected?.firstName ?? ""} ${selected?.lastName ?? ""}`}
          </h2>
          <CustomerForm
            key={formMode === "edit" ? selected?.id ?? "edit" : "new"}
            existing={formMode === "edit" ? selected : null}
            onDone={() => setFormMode(null)}
            onOpenExisting={(id) => {
              setSelectedId(id);
              setFormMode("edit");
            }}
          />
        </section>
      )}

      <input
        className={inputCls()}
        placeholder="Search customers by name, email, address, or phone…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="-mt-2 text-sm text-slate-500">
        {filtered.length} customer{filtered.length === 1 ? "" : "s"}
        {query.trim() ? " matching your search" : ""}
      </p>

      <div className="flex gap-2">
        <nav
          aria-label="Jump to letter"
          className="sticky top-4 flex h-fit flex-col items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-sm"
        >
          {ALPHABET.map((letter) => {
            const present = lettersPresent.has(letter);
            return (
              <button
                key={letter}
                disabled={!present}
                onClick={() => scrollToSection(letter)}
                className={`w-7 rounded-md py-0.5 text-xs font-bold ${
                  present
                    ? "text-emerald-700 hover:bg-emerald-50"
                    : "cursor-default text-slate-300"
                }`}
              >
                {letter}
              </button>
            );
          })}
        </nav>

        <ul className="min-w-0 flex-1 space-y-2">
          {groups.map(([letter, rows]) => (
            <li key={letter}>
              <div
                id={`customer-section-${letter}`}
                className="flex items-baseline gap-2 pt-2"
              >
                <span className="text-lg font-bold text-slate-900">
                  {letter}
                </span>
                <span className="text-xs text-slate-500">
                  {rows.length} customer{rows.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-1 space-y-2">
                {rows.map(({ customer: c }) => (
                  <li key={c.id} id={`customer-row-${c.id}`}>
                    <button
                      onClick={() => {
                        setSelectedId(selectedId === c.id ? null : c.id);
                        setFormMode(null);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl border bg-white p-3 text-left shadow-sm hover:border-emerald-500 ${
                        selectedId === c.id
                          ? "border-emerald-600"
                          : "border-slate-200"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-slate-900">
                          {c.firstName} {c.lastName}
                          {c.company ? ` · ${c.company}` : ""}
                          {c.type === "commercial" && (
                            <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-sky-800">
                              Commercial
                            </span>
                          )}
                        </span>
                        {c.type === "commercial" && c.projectName && (
                          <span className="block text-sm text-slate-600">
                            {c.projectName}
                            {c.projectNumber ? ` · ${c.projectNumber}` : ""}
                            {c.poNumber ? ` · ${c.poNumber}` : ""}
                          </span>
                        )}
                        {addressLine(c) && (
                          <span className="block text-sm text-slate-600">
                            {addressLine(c)}
                          </span>
                        )}
                        <span className="block text-sm text-slate-500">
                          {c.phone}
                          {c.email ? ` · ${c.email}` : ""}
                        </span>
                      </span>
                    </button>
                    {selectedId === c.id && (
                      <div className="mt-2 rounded-xl border border-slate-200 bg-white shadow-sm">
                        <CustomerDetail
                          customer={c}
                          onEdit={() => {
                            setFormMode("edit");
                            document
                              .getElementById("customer-form")
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                              });
                          }}
                          onClose={() => setSelectedId(null)}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="text-sm text-slate-500">No customers match.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
