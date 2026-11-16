import { useState } from "react";
import { useStore } from "../store";
import type { PhcProgram, PhcProgramType, PhcVisit } from "../types";
import { addDaysISO, fmtDate, isBlankCustomer, todayStr, uid } from "../utils";
import CustomerPicker from "./CustomerPicker";
import {
  MONTH_NAMES,
  PHC_SERVICES,
  STOCK_BADGE,
  STOCK_LABEL,
  buildPhcDraftEstimate,
  formatMonths,
  sameMonths,
  sheetMonthsFor,
  type PhcKind,
  type PhcService,
} from "../phcSchedule";
import { PhcBriefingModal } from "./PhcBriefing";
import {
  dangerBtn,
  inputCls,
  labelCls,
  primaryBtn,
  secondaryBtn,
} from "./ui";
import { TREE_FAMILIES, familiesForHosts } from "../treeFamilies";

/**
 * Plant Health Care: two tabs, modeled on Equipment.
 *
 * "Service catalog" — every PHC service they do, with the sheet's
 * information (treatment/product, months, target pest/disease) and the
 * science-corrected windows (reviewed fixes).
 * "Programs" — recurring care per customer/tree (EAB treatment,
 * fertilization, disease care) with a multi-visit schedule, chemical
 * application records for compliance, and a renewal date. Renewal
 * reminders are wired into Automations.
 */

function programStatus(
  program: PhcProgram,
  visits: PhcVisit[],
): "active" | "due" | "overdue" {
  if (program.status !== "active") return "active";
  const today = todayStr();
  const upcoming = visits
    .filter((v) => v.programId === program.id && v.status === "scheduled")
    .map((v) => v.date)
    .sort();
  if (upcoming.length === 0) return "active";
  const next = upcoming[0];
  if (next < today) return "overdue";
  if (next <= addDaysISO(today, 14)) return "due";
  return "active";
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  due: "bg-amber-100 text-amber-800",
  overdue: "bg-red-100 text-red-800",
  paused: "bg-slate-200 text-slate-700",
  completed: "bg-slate-200 text-slate-700",
};

function KindBadge({ service }: { service: PhcService }) {
  if (service.kind === "cultural")
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
        No chemical — cultural only
      </span>
    );
  if (service.kind === "service")
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
        Service — no spray
      </span>
    );
  return (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
      Treatment
    </span>
  );
}

/**
 * 12-month strip. Green = the science (accepted) window. Amber = the
 * sheet had that month but science corrected it away. Grey = neither.
 * The strip is what makes a wrong sheet month visible at a glance.
 */
function MonthStrip({ service }: { service: PhcService }) {
  const sheet = sheetMonthsFor(service.id);
  const short = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  return (
    <div>
      <div className="grid grid-cols-12 gap-0.5">
        {short.map((label, i) => {
          const m = i + 1;
          const inScience = service.months.includes(m);
          const inSheet = sheet.includes(m);
          return (
            <span
              key={m}
              title={MONTH_NAMES[i]}
              className={`rounded-sm py-1 text-center text-[10px] font-bold ${
                inScience
                  ? "bg-emerald-600 text-white"
                  : inSheet
                    ? "bg-amber-300 text-amber-900"
                    : "bg-slate-100 text-slate-400"
              }`}
            >
              {label}
            </span>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        <span className="font-semibold text-emerald-700">
          ■ Science window
        </span>
        {" · "}
        <span className="font-semibold text-amber-700">
          ■ Sheet had it — corrected
        </span>
        {" · "}
        <span>■ Not in season</span>
      </p>
    </div>
  );
}

function PhcCatalog() {
  const { state, canEdit, saveEstimate, openEstimate } = useStore();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("All groups");
  // Business rule: organized by the family of tree affected (default).
  const [organize, setOrganize] = useState<"family" | "pest">("family");
  const [family, setFamily] = useState("all");
  const [month, setMonth] = useState("all");
  const [kind, setKind] = useState<"all" | PhcKind>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  if (!state) return null;
  const nowMonth = new Date().getMonth() + 1;
  const groups = Array.from(new Set(PHC_SERVICES.map((s) => s.group)));
  const q = search.trim().toLowerCase();
  const filtered = PHC_SERVICES.filter((s) => {
    if (organize === "pest" && group !== "All groups" && s.group !== group) return false;
    if (organize === "family" && family !== "all" && !familiesForHosts(s.hosts).includes(family)) return false;
    if (kind !== "all" && s.kind !== kind) return false;
    if (month !== "all" && !s.months.includes(Number(month))) return false;
    if (q) {
      const hay =
        `${s.name} ${s.hosts} ${s.treatment} ${s.group} ${s.method}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const selected =
    PHC_SERVICES.find((s) => s.id === selectedId) ?? filtered[0] ?? null;
  const inSeason = PHC_SERVICES.filter((s) =>
    s.months.includes(nowMonth),
  ).length;
  const needSource = PHC_SERVICES.filter((s) => s.stock === "need").length;

  const quote = (s: PhcService) => {
    const firstCustomer =
      state.customers.find((c) => !isBlankCustomer(c)) ?? null;
    const estimate = buildPhcDraftEstimate(
      s,
      firstCustomer?.id ?? "",
      "PHC service catalog — price to be set.",
    );
    saveEstimate(estimate);
    openEstimate(estimate.id);
  };

  const sheet = selected ? sheetMonthsFor(selected.id) : [];
  const sheetNote = !selected
    ? null
    : sheet.length === 0
      ? "The sheet had no months for this one — timing is from the research."
      : !sameMonths(sheet, selected.months)
        ? `Sheet said ${formatMonths(sheet)} — corrected to the science window above.`
        : null;

  const renderCard = (s: PhcService) => {
            const isSel = selected?.id === s.id;
            const inSeasonNow = s.months.includes(nowMonth);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full rounded-xl border bg-white p-3 text-left shadow-sm ${
                    isSel
                      ? "border-emerald-600 ring-1 ring-emerald-600"
                      : "border-slate-200"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-slate-900">
                        {s.name}{" "}
                        <span className="font-medium text-slate-500">
                          · {s.hosts}
                        </span>
                      </p>
                      <p className="text-sm text-slate-600">
                        {formatMonths(s.months)}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STOCK_BADGE[s.stock]}`}
                    >
                      {STOCK_LABEL[s.stock]}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <KindBadge service={s} />
                    {inSeasonNow && (
                      <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                        In season now
                      </span>
                    )}
                    {s.doNotSell && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                        Don&apos;t sell routinely
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-slate-600">
          {PHC_SERVICES.length} services · {inSeason} in season in{" "}
          {MONTH_NAMES[nowMonth - 1]} · {needSource} need sourcing.
          Timings are the corrected science windows — where the sheet
          differed, the sheet&apos;s months are shown under each service.
        </p>
        <button
          onClick={() => setBriefingOpen(true)}
          className={secondaryBtn()}
        >
          🌿 This month&apos;s briefing
        </button>
      </div>
      {briefingOpen && (
        <PhcBriefingModal onClose={() => setBriefingOpen(false)} />
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input
          className={inputCls()}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search services, hosts, treatments…"
          aria-label="Search services"
        />
        {organize === "family" ? (
          <select
            className={inputCls()}
            value={family}
            onChange={(e) => setFamily(e.target.value)}
            aria-label="Filter by tree family"
          >
            <option value="all">All tree families</option>
            {TREE_FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
        <select
            className={inputCls()}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            aria-label="Filter by group"
          >
            <option value="All groups">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        <select
          className={inputCls()}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          aria-label="Filter by month"
        >
          <option value="all">All months</option>
          {MONTH_NAMES.map((n, i) => (
            <option key={n} value={i + 1}>
              {n}
            </option>
          ))}
        </select>
        <select
          className={inputCls()}
          value={kind}
          onChange={(e) => setKind(e.target.value as "all" | PhcKind)}
          aria-label="Filter by kind"
        >
          <option value="all">All kinds</option>
          <option value="chemical">Treatments</option>
          <option value="cultural">No chemical — cultural only</option>
          <option value="service">Services &amp; samples</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label="Organize by">
          {(
            [
              ["family", "By tree family"],
              ["pest", "By pest type"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setOrganize(v)}
              aria-pressed={organize === v}
              className={`rounded-md px-3 py-1 text-sm font-semibold ${organize === v ? "bg-emerald-700 text-white" : "text-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() =>
            setMonth(month === String(nowMonth) ? "all" : String(nowMonth))
          }
          className={`rounded-full px-3 py-1 text-sm font-semibold ${
            month === String(nowMonth)
              ? "bg-emerald-700 text-white"
              : "border border-slate-300 bg-white text-slate-700"
          }`}
        >
          This month
        </button>
        <span className="text-sm text-slate-500">
          Showing {filtered.length} of {PHC_SERVICES.length}
        </span>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ul className="space-y-2.5">
          {organize === "pest"
            ? filtered.map(renderCard)
            : TREE_FAMILIES.map((f) => {
                const list = filtered.filter((x) => familiesForHosts(x.hosts).includes(f.id));
                if (list.length === 0) return null;
                return (
                  <li key={f.id}>
                    <h3 className="mb-1.5 mt-2 text-sm font-bold text-slate-900">
                      {f.name}
                      {f.botanical && <span className="font-normal italic text-slate-500"> ({f.botanical})</span>}
                      <span className="block text-xs font-normal text-slate-500">
                        {f.trees} · {list.length} service{list.length === 1 ? "" : "s"}
                      </span>
                    </h3>
                    <ul className="space-y-2.5">{list.map(renderCard)}</ul>
                  </li>
                );
              })}
          {filtered.length === 0 && (
            <li className="text-sm text-slate-500">
              No services match — clear a filter.
            </li>
          )}
        </ul>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:sticky lg:top-4">
          {!selected ? (
            <p className="text-sm text-slate-500">
              Pick a service to see its treatment, timing, and stock.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    {selected.name}
                  </h2>
                  <p className="text-sm text-slate-600">
                    {selected.group} · {selected.hosts}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STOCK_BADGE[selected.stock]}`}
                >
                  {STOCK_LABEL[selected.stock]}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <KindBadge service={selected} />
                {selected.doNotSell && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                    Don&apos;t sell routinely
                  </span>
                )}
              </div>
              {selected.kind === "cultural" && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">
                  No effective chemical treatment — cultural / sanitation
                  only. Quote the pruning or assessment work, not a spray.
                </p>
              )}
              <div className="mt-3 space-y-2 text-sm">
                <p>
                  <span className="font-semibold text-slate-900">
                    Treatment:{" "}
                  </span>
                  <span className="text-slate-700">
                    {selected.treatment}
                  </span>
                </p>
                <p>
                  <span className="font-semibold text-slate-900">
                    How:{" "}
                  </span>
                  <span className="text-slate-700">{selected.method}</span>
                </p>
              </div>
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  When — science window
                </p>
                <MonthStrip service={selected} />
                <p className="mt-1 text-sm text-slate-700">
                  In season: {formatMonths(selected.months)}
                </p>
                {sheetNote && (
                  <p className="mt-1 text-xs text-slate-500">{sheetNote}</p>
                )}
              </div>
              {selected.note && (
                <p className="mt-3 text-sm font-medium text-amber-700">
                  {selected.note}
                </p>
              )}
              {selected.doNotSell ? (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
                  Don&apos;t quote this as a routine service.
                </p>
              ) : canEdit ? (
                <button
                  onClick={() => quote(selected)}
                  className={`${primaryBtn()} mt-3`}
                >
                  Quote it →
                </button>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function PhcPrograms() {
  const {
    state,
    canEdit,
    savePhcProgram,
    deletePhcProgram,
    savePhcVisit,
    saveChemicalRecord,
    deleteChemicalRecord,
    openCustomer,
  } = useStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newCustomerId, setNewCustomerId] = useState("");
  const [newTreeId, setNewTreeId] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<PhcProgramType>("EAB treatment");
  const [newStart, setNewStart] = useState(todayStr());
  const [newRenewal, setNewRenewal] = useState(addDaysISO(todayStr(), 180));
  const [newInterval, setNewInterval] = useState(6);
  // Chemical record draft (per expanded program).
  const [chemProduct, setChemProduct] = useState("");
  const [chemRate, setChemRate] = useState("");
  const [chemDate, setChemDate] = useState(todayStr());
  const [chemApplicator, setChemApplicator] = useState("");
  const [chemNotes, setChemNotes] = useState("");

  if (!state) return null;
  const today = todayStr();
  const customerName = (id: string) => {
    const c = state.customers.find((x) => x.id === id);
    return c ? `${c.firstName} ${c.lastName}` : "Unknown customer";
  };
  const treeLabel = (id: string | null) => {
    if (!id) return "Whole property";
    const t = state.trees.find((x) => x.id === id);
    return t ? `${t.label} — ${t.species}` : "Tree";
  };

  const programs = [...state.phcPrograms].sort((a, b) =>
    (a.renewalDate ?? "").localeCompare(b.renewalDate ?? ""),
  );

  const createProgram = () => {
    if (!newCustomerId || newName.trim() === "") return;
    const program: PhcProgram = {
      id: uid(),
      customerId: newCustomerId,
      treeId: newTreeId || null,
      name: newName.trim(),
      type: newType,
      status: "active",
      startDate: newStart,
      renewalDate: newRenewal || null,
      visitIntervalMonths: newInterval,
      notes: "",
    };
    savePhcProgram(program);
    // First visit on the start date, so the schedule is never empty.
    savePhcVisit({
      id: uid(),
      programId: program.id,
      date: newStart,
      status: "scheduled",
      notes: "First visit of the program.",
    });
    setShowNew(false);
    setNewName("");
    setNewTreeId("");
    setExpandedId(program.id);
  };

  const addChemicalRecord = (programId: string) => {
    if (chemProduct.trim() === "") return;
    saveChemicalRecord({
      id: uid(),
      programId,
      date: chemDate,
      product: chemProduct.trim(),
      rate: chemRate.trim(),
      applicator: chemApplicator.trim(),
      notes: chemNotes.trim(),
    });
    setChemProduct("");
    setChemRate("");
    setChemApplicator("");
    setChemNotes("");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-slate-600">
          Recurring care programs — EAB treatment, fertilization,
          disease care — with visit schedules, chemical records, and
          renewal dates. Renewal reminders run through Automations.
        </p>
        {canEdit && (
          <button onClick={() => setShowNew(!showNew)} className={primaryBtn()}>
            {showNew ? "Cancel" : "+ New program"}
          </button>
        )}
      </div>

      {showNew && canEdit && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-base font-bold text-slate-900">
            New PHC program
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls()}>Customer</label>
              <CustomerPicker
                value={newCustomerId}
                placeholder="Choose a customer…"
                onChange={(id) => {
                  setNewCustomerId(id);
                  setNewTreeId("");
                }}
              />
            </div>
            <div>
              <label className={labelCls()}>Tree (optional)</label>
              <select
                className={inputCls()}
                value={newTreeId}
                onChange={(e) => setNewTreeId(e.target.value)}
              >
                <option value="">Whole property</option>
                {state.trees
                  .filter((t) => t.customerId === newCustomerId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} — {t.species}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className={labelCls()}>Program name</label>
              <input
                className={inputCls()}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. EAB treatment — front ash"
              />
            </div>
            <div>
              <label className={labelCls()}>Type</label>
              <select
                className={inputCls()}
                value={newType}
                onChange={(e) =>
                  setNewType(e.target.value as PhcProgramType)
                }
              >
                <option value="EAB treatment">EAB treatment</option>
                <option value="Fertilization">Fertilization</option>
                <option value="Disease care">Disease care</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className={labelCls()}>Start date</label>
              <input
                type="date"
                className={inputCls()}
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls()}>Renewal date</label>
              <input
                type="date"
                className={inputCls()}
                value={newRenewal}
                onChange={(e) => setNewRenewal(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls()}>Visit every (months)</label>
              <input
                type="number"
                min={1}
                max={12}
                className={inputCls()}
                value={newInterval}
                onChange={(e) => setNewInterval(Number(e.target.value))}
              />
            </div>
          </div>
          <button
            onClick={createProgram}
            disabled={!newCustomerId || newName.trim() === ""}
            className={`${primaryBtn()} mt-3`}
          >
            Create program
          </button>
        </section>
      )}

      {programs.length === 0 ? (
        <p className="text-sm text-slate-500">
          No PHC programs yet — create one for a customer above.
        </p>
      ) : (
        <div className="space-y-3">
          {programs.map((p) => {
            const visits = state.phcVisits
              .filter((v) => v.programId === p.id)
              .sort((a, b) => a.date.localeCompare(b.date));
            const records = state.chemicalRecords
              .filter((r) => r.programId === p.id)
              .sort((a, b) => b.date.localeCompare(a.date));
            const status = programStatus(p, visits);
            const expanded = expandedId === p.id;
            const nextVisit = visits.find(
              (v) => v.status === "scheduled" && v.date >= today,
            );
            return (
              <section
                key={p.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <button
                      onClick={() => setExpandedId(expanded ? null : p.id)}
                      className="text-left text-base font-bold text-slate-900 hover:text-emerald-700 hover:underline"
                    >
                      {p.name}
                    </button>
                    <p className="text-sm text-slate-600">
                      <button
                        onClick={() => openCustomer(p.customerId)}
                        className="font-semibold text-emerald-700 underline"
                      >
                        {customerName(p.customerId)}
                      </button>{" "}
                      · {treeLabel(p.treeId)} · {p.type}
                    </p>
                    <p className="text-sm text-slate-500">
                      Renews {p.renewalDate ? fmtDate(p.renewalDate) : "—"}
                      {nextVisit
                        ? ` · Next visit ${fmtDate(nextVisit.date)}`
                        : " · No upcoming visit"}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[status]}`}
                  >
                    {p.status === "active"
                      ? status === "active"
                        ? "Active"
                        : status === "due"
                          ? "Due soon"
                          : "Overdue"
                      : p.status}
                  </span>
                </div>

                {expanded && (
                  <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Visit schedule
                      </p>
                      {visits.length === 0 ? (
                        <p className="text-sm text-slate-500">
                          No visits scheduled.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {visits.map((v) => (
                            <li
                              key={v.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                            >
                              <span>
                                {fmtDate(v.date)} — {v.status}
                                {v.notes ? ` · ${v.notes}` : ""}
                              </span>
                              {canEdit && v.status === "scheduled" && (
                                <button
                                  onClick={() =>
                                    savePhcVisit({ ...v, status: "done" })
                                  }
                                  className="font-semibold text-emerald-700 underline"
                                >
                                  Mark done
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {canEdit && (
                        <button
                          onClick={() => {
                            const last =
                              visits.length > 0
                                ? visits[visits.length - 1].date
                                : p.startDate;
                            savePhcVisit({
                              id: uid(),
                              programId: p.id,
                              date: addDaysISO(
                                last,
                                p.visitIntervalMonths * 30,
                              ),
                              status: "scheduled",
                              notes: "",
                            });
                          }}
                          className={`${secondaryBtn()} mt-2`}
                        >
                          + Schedule next visit
                        </button>
                      )}
                    </div>

                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Chemical application records
                      </p>
                      {records.length === 0 ? (
                        <p className="text-sm text-slate-500">
                          No applications recorded yet.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {records.map((r) => (
                            <li
                              key={r.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                            >
                              <span>
                                {fmtDate(r.date)} — {r.product} · {r.rate}
                                {r.applicator
                                  ? ` · applied by ${r.applicator}`
                                  : ""}
                                {r.notes ? ` · ${r.notes}` : ""}
                              </span>
                              {canEdit && (
                                <button
                                  onClick={() => deleteChemicalRecord(r.id)}
                                  className="font-semibold text-red-700 underline"
                                >
                                  Remove
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {canEdit && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input
                            className={inputCls()}
                            value={chemProduct}
                            onChange={(e) => setChemProduct(e.target.value)}
                            placeholder="Product, e.g. Tree-äge"
                          />
                          <input
                            className={inputCls()}
                            value={chemRate}
                            onChange={(e) => setChemRate(e.target.value)}
                            placeholder="Rate, e.g. 4 ml per inch DBH"
                          />
                          <input
                            type="date"
                            className={inputCls()}
                            value={chemDate}
                            onChange={(e) => setChemDate(e.target.value)}
                          />
                          <input
                            className={inputCls()}
                            value={chemApplicator}
                            onChange={(e) => setChemApplicator(e.target.value)}
                            placeholder="Applicator"
                          />
                          <input
                            className={`${inputCls()} sm:col-span-2`}
                            value={chemNotes}
                            onChange={(e) => setChemNotes(e.target.value)}
                            placeholder="Notes (optional)"
                          />
                          <button
                            onClick={() => addChemicalRecord(p.id)}
                            disabled={chemProduct.trim() === ""}
                            className={`${secondaryBtn()} sm:col-span-2`}
                          >
                            + Record application
                          </button>
                        </div>
                      )}
                    </div>

                    {canEdit && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() =>
                            savePhcProgram({
                              ...p,
                              status:
                                p.status === "active" ? "paused" : "active",
                            })
                          }
                          className={secondaryBtn()}
                        >
                          {p.status === "active"
                            ? "Pause program"
                            : "Resume program"}
                        </button>
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete the program “${p.name}”? Its visits and chemical records go with it.`,
                              )
                            ) {
                              deletePhcProgram(p.id);
                            }
                          }}
                          className={dangerBtn()}
                        >
                          Delete program
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Phc() {
  const [tab, setTab] = useState<"catalog" | "programs">("catalog");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Plant Health Care
          </h1>
          <p className="text-sm text-slate-600">
            Every treatment we do — the service catalog with
            science-corrected timing — plus recurring care programs with
            visit schedules, chemical records, and renewal dates.
          </p>
        </div>
        <div className="flex gap-2">
          {(["catalog", "programs"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-3 py-1 text-sm font-semibold ${
                tab === t
                  ? "bg-emerald-700 text-white"
                  : "border border-slate-300 bg-white text-slate-700"
              }`}
            >
              {t === "catalog" ? "Service catalog" : "Programs"}
            </button>
          ))}
        </div>
      </div>
      {tab === "catalog" ? <PhcCatalog /> : <PhcPrograms />}
    </div>
  );
}
