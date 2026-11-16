import { canTapJobStatus } from "../liveProgress";
import { canMakeInvoiceForJob, jobInvoicePricing, okToInvoiceWithOpenClock, okToMakeZeroInvoice } from "../invoiceMaking";
import { useClimberPriceBeforeChange, useCrewPrices } from "../crewPrices";
import { PriceList } from "./JobSheet";
import { climberNewPrice } from "../priceChange";
import { useEffect, useRef, useState } from "react";
import { useLoadedState, useStore } from "../store";
import type { Job } from "../types";
import {
  addressLine,
  customerAddresses,
  primaryAddress,
} from "../addresses";
import {
  isSchedulable,
  suggestCrew,
  blockedReason,
  handAddedNote,
  usuallyOffReason,
  type SuggestedCrew,
} from "../crewSuggest";
import { hourlyLaborCost, jobCosting, jobEstimate, jobPriceBeforeChange, jobValue, jobValueSource, priceReplaced, replacedJobPrice } from "../jobValue";
import { showFlash } from "../flash";
import { geocodeAddress } from "../routing";
import { googleMapsPinLink } from "../splits";
import { money, uid } from "../utils";
import { newJobMissing } from "../jobForm";
import { isOwnerLike, jobMoneyEdits, mayChangeJob } from "../permissions";
import AuditList from "./AuditLog";
import { OldPrice, PriceChangeBox, PriceChangeHistory } from "./JobPriceChanges";
import CustomerPicker from "./CustomerPicker";
import DriverBoard from "./DriverBoard";
import PinMap from "./PinMap";
import {
  dangerBtn,
  inputCls,
  labelCls,
  linkCls,
  MoneyInput,
  primaryBtn,
  secondaryBtn,
} from "./ui";

/**
 * The one job editor, shared by the schedule drawer and the global
 * detail drawer. There is intentionally only one copy: editing a job
 * from any page runs this exact form, so behavior can never drift
 * between pages.
 */
export default function JobEditor(
  props: Parameters<typeof JobEditorLoaded>[0],
) {
  const { state } = useStore();
  if (!state) return null;
  return <JobEditorLoaded {...props} />;
}

function JobEditorLoaded({
  job,
  defaultDate,
  defaultStartTime,
  defaultCustomerId,
  onClose,
  onInvoice,
  onOpenInvoice,
}: {
  job: Job | null;
  defaultDate: string;
  /** Start time to prefill for a new job (from the timetable). */
  defaultStartTime?: string;
  /** Customer to prefill for a new job (customer page "New job"). */
  defaultCustomerId?: string;
  onClose: () => void;
  onInvoice: (jobId: string) => void;
  /** When set, the linked-invoice notice offers to open that invoice. */
  onOpenInvoice?: (invoiceId: string) => void;
}) {
  // canEdit here means "may edit this job's fields" (crew Climbers
  // included). Creating, deleting and invoicing a job need canManage
  // (the store's canEdit): the database refuses those from crew logins.
  const {
    saveJob,
    deleteJob,
    canEdit: canManage,
    canEditJobs,
    role,
    viewer,
    viewerId,
    openCustomer,
    restoreEstimatePrice,
  } = useStore();
  const state = useLoadedState();
  // A Climber changes only the jobs he is on ("see all jobs" is for
  // looking; the database refuses the rest, the "rls tightening" rules).
  const canEdit = mayChangeJob(job, viewerId, {
    canManage,
    canEditJobs,
    dayCrews: state.dayCrews,
  });
  // Crew on the job who can't edit its other fields may still change
  // its status (the database allows that), e.g. to undo a mistaken
  // "Done": the Arrived/Done buttons offer no way back.
  const statusOnly =
    !canEdit && !!job && canTapJobStatus(job, viewerId, role);
  // Crew Climbers edit the work on a job, but its day, customer and
  // address are the office's (the database refuses them from crew).
  const officeFieldsLocked = role === "crew";
  const [form, setForm] = useState<Job>(
    job ?? {
      id: uid(),
      // Blank until someone picks: a guessed customer was easy to
      // save by mistake (review).
      customerId: defaultCustomerId ?? "",
      serviceType: "Trimming",
      title: "",
      date: defaultDate,
      startTime: defaultStartTime ?? "08:00",
      status: "scheduled",
      crewIds: [],
      notes: "",
      customerNotes: "",
      teamNotes: "",
      officeNotes: "",
      pruneClass: null,
      estimatedHours: null,
      estimateId: null,
      invoiceId: null,
      addressId: null,
      value: null,
      billingType: null,
      hourlyRate: null,
      treeIds: [],
      equipmentIds: [],
      equipmentDrivers: null,
      expectedCrew: null,
      endDate: null,
      recurring: null,
      recurringUntil: null,
      materialsCost: null,
      otherCost: null,
      laborRate: null,
      lat: null,
      lng: null,
    },
  );
  const showMoney = useStore().showMoney;
  // Which money fields this viewer may change: a crew Climber changes
  // the prices (value, hourly rate, billing) even without "see money",
  // the costs only with it (the "climbers change prices" rules).
  const moneyEdits = jobMoneyEdits({
    canEdit: canManage,
    canEditJobs: canEdit,
    seeMoney: showMoney,
  });
  // The office types prices straight into the form; a Climber changes
  // them only in the price box, with a reason (the "climber price change notes" rules).
  const pricesInForm = moneyEdits.prices && !moneyEdits.withReason;
  // Crew Climbers without "see money" see the accepted option's prices
  // (crew_job_prices), never the job's money fields.
  const climberPrices =
    useCrewPrices(!showMoney && viewer?.role === "Climber" && !!job).get(job?.id ?? "") ?? [];
  const climberPriceBefore = useClimberPriceBeforeChange(
    !showMoney && viewer?.role === "Climber" && !!job && !priceReplaced(job),
    job?.id ?? null,
  );
  // Live copy of the job from the store: creating an invoice from the
  // panel updates the store, and the panel must see that link without
  // navigating away.
  const liveJob = job
    ? (state.jobs.find((x) => x.id === job.id) ?? null)
    : null;
  const linkedInvoice = liveJob?.invoiceId
    ? (state.invoices.find((i) => i.id === liveJob.invoiceId) ?? null)
    : null;
  // Money is hidden for Crew viewers, same rule as everywhere else.
  // The header value previews the DRAFT (so the hourly rate and the
  // hours update it live as they are typed), with the invoice and
  // estimate links taken from the live store copy — creating an
  // invoice from the panel updates the value without reopening.
  const displayJob: Job = {
    ...form,
    invoiceId: liveJob?.invoiceId ?? form.invoiceId,
    estimateId: liveJob?.estimateId ?? form.estimateId,
    // Set by the database when a Climber changes the price.
    replacedPrice: liveJob ? liveJob.replacedPrice : form.replacedPrice,
  };
  const displayValue = jobValue(state, displayJob);
  // Which source actually supplies the value (invoice → hourly →
  // estimate → manual), so the label can never disagree with the
  // number.
  const displaySource = jobValueSource(state, displayJob);
  // The price a Climber's change replaced, shown struck through.
  const displayReplaced = replacedJobPrice(state, displayJob);
  // A Climber's price box: the estimate's price is the current price
  // until a Climber replaces it.
  // The same figure the database keeps as the replaced price (the
  // estimate's total after discount and tax), so the box's "+$100" is
  // the real change.
  const climberShown =
    displayJob.billingType === "hourly" || priceReplaced(displayJob)
      ? null
      : showMoney
        ? jobEstimate(state, displayJob)
          ? jobPriceBeforeChange(state, displayJob)
          : null
        : climberPriceBefore;
  // Which source actually supplies the value (invoice → hourly →
  // estimate → manual), so the label can never disagree with the
  // number. The value is shown FROM the source, never copied into
  // the job's manual value field, so if the estimate or invoice
  // changes the job follows automatically.
  const set = (patch: Partial<Job>) => setForm((p) => ({ ...p, ...patch }));
  const toggleCrew = (id: string) =>
    set({
      crewIds: form.crewIds.includes(id)
        ? form.crewIds.filter((x) => x !== id)
        : [...form.crewIds, id],
    });
  const toggleTree = (id: string) =>
    set({
      treeIds: (form.treeIds ?? []).includes(id)
        ? (form.treeIds ?? []).filter((x) => x !== id)
        : [...(form.treeIds ?? []), id],
    });
  const toggleEquipment = (id: string) =>
    set({
      equipmentIds: (form.equipmentIds ?? []).includes(id)
        ? (form.equipmentIds ?? []).filter((x) => x !== id)
        : [...(form.equipmentIds ?? []), id],
    });
  // Crew suggestion: computed on demand from the rules, the estimator's cap,
  // availability, time off and the day's other jobs. Applying it fills
  // the crew checkboxes and the drivers below; the user can still
  // adjust anyone by hand afterwards.
  const [suggestion, setSuggestion] = useState<SuggestedCrew | null>(null);
  const applySuggestion = () => {
    if (!state) return;
    const s = suggestCrew(state, form, form.date);
    set({
      crewIds: s.crewIds,
      equipmentDrivers:
        Object.keys(s.drivers).length > 0 ? s.drivers : null,
    });
    setSuggestion(s);
  };
  const canSave = form.title.trim() !== "" && form.customerId !== "";
  // New jobs show the few fields most jobs need; the rest sit under
  // "More details" (src/jobForm.ts lists what is missing).
  const [moreOpen, setMoreOpen] = useState(job !== null);
  const moreCls = moreOpen ? "" : "hidden";
  const missing = newJobMissing(form);
  const customer = state.customers.find((c) => c.id === form.customerId) ?? null;
  const customerTrees = state.trees.filter((t) => t.customerId === form.customerId);
  // The customer's addresses: when there is more than one, the job
  // must pick one — the red picker below and the popup enforce it, and
  // the save is blocked until a choice is made.
  const addresses = customerAddresses(customer);
  const needsAddressChoice = addresses.length > 1 && !officeFieldsLocked;
  const addressChosen =
    !!form.addressId && addresses.some((a) => a.id === form.addressId);
  const canSaveWithAddress =
    canSave && (!needsAddressChoice || addressChosen);
  // The address this job routes to: the picked address wins, else the
  // commercial job-site address, else the customer's primary address.
  const explicitlyChosen = form.addressId
    ? (addresses.find((a) => a.id === form.addressId) ?? null)
    : null;
  const customerAddress = customer
    ? explicitlyChosen
      ? addressLine(explicitlyChosen)
      : customer.type === "commercial" && customer.jobSiteAddress
        ? customer.jobSiteAddress
        : (() => {
            const p = primaryAddress(customer);
            return p ? addressLine(p) : null;
          })()
    : null;
  // Popup reminder: the first time this editor shows a customer with
  // several addresses and no address picked yet, stop and ask which
  // one the job is at. Once per customer/job pair — dismissing it
  // leaves the red picker (and the save block) in place.
  const [addressPromptOpen, setAddressPromptOpen] = useState(false);
  const promptedFor = useRef("");
  useEffect(() => {
    const key = `${form.customerId}:${job?.id ?? "new"}`;
    if (needsAddressChoice && !addressChosen && promptedFor.current !== key) {
      promptedFor.current = key;
      setAddressPromptOpen(true);
    }
  }, [needsAddressChoice, addressChosen, form.customerId, job?.id]);
  // Where the map starts when no pin is set: the customer's saved map location, if any.
  const mapCenter: [number, number] | null =
    customer && customer.mapLat !== null && customer.mapLng !== null
      ? [customer.mapLat, customer.mapLng]
      : null;
  const costing = displayJob ? jobCosting(state, displayJob) : null;
  // Planned labor cost per hour, from the DRAFT crew — it updates
  // live as names are checked on/off. This is the planned cost from
  // each person's pay rate (plus anyone ticked "Count on every job"); the costing box
  // above shows what was actually clocked.
  const labor = hourlyLaborCost(state, displayJob, form.crewIds);
  const [copied, setCopied] = useState(false);
  // The map opens when the job has a pin (saved, or placed from the
  // address) — otherwise it stays collapsed until opened.
  const [mapOpen, setMapOpen] = useState(
    job?.lat != null && job?.lng != null,
  );
  const pinLink =
    form.lat !== null && form.lng !== null
      ? googleMapsPinLink(form.lat, form.lng)
      : null;

  // Auto-pin: when the editor opens (or the address changes), the
  // job's address is geocoded through the shared queue and the pin
  // is placed on the map — the map opens with it. The pin follows
  // the address unless the user placed it by hand for this address:
  // a saved pin stays put until the address changes, and dragging
  // the pin or dropping a new one always wins for the current
  // address. A failed lookup leaves the pin absent with a note —
  // never a guessed location.
  type GeoStatus = "idle" | "loading" | "pinned" | "failed" | "no-address";
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  const [rederiveTick, setRederiveTick] = useState(0);
  const openAddrRef = useRef<string | null>(null);
  const openedWithPinRef = useRef(job?.lat != null && job?.lng != null);
  const manualPinAddrRef = useRef<string | null>(null);
  const autoMovedRef = useRef(false);
  const mapClosedRef = useRef(false);
  useEffect(() => {
    const addr = customerAddress;
    if (openAddrRef.current === null) openAddrRef.current = addr;
    if (!addr) {
      setGeoStatus("no-address");
      return;
    }
    // A pin the user placed by hand for this address stays put.
    if (manualPinAddrRef.current === addr) return;
    // A pin saved on the job stays put until the address changes.
    if (
      openedWithPinRef.current &&
      addr === openAddrRef.current &&
      !autoMovedRef.current
    ) {
      return;
    }
    setGeoStatus("loading");
    const t = window.setTimeout(() => {
      void geocodeAddress(addr).then((pt) => {
        if (manualPinAddrRef.current === addr) return;
        if (!pt) {
          setGeoStatus("failed");
          return;
        }
        setForm((p) => ({ ...p, lat: pt.lat, lng: pt.lng }));
        autoMovedRef.current = true;
        setGeoStatus("pinned");
        if (!mapClosedRef.current) setMapOpen(true);
      });
    }, 400);
    return () => window.clearTimeout(t);
    // The pin follows the resolved address, not the whole form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerAddress, rederiveTick]);

  return (
    <section>
      {!canEdit && (
        <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
          You can look at this job. The office or an owner can change it
          {statusOnly
            ? "; you can still change the status (for example, undo a mistaken Done)."
            : "."}
        </p>
      )}
      {displayJob && showMoney && (
        <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
          Job value:{" "}
          {displayValue !== null && showMoney ? (
            <>
              <OldPrice amount={displayReplaced} />
              <span className="font-bold">{money(displayValue)}</span>
            </>
          ) : (
            <span className="text-slate-500">No value set yet</span>
          )}
          {displayValue !== null && showMoney && (
            <span className="text-slate-500"> ({displaySource.label})</span>
          )}
        </p>
      )}
      {customer?.type === "commercial" && (
        <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <span className="font-semibold">Commercial — {customer.companyName ?? customer.company}</span>
          {customer.projectName && (
            <>
              <br />
              Project: {customer.projectName}
              {customer.projectNumber ? ` (${customer.projectNumber})` : ""}
            </>
          )}
          {customer.poNumber && (
            <>
              <br />
              PO: {customer.poNumber}
              {customer.contractNumber ? ` · Contract: ${customer.contractNumber}` : ""}
            </>
          )}
          {customer.jobSiteAddress && (
            <>
              <br />
              Job site: {customer.jobSiteAddress}
            </>
          )}
          {customer.billingTerms && (
            <>
              <br />
              Billing terms: {customer.billingTerms}
            </>
          )}
        </p>
      )}
      {costing && showMoney && (costing.estimated !== null || costing.actual > 0) && (
        <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
          <p className="font-semibold">Job costing</p>
          <p>
            Estimated:{" "}
            {costing.estimated !== null ? money(costing.estimated) : "—"}
            {" · "}Actual: {money(costing.actual)} (
            {costing.laborHours} hrs × {money(costing.laborRate)}/hr ={" "}
            {money(costing.laborCost)} labor
            {costing.materials > 0 ? ` + ${money(costing.materials)} materials` : ""}
            {costing.other > 0 ? ` + ${money(costing.other)} other` : ""})
          </p>
          {isOwnerLike(viewer?.appRole) &&
            costing.laborByPerson.length > 0 &&
            (costing.laborByPerson.length > 1 ||
              costing.laborByPerson.some((p) => p.basis !== "hourly")) && (
              <p className="text-xs text-slate-500">
                {costing.laborByPerson.map((p) => p.detail).join(" · ")}
              </p>
            )}
          {costing.profit !== null && (
            <p className={costing.profit >= 0 ? "text-emerald-700" : "text-red-700"}>
              Profit: {money(costing.profit)}
              {costing.beforeTax !== null &&
                costing.estimated !== null &&
                Math.abs(costing.estimated - costing.beforeTax) >= 0.005 && (
                  <span className="text-xs text-slate-500"> (sales tax left out)</span>
                )}
            </p>
          )}
          {costing.estimated === null && (
            <p className="text-xs text-slate-500">
              No estimated value yet — link an estimate or invoice, or set a
              manual job value, and profit will show here.
            </p>
          )}
        </div>
      )}
      {showMoney && labor.lines.length > 0 && (
        <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
          <p className="font-semibold">Labor: {money(labor.perHour)}/hr</p>
          <p className="text-xs text-slate-500">
            {labor.lines
              .map((l) => `${l.name} ${money(l.rate)}/hr`)
              .join(" · ")}
          </p>
          {labor.lines.some((l) => l.note) && (
            <p className="mt-1 text-xs text-slate-500">
              {labor.lines
                .filter((l) => l.note)
                .map((l) => `${l.name}: ${l.note}`)
                .join(" · ")}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            From each person&apos;s pay rate (day rate ÷ 8h)
            {labor.alwaysCounted.length > 0
              ? `; ${labor.alwaysCounted.join(", ")} always counted (ticked on their card)`
              : ""}
            . Planned cost — the costing box above shows what was actually clocked.
          </p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls()}>
            Customer{job === null ? " (required)" : ""}
          </label>
          <CustomerPicker
            value={form.customerId}
            disabled={!canEdit || officeFieldsLocked}
            onChange={(customerId) =>
              // A new customer means a new address choice: the old
              // pick belonged to the previous customer.
              set({ customerId, addressId: null })
            }
          />
        </div>
        {needsAddressChoice && (
          <div className="rounded-xl border-2 border-red-400 bg-red-50 p-3 shadow-sm sm:col-span-2">
            <p className="text-sm font-bold text-red-800">
              ⚠ Which address is this job at?
            </p>
            <p className="mt-0.5 text-xs text-red-700">
              {`${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim()}{" "}
              has {addresses.length} addresses — pick the one the crew
              should go to. The job can&apos;t be saved until you do.
            </p>
            <div className="mt-2 space-y-2">
              {addresses.map((a) => (
                <label
                  key={a.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border bg-white p-2 text-sm ${
                    form.addressId === a.id
                      ? "border-red-500 ring-1 ring-red-500"
                      : "border-red-200"
                  }`}
                >
                  <input
                    type="radio"
                    name="job-address"
                    className="mt-1"
                    checked={form.addressId === a.id}
                    disabled={!canEdit}
                    onChange={() => set({ addressId: a.id })}
                  />
                  <span>
                    <span className="font-semibold text-slate-900">
                      {a.label.trim() !== "" ? a.label : "Address"}
                      {a.isPrimary ? " (primary)" : ""}
                    </span>
                    <br />
                    <span className="text-slate-600">
                      {addressLine(a)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {!addressChosen && (
              <p className="mt-2 text-xs font-bold text-red-700">
                Pick an address before saving — the crew needs the right one.
              </p>
            )}
          </div>
        )}
        <div>
          <label className={labelCls()}>Service type</label>
          <select
            className={inputCls()}
            value={form.serviceType}
            disabled={!canEdit}
            onChange={(e) =>
              set({ serviceType: e.target.value as Job["serviceType"] })
            }
          >
            {(
              [
                "Removal",
                "Trimming",
                "Stump Grinding",
                "Plant Health Care",
                "Emergency",
                "Fertilization",
              ] as const
            ).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:col-span-2">
          <button
            onClick={() =>
              setMapOpen((o) => {
                mapClosedRef.current = o;
                return !o;
              })
            }
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={mapOpen}
          >
            <span className="text-sm font-bold text-slate-900">
              Job location {mapOpen ? "▾" : "▸"}
            </span>
            <span className="text-xs font-semibold text-emerald-700">
              {mapOpen ? "Hide map" : "Show map"}
            </span>
          </button>
          <p className="mt-1 text-sm text-slate-600">
            {form.lat !== null && form.lng !== null
              ? `Pinned at ${form.lat.toFixed(6)}, ${form.lng.toFixed(6)} — the crew navigates from this pin.`
              : customerAddress
                ? `Uses the customer's address: ${customerAddress}.`
                : "Pick a customer and the job uses their address."}
          </p>
          {geoStatus === "loading" && (
            <p className="mt-1 text-xs text-slate-500">
              Placing the pin from the address…
            </p>
          )}
          {geoStatus === "failed" && (
            <p className="mt-1 text-xs font-semibold text-amber-700">
              Couldn&apos;t place this address on the map — drop a pin by
              hand.
            </p>
          )}
          {geoStatus === "no-address" && customer && (
            <p className="mt-1 text-xs text-slate-500">
              No street address on file — open the map to drop a pin.
            </p>
          )}
          {customer?.type === "commercial" && !customerAddress && (
            <p className="mt-1 text-sm font-semibold text-amber-700">
              Commercial job with no street address — open the map to drop a
              pin (field work, or a corner lot).
            </p>
          )}
          {canEdit && form.lat !== null && (
            <button
              onClick={() => {
                // Clear the manual pin and place a fresh one from the
                // address — the pin follows the address again.
                manualPinAddrRef.current = null;
                openedWithPinRef.current = false;
                set({ lat: null, lng: null });
                setRederiveTick((t) => t + 1);
              }}
              className={`${secondaryBtn()} mt-2`}
            >
              Use customer address instead
            </button>
          )}
          {mapOpen && (
            <>
              <div className="mt-2">
                <PinMap
                  key={form.customerId}
                  lat={form.lat}
                  lng={form.lng}
                  center={mapCenter}
                  disabled={!canEdit}
                  onPick={(lat, lng) => {
                    // A pin placed by hand wins for this address.
                    manualPinAddrRef.current = customerAddress;
                    set({ lat, lng });
                  }}
                />
              </div>
              {pinLink && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <a
                    href={pinLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-semibold text-emerald-700 underline"
                  >
                    Open in Google Maps →
                  </a>
                  <button
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(pinLink)
                        .then(() => {
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 2000);
                        });
                    }}
                    className={secondaryBtn()}
                  >
                    {copied ? "Copied!" : "Send to crew — copy link"}
                  </button>
                  <span className="text-xs text-slate-500">
                    Paste the link into a message to the crew; it opens
                    straight to the pin.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Job title</label>
          <input
            className={inputCls()}
            value={form.title}
            disabled={!canEdit}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="e.g. Crown clean — silver maple"
          />
        </div>
        <div>
          <label className={labelCls()}>Date</label>
          <input
            type="date"
            className={inputCls()}
            value={form.date}
            disabled={!canEdit || officeFieldsLocked}
            onChange={(e) => set({ date: e.target.value })}
          />
          {officeFieldsLocked && canEdit && (
            <p className="mt-1 text-xs text-slate-500">
              Only the office can move a job to another day or change its customer or address.
            </p>
          )}
        </div>
        <div>
          <label className={labelCls()}>Start time</label>
          <input
            type="time"
            className={inputCls()}
            value={form.startTime}
            disabled={!canEdit}
            onChange={(e) => set({ startTime: e.target.value })}
          />
          <label className="mt-1.5 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.timePromised === true}
              disabled={!canEdit}
              onChange={(e) => set({ timePromised: e.target.checked })}
              className="h-4 w-4 accent-emerald-700"
            />
            Customer was promised this time
          </label>
          <p className="mt-0.5 text-xs text-slate-500">
            Ticked: the Plan board never moves it. Unticked: the board may change the start time to fit the day.
          </p>
        </div>
        <div className={moreCls}>
          <label className={labelCls()}>End date (multi-day job)</label>
          <input
            type="date"
            className={inputCls()}
            value={form.endDate ?? ""}
            disabled={!canEdit || officeFieldsLocked}
            onChange={(e) => set({ endDate: e.target.value || null })}
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank for a single-day job.
          </p>
        </div>
        <div className={moreCls}>
          <label className={labelCls()}>Recurring service</label>
          <select
            className={inputCls()}
            value={form.recurring ?? ""}
            disabled={!canEdit}
            onChange={(e) =>
              set({
                recurring: (e.target.value || null) as Job["recurring"],
              })
            }
          >
            <option value="">One-off</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="seasonal">Seasonal (spring/fall)</option>
          </select>
        </div>
        {form.recurring && (
          <div className={moreCls}>
            <label className={labelCls()}>Recurring until</label>
            <input
              type="date"
              className={inputCls()}
              value={form.recurringUntil ?? ""}
              disabled={!canEdit}
              onChange={(e) => set({ recurringUntil: e.target.value || null })}
            />
          </div>
        )}
        <div className={moreCls}>
          <label className={labelCls()}>Status</label>
          <select
            className={inputCls()}
            value={form.status}
            disabled={!canEdit && !statusOnly}
            onChange={(e) =>
              set({ status: e.target.value as Job["status"] })
            }
          >
            <option value="scheduled">Scheduled</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        </div>
        {/* Money: only for people allowed to see prices (audit #9). A
            Climber without "see money" gets the accepted price list and
            the price box: he sees the job's current price and changes
            it there with a reason (business rules,
            migrations the "climbers change prices" rules and the "climber price change notes" rules). */}
        {showMoney ? (
        <>
        <div className={moreCls}>
          <label className={labelCls()}>Billed</label>
          {pricesInForm ? (
            <select
              className={inputCls()}
              value={form.billingType ?? "flat"}
              onChange={(e) =>
                set({
                  billingType:
                    e.target.value === "hourly" ? "hourly" : "flat",
                })
              }
            >
              <option value="flat">Flat — one price for the job</option>
              <option value="hourly">Hourly — rate × hours</option>
            </select>
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              {form.billingType === "hourly" ? "Hourly" : "Flat"}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Hourly jobs bill the rate × the approximate hours below
            (when the job has no invoice). Estimates stay flat.
          </p>
        </div>
        {form.billingType === "hourly" && (
          <div className={moreCls}>
            <label className={labelCls()}>Hourly rate ($/hr)</label>
            {pricesInForm ? (
              <MoneyInput
                value={form.hourlyRate ?? 0}
                onChange={(n) => set({ hourlyRate: n === 0 ? null : n })}
                placeholder="0.00"
              />
            ) : (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
                {form.hourlyRate != null
                  ? money(form.hourlyRate)
                  : "No rate set"}
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {form.hourlyRate != null && (form.estimatedHours ?? 0) > 0
                ? `= ${money(form.hourlyRate * (form.estimatedHours as number))} at ${form.estimatedHours}h`
                : "Set a rate and approximate hours to see the job value."}
            </p>
          </div>
        )}
        <div>
          <label className={labelCls()}>Job value ($)</label>
          {displaySource.kind !== "manual" ? (
            <>
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
                {showMoney && displayValue !== null ? (
                  <>
                    <span className="font-bold">{money(displayValue)}</span>
                    <span className="text-slate-500">
                      {" "}
                      ({displaySource.label})
                    </span>
                  </>
                ) : (
                  `Value comes from the linked ${
                    displaySource.kind === "invoice"
                      ? "invoice"
                      : displaySource.kind === "hourly"
                        ? "hourly billing"
                        : "estimate"
                  }.`
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {displaySource.kind === "invoice"
                  ? "Comes from the linked invoice — change the invoice and this follows."
                  : displaySource.kind === "hourly"
                    ? "Hourly billing — rate × hours. Change the rate or hours and this follows."
                    : "Comes from the linked estimate — change the estimate and this follows automatically."}
              </p>
            </>
          ) : pricesInForm ? (
            <MoneyInput
              value={form.value ?? 0}
              onChange={(n) => set({ value: n === 0 ? null : n })}
              placeholder="0.00"
            />
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              {form.value !== null ? money(form.value) : "No manual value set"}
            </p>
          )}
          {displaySource.kind === "manual" && priceReplaced(displayJob) ? (
            <div className="mt-1 text-xs text-slate-600" data-testid="climber-price-note">
              <p>
                A Climber changed the price. It replaces the estimate&apos;s price
                {showMoney && displayReplaced !== null ? (
                  <>
                    {" "}(<OldPrice amount={displayReplaced} />
                    no longer used)
                  </>
                ) : null}
                .
              </p>
              {canManage && job && displayJob.estimateId && (
                <button
                  type="button"
                  className={`${linkCls()} mt-1`}
                  onClick={() => {
                    if (!window.confirm("Use the estimate's price for this job again? The Climber's price will no longer count.")) return;
                    void restoreEstimatePrice(job.id).then((err) => {
                      if (err) showFlash(`Not saved: ${err}`, { tone: "warn" });
                      else set({ replacedPrice: null });
                    });
                  }}
                >
                  Use the estimate&apos;s price again
                </button>
              )}
            </div>
          ) : displaySource.kind === "manual" ? (
            <p className="mt-1 text-xs text-slate-500">
              Fallback value — shown on the schedule only when the job has
              no linked invoice, no hourly billing, and no estimate.
            </p>
          ) : null}
        </div>
        {moneyEdits.withReason && job && (
          <PriceChangeBox job={liveJob ?? job} shown={climberShown} onSaved={(p) => set(p)} />
        )}
        </>
        ) : climberPrices.length > 0 || (moneyEdits.prices && !!job) ? (
          <>
            {climberPrices.length > 0 && (
              <div className="sm:col-span-2">
                <PriceList lines={climberPrices} newPrice={climberNewPrice(liveJob ?? job ?? form)} />
                {!priceReplaced(liveJob ?? job ?? form) && (
                  <p className="mt-1 text-sm font-semibold text-slate-800">
                    Total: {money(climberPrices.reduce((t, l) => t + l.price, 0))}
                  </p>
                )}
              </div>
            )}
            {moneyEdits.prices && !!job && (
              <PriceChangeBox job={liveJob ?? job} shown={climberShown} onSaved={(p) => set(p)} />
            )}
          </>
        ) : null}
        <div className="sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className={labelCls()}>Assigned employees</label>
            {canEdit && (
              <button
                type="button"
                onClick={applySuggestion}
                className="rounded-lg border border-emerald-700 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                ✨ Suggest crew
              </button>
            )}
          </div>
          {suggestion && (
            <div className="mb-2 space-y-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-slate-800">
              {suggestion.reasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
              {suggestion.warnings.map((w) => (
                <p key={w} className="font-semibold text-amber-700">
                  ⚠ {w}
                </p>
              ))}
              {suggestion.warnings.length === 0 && (
                <p className="text-slate-600">
                  Suggested {suggestion.crewIds.length}{" "}
                  {suggestion.crewIds.length === 1 ? "person" : "people"} —
                  adjust anyone below.
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            {state.crew
              .filter(
                (c) => isSchedulable(c) || form.crewIds.includes(c.id),
              )
              .map((c) => {
                // Business rule: someone on time off or marked
                // unavailable that day cannot be put on the job. If they are
                // already on it, they stay ticked so the office can untick
                // them. Usually off that weekday is only a note: they can be
                // ticked by hand.
                const reason = blockedReason(state, c.id, form.date);
                const usuallyOff = reason ? null : usuallyOffReason(state, c.id, form.date);
                const onJob = form.crewIds.includes(c.id);
                const locked = !!reason && !onJob;
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 text-sm ${locked ? "cursor-not-allowed text-slate-400" : "cursor-pointer text-slate-800"}`}
                  >
                    <input
                      type="checkbox"
                      checked={onJob}
                      disabled={!canEdit || locked}
                      onChange={() => toggleCrew(c.id)}
                      className="h-4 w-4 accent-emerald-700"
                    />
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: c.color, opacity: locked ? 0.4 : 1 }}
                    />
                    {c.name} · {c.role}
                    {reason && (
                      <span className={`font-semibold ${onJob ? "text-red-700" : "text-slate-500"}`}>
                        — {reason}
                        {onJob ? " (untick to take them off)" : ""}
                      </span>
                    )}
                    {usuallyOff && (
                      <span className="font-semibold text-amber-700">
                        — {onJob ? handAddedNote(usuallyOff) : usuallyOff}
                      </span>
                    )}
                  </label>
                );
              })}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Check everyone assigned to this job. A job can have several
            people on it; leave everyone unchecked to leave it
            unassigned. People removed from the team no longer appear
            here. People on time off or marked unavailable are greyed out
            and can&apos;t be assigned. &quot;Usually off&quot; people are
            never suggested, but you can tick them if they are free.
          </p>
          <DriverBoard
            state={state}
            form={form as Job}
            canEdit={canEdit}
            onChange={(p) => set(p)}
          />
        </div>
        {!moreOpen && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-expanded={false}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:col-span-2"
          >
            ▸ More details (end date, repeat, billing, trees, equipment, notes)
          </button>
        )}
        {moreOpen && (<>
        <div>
          <label className={labelCls()}>
            Expected crew — internal, never shown to the customer
          </label>
          <input
            type="number"
            min={0}
            className={inputCls()}
            value={form.expectedCrew ?? ""}
            disabled={!canEdit}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              set({ expectedCrew: isNaN(n) || n <= 0 ? null : n });
            }}
            placeholder="How many people should this job take?"
          />
          <p className="mt-1 text-xs text-slate-500">
            Carried from the estimate the estimator wrote, or set here. The crew
            suggestion never suggests more than this.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Trees this job is for</label>
          {customerTrees.length === 0 ? (
            <p className="text-sm text-slate-500">
              No trees mapped for this customer yet — add them on the
              customer&apos;s map.
            </p>
          ) : (
            <div className="space-y-1.5">
              {customerTrees.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={(form.treeIds ?? []).includes(t.id)}
                    disabled={!canEdit}
                    onChange={() => toggleTree(t.id)}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  {t.label}
                  {t.species ? ` — ${t.species}` : ""}
                  {t.dbh ? ` (${t.dbh})` : ""}
                </label>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Linked trees get this job in their work history.
          </p>
          {form.customerId && (
            <button
              type="button"
              onClick={() => openCustomer(form.customerId)}
              className="mt-2 text-xs font-semibold text-emerald-700 hover:underline"
            >
              Open the property map to pin trees →
            </button>
          )}
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>
            Prune class — only for pruning jobs
          </label>
          <select
            className={inputCls()}
            value={form.pruneClass ?? ""}
            disabled={!canEdit}
            onChange={(e) =>
              set({
                pruneClass:
                  (e.target.value || null) as Job["pruneClass"],
              })
            }
          >
            <option value="">Not a pruning job / not set</option>
            <option value="1">Class I — Fine pruning</option>
            <option value="2">Class II — Standard pruning</option>
            <option value="3">Class III — Hazard pruning</option>
            <option value="4">Class IV — Crown reduction</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            The crew&apos;s day briefing shows the definition for the class
            set here.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Equipment</label>
          {state.equipment.length === 0 ? (
            <p className="text-sm text-slate-500">No equipment on file.</p>
          ) : (
            <div className="space-y-1.5">
              {state.equipment.map((e) => (
                <label
                  key={e.id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={(form.equipmentIds ?? []).includes(e.id)}
                    disabled={!canEdit}
                    onChange={() => toggleEquipment(e.id)}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  {e.name} · {e.kind}
                  {e.details ? ` — ${e.details}` : ""}
                  {e.status !== "available" ? ` (${e.status})` : ""}
                </label>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Equipment booked on this job shows on the schedule and the
            route view. Say who drives each piece in &quot;Who&apos;s driving
            what&quot; under Assigned employees.
          </p>
        </div>
        {showMoney && (
          <>
            <div>
              <label className={labelCls()}>Materials cost ($)</label>
              <MoneyInput
                value={form.materialsCost ?? 0}
                onChange={(n) => set({ materialsCost: n === 0 ? null : n })}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className={labelCls()}>Other costs ($)</label>
              <MoneyInput
                value={form.otherCost ?? 0}
                onChange={(n) => set({ otherCost: n === 0 ? null : n })}
                placeholder="0.00"
              />
              <p className="mt-1 text-xs text-slate-500">
                Crane rental, permits, disposal, etc.
              </p>
            </div>
            <div>
              <label className={labelCls()}>Default labor rate ($/hr)</label>
              <MoneyInput
                value={form.laborRate ?? 75}
                onChange={(n) => set({ laborRate: n === 0 ? null : n })}
                placeholder="75.00"
              />
              <p className="mt-1 text-xs text-slate-500">
                Applies to crew without their own pay rate set on the Users
                page. Blank = $75/hr default.
              </p>
            </div>
          </>
        )}
        <div>
          <label className={labelCls()}>
            Approximate hours on the job
          </label>
          <input
            type="number"
            min={0}
            step={0.5}
            className={inputCls()}
            value={form.estimatedHours ?? ""}
            disabled={!canEdit}
            placeholder="e.g. 4"
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              set({ estimatedHours: isNaN(n) ? null : n });
            }}
          />
          <p className="mt-1 text-xs text-slate-500">
            The estimator&apos;s estimate for the job — not the clocked timesheet.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Notes</label>
          <textarea
            className={inputCls()}
            rows={2}
            value={form.notes}
            disabled={!canEdit}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>
            Notes for the customer
          </label>
          <textarea
            className={inputCls()}
            rows={2}
            value={form.customerNotes}
            disabled={!canEdit}
            placeholder="What the customer should know about this job."
            onChange={(e) => set({ customerNotes: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-500">
            Shown to the customer — keep it plain and friendly.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls()}>Notes — team (crew sees this)</label>
          <textarea
            className={inputCls()}
            rows={2}
            value={form.teamNotes}
            disabled={!canEdit}
            placeholder="What the crew needs to know on site."
            onChange={(e) => set({ teamNotes: e.target.value })}
          />
        </div>
        {role !== "crew" && (
          <div className="sm:col-span-2">
            <label className={labelCls()}>
              Notes — office only (crew never sees this)
            </label>
            <textarea
              className={inputCls()}
              rows={2}
              value={form.officeNotes}
              disabled={!canEdit}
              placeholder="Pricing, customer history, things only the office should know."
              onChange={(e) => set({ officeNotes: e.target.value })}
            />
          </div>
        )}
        </>)}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {canEdit && (job || canManage) && (
          <button
            disabled={!canSaveWithAddress}
            onClick={() => {
              // Keep store-side links (e.g. a just-created invoice) that
              // the form snapshot predates.
              const prices = liveJob ?? job;
              saveJob({
                ...form,
                invoiceId: liveJob?.invoiceId ?? form.invoiceId,
                estimateId: liveJob?.estimateId ?? form.estimateId,
                replacedPrice: liveJob ? liveJob.replacedPrice : form.replacedPrice,
                // A Climber's Save never sends a price: those change
                // only in the price box, with a reason (the database
                // refuses them otherwise).
                ...(moneyEdits.withReason && prices
                  ? { value: prices.value, hourlyRate: prices.hourlyRate, billingType: prices.billingType }
                  : {}),
              });
              onClose();
            }}
            className={primaryBtn()}
          >
            Save job
          </button>
        )}
        {statusOnly && job && form.status !== job.status && (
          <button
            onClick={() => {
              // Only the status: everything else on this job is
              // read-only for this login.
              saveJob({ ...(liveJob ?? job), status: form.status });
              onClose();
            }}
            className={primaryBtn()}
          >
            Save status
          </button>
        )}
        {canEdit && job === null && missing.length > 0 && (
          <p className="w-full text-sm font-semibold text-red-700">
            To save, {missing.join(" and ")}.
          </p>
        )}
        {canEdit && !canSaveWithAddress && needsAddressChoice && !addressChosen && (
          <p className="w-full text-xs font-bold text-red-700">
            Pick the job address above before saving.
          </p>
        )}
        {canManage && job && !linkedInvoice && canMakeInvoiceForJob(state, liveJob ?? job) && (
          <button
            onClick={() => {
              const j = liveJob ?? job;
              if (okToInvoiceWithOpenClock(state, j) && okToMakeZeroInvoice(jobInvoicePricing(state, j).total)) onInvoice(job.id);
            }}
            className={`${secondaryBtn()} min-h-11`}
          >
            Create invoice from this job
          </button>
        )}
        {job && linkedInvoice && (
          <div className="w-full rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <p>
              Invoice {linkedInvoice.number} is linked to this job
              (status: {linkedInvoice.status}).
            </p>
            {onOpenInvoice && (
              <button
                onClick={() => onOpenInvoice(linkedInvoice.id)}
                className="mt-1 font-semibold underline"
              >
                Open invoice →
              </button>
            )}
          </div>
        )}
        {canManage && job && (
          <button
            onClick={() => {
              if (window.confirm("Delete this job?")) {
                deleteJob(job.id);
                onClose();
              }
            }}
            className={dangerBtn()}
          >
            Delete
          </button>
        )}
        <button onClick={onClose} className={secondaryBtn()}>
          Cancel
        </button>
      </div>
      {job && <PriceChangeHistory job={job} />}
      {job && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Activity — every change to this job
          </p>
          <AuditList
            entries={state.auditLog.filter(
              (e) =>
                e.jobId === job.id ||
                (e.entity === "Job" && e.entityId === job.id),
            )}
            emptyText="No changes recorded yet. Every edit to this job — crew changes, status, value, linked estimate or invoice — will appear here with who made it and when."
          />
        </div>
      )}
      {addressPromptOpen && needsAddressChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <p className="text-base font-bold text-slate-900">
              ⚠ Check the address
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {`${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim()}{" "}
              has {addresses.length} addresses on file. Pick the one this
              job is at — the crew will navigate to it.
            </p>
            <div className="mt-3 space-y-2">
              {addresses.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    set({ addressId: a.id });
                    setAddressPromptOpen(false);
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm hover:border-emerald-500"
                >
                  <span className="font-semibold text-slate-900">
                    {a.label.trim() !== "" ? a.label : "Address"}
                    {a.isPrimary ? " (primary)" : ""}
                  </span>
                  <br />
                  <span className="text-slate-600">{addressLine(a)}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setAddressPromptOpen(false)}
              className={`${secondaryBtn()} mt-3`}
            >
              I&apos;ll pick it below
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
