import { useState } from "react";
import { useStore } from "../store";
import type { Job, Tree } from "../types";
import NavigateButton from "./NavigateButton";
import { fmtDate, money, todayStr } from "../utils";
import {
  findSpeciesGuide,
  formatMonths,
  monthName,
  pruneClassById,
  pruneVerdict,
} from "../treeGuide";
import { jobAddress } from "../scheduling";
import { telHref } from "../customerSearch";
import { SpeciesPhoto } from "./FieldGuide";
import { arrivalLabel, whereLine } from "../fieldDay";
import { useCrewPrices, type PriceLine } from "../crewPrices";
import { jobValue, replacedJobPrice } from "../jobValue";
import { climberNewPrice } from "../priceChange";
import { OldPrice } from "./JobPriceChanges";

/**
 * The crew's read-only job sheet: what they need on site, nothing from
 * the office form (billing, value, change log). Shown from Today (full
 * screen) and, for crew logins, whenever a job is opened anywhere else
 * (Schedule, Dashboard…) in the side panel. Climbers (and anyone else
 * allowed to edit jobs) get a small "Edit" link to the office form.
 */

/** Big tap targets for the crew phone (44 px minimum). */
export const bigBtn =
  "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-base font-bold";
export const bigPrimary = `${bigBtn} bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-60`;
export const bigSecondary = `${bigBtn} border-2 border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-60`;

const CHECKLIST = [
  "Arrive & check in with the customer",
  "Walk the site before starting",
  "Safety check — gear, lines, drop zone",
  "Work complete",
  "Cleanup done",
  "Photos taken",
];

const CHECK_KEY = "treeapp:crew-checklist:v1";

function loadChecks(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(CHECK_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

/** This phone's checklist ticks for one job today (kept in localStorage). */
function useChecklist(jobId: string): [string[], (item: string) => void] {
  const key = `${jobId}:${todayStr()}`;
  const [checks, setChecks] = useState<string[]>(() => loadChecks()[key] ?? []);
  const toggle = (item: string) => {
    const next = checks.includes(item) ? checks.filter((x) => x !== item) : [...checks, item];
    setChecks(next);
    try {
      localStorage.setItem(CHECK_KEY, JSON.stringify({ ...loadChecks(), [key]: next }));
    } catch {
      // Checklist loss is acceptable.
    }
  };
  return [checks, toggle];
}

/**
 * Field guide for one job on the day briefing: the trees on this job,
 * whether today is the right time to prune them, what the prune class
 * means, and what diseases to look for — all from the in-app guide,
 * nothing pulled from another page. A wrong-time verdict is a loud red
 * banner, not a footnote: the whole crew needs to see it before they
 * start cutting.
 */
function JobFieldGuide({ job, trees }: { job: Job; trees: Tree[] }) {
  const [openTreeId, setOpenTreeId] = useState<string | null>(null);
  if (trees.length === 0) return null;
  const month = new Date().getMonth() + 1;
  const isPruneJob = job.serviceType === "Trimming";
  const entries = trees.map((t) => ({
    tree: t,
    guide: findSpeciesGuide(t.species),
  }));
  const withGuide = entries.filter(
    (e): e is { tree: Tree; guide: NonNullable<typeof e.guide> } =>
      e.guide !== null,
  );
  const wrong = withGuide.filter(
    (e) =>
      isPruneJob && pruneVerdict(e.guide, month).verdict === "wrong",
  );
  const pruneClass = job.pruneClass
    ? pruneClassById(job.pruneClass)
    : undefined;
  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-emerald-900">
        📖 Field guide
      </p>
      {wrong.length > 0 && (
        <div className="mt-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-bold text-white">
          ⚠ Wrong time to prune:{" "}
          {wrong.map((e) => e.guide.name).join(", ")} — {monthName(month)}{" "}
          is in the avoid window. Best:{" "}
          {wrong.map((e) => formatMonths(e.guide.bestMonths)).join("; ")}.
        </div>
      )}
      {pruneClass && (
        <div className="mt-2 rounded-lg bg-white px-3 py-2 text-sm text-slate-800">
          <p className="font-bold">{pruneClass.name}</p>
          <p className="mt-0.5 text-slate-600">{pruneClass.definition}</p>
        </div>
      )}
      <ul className="mt-2 space-y-2">
        {entries.map(({ tree, guide }) => {
          if (!guide) {
            return (
              <li
                key={tree.id}
                className="rounded-lg bg-white px-3 py-2 text-sm text-slate-600"
              >
                {tree.label}
                {tree.species ? ` — ${tree.species}` : ""}: no guide entry
                yet — ask the office to add it.
              </li>
            );
          }
          const verdict = isPruneJob
            ? pruneVerdict(guide, month)
            : null;
          const expanded = openTreeId === tree.id;
          return (
            <li
              key={tree.id}
              className="overflow-hidden rounded-lg bg-white"
            >
              <button
                onClick={() =>
                  setOpenTreeId(expanded ? null : tree.id)
                }
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="text-sm font-semibold text-slate-900">
                  {tree.label} — {guide.name}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {verdict && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                        verdict.verdict === "wrong"
                          ? "bg-red-100 text-red-800"
                          : verdict.verdict === "good"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {verdict.verdict === "wrong"
                        ? "⚠ Wrong time"
                        : verdict.verdict === "good"
                          ? "✓ Good window"
                          : "· OK window"}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {expanded ? "▾" : "▸"}
                  </span>
                </span>
              </button>
              {expanded && (
                <div className="border-t border-slate-100 px-3 py-2 text-sm text-slate-700">
                  <div className="flex items-start gap-3">
                    <SpeciesPhoto guide={guide} size="sm" />
                    <div className="min-w-0 flex-1">
                      {verdict && (
                        <p className="text-slate-600">
                          <span className="font-semibold">
                            Pruning {monthName(month)}:{" "}
                          </span>
                          {verdict.note} Best:{" "}
                          {formatMonths(guide.bestMonths)}. Avoid:{" "}
                          {formatMonths(guide.avoidMonths)}.
                        </p>
                      )}
                      <p className="mt-2 font-semibold text-slate-900">
                        Know this tree
                      </p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-slate-600">
                        {guide.biology.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {job.pruneClass === "2" && (
                    <p className="mt-2 text-slate-600">
                      <span className="font-semibold text-slate-900">
                        Class II on a {guide.name.toLowerCase()}:{" "}
                      </span>
                      {guide.classNote}
                    </p>
                  )}
                  <p className="mt-2 font-semibold text-slate-900">
                    How to cut it
                  </p>
                  <p className="text-slate-600">{guide.cutNotes}</p>
                  <p className="mt-2 font-semibold text-slate-900">
                    Diseases to look for
                  </p>
                  <ul className="mt-0.5 space-y-1.5">
                    {guide.diseases.map((d) => (
                      <li key={d.name}>
                        <span className="font-semibold">{d.name} — </span>
                        <span className="text-slate-600">
                          {d.signs}{" "}
                        </span>
                        <span className="text-slate-600">
                          <span className="font-semibold">Do: </span>
                          {d.action}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The parts of the job and their prices (Climbers only). When a Climber
 * changed the job's price (`newPrice`), the estimate's prices stay
 * visible but struck through, and the new price is what counts (business rule).
 */
export function PriceList({ lines, newPrice = null }: { lines: PriceLine[]; newPrice?: string | null }) {
  if (lines.length === 0) return null;
  const old = newPrice !== null;
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm font-bold uppercase tracking-wide text-slate-600">The job and its price</p>
      <ul className="mt-1 space-y-1">
        {lines.map((l, i) => (
          <li
            key={`${l.lineId}-${i}`}
            className={`flex justify-between gap-3 text-base ${old ? "text-slate-400 line-through" : "text-slate-900"}`}
          >
            <span>{l.description || "Work"}</span>
            <span className="shrink-0 font-semibold">{money(l.price)}</span>
          </li>
        ))}
      </ul>
      {old && (
        <p className="mt-1 text-base font-semibold text-slate-900" data-testid="new-price">
          New price: {newPrice}
        </p>
      )}
    </div>
  );
}

/**
 * The sheet's content. `onEdit`, when given, adds a small "Edit this job"
 * link at the bottom (crew who may edit jobs).
 */
export function JobSheetBody({
  job,
  mine,
  onEdit,
}: {
  job: Job;
  mine: boolean;
  onEdit?: () => void;
}) {
  const { state, viewerId, showMoney } = useStore();
  const isClimber = state?.crew.find((c) => c.id === viewerId)?.role === "Climber";
  const prices = useCrewPrices(isClimber).get(job.id) ?? [];
  const [checks, toggleCheck] = useChecklist(job.id);
  if (!state) return null;
  const customer = state.customers.find((c) => c.id === job.customerId) ?? null;
  const address = jobAddress(state, job) ?? "";
  const when = arrivalLabel(job, viewerId);
  const crew = job.crewIds
    .map((id) => state.crew.find((c) => c.id === id)?.name)
    .filter(Boolean);
  const equipment = (job.equipmentIds ?? [])
    .map((id) => {
      const e = state.equipment.find((x) => x.id === id);
      if (!e) return null;
      const driverId = (job.equipmentDrivers ?? {})[id];
      const driver = driverId
        ? driverId === viewerId
          ? "you"
          : (state.crew.find((c) => c.id === driverId)?.name ?? null)
        : null;
      return { id, name: e.name, driver };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  const trees = (job.treeIds ?? [])
    .map((id) => state.trees.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const hazards = trees.filter(
    (t) => t.riskRating === "High" || t.riskRating === "Moderate" || t.riskNotes.trim() !== "",
  );
  const pruneClass = job.pruneClass ? pruneClassById(job.pruneClass) : undefined;
  const section = "rounded-xl border border-slate-200 bg-white p-4";
  const heading = "text-sm font-bold uppercase tracking-wide text-slate-600";
  return (
    <div className="space-y-3">
      <div>
        <p className={heading}>Job sheet · {fmtDate(job.date)}</p>
        <h2 className="text-2xl font-bold text-slate-900">{job.title}</h2>
        <p className="text-base text-slate-700">
          {when.main}
          {when.sub ? ` (${when.sub})` : ""} · {job.serviceType}
        </p>
      </div>

      <section className={section}>
        <p className={heading}>Where</p>
        <p className="text-base font-semibold text-slate-900">
          {customer ? `${customer.firstName} ${customer.lastName}` : "Customer"}
        </p>
        {customer?.phone && /\d/.test(customer.phone) && (
          <a href={telHref(customer.phone)} className="mt-1 inline-block text-base font-semibold text-emerald-800 underline">
            📞 Call {customer.firstName || "the customer"} · {customer.phone}
          </a>
        )}
        <p className="text-base text-slate-800">{whereLine(address, job)}</p>
        {customer?.type === "commercial" && (customer.companyName || customer.poNumber) && (
          <p className="text-base text-slate-700">
            {customer.companyName}
            {customer.poNumber ? ` · PO ${customer.poNumber}` : ""}
          </p>
        )}
        <div className="mt-3">
          <NavigateButton
            destination={{ lat: job.lat, lng: job.lng, address: address || null }}
            assigned={mine}
            className={`${bigPrimary} w-full`}
          />
        </div>
      </section>

      <section className={section}>
        <p className={heading}>Gate and access</p>
        {customer?.gateCode ? (
          <p className="text-lg font-bold text-slate-900">Gate code: {customer.gateCode}</p>
        ) : (
          <p className="text-base text-slate-700">No gate code.</p>
        )}
        {customer?.propertyNotes && (
          <p className="mt-1 whitespace-pre-wrap text-base text-slate-800">{customer.propertyNotes}</p>
        )}
      </section>

      <section className={`${section} ${hazards.length > 0 ? "border-red-300 bg-red-50" : ""}`}>
        <p className={heading}>Hazards</p>
        {hazards.length === 0 ? (
          <p className="text-base text-slate-700">None noted. Walk the site before you start.</p>
        ) : (
          <ul className="space-y-1">
            {hazards.map((t) => (
              <li key={t.id} className="text-base text-red-900">
                <span className="font-bold">
                  ⚠ {t.label}
                  {t.species ? ` (${t.species})` : ""}
                  {t.riskRating ? ` · ${t.riskRating} risk` : ""}
                </span>
                {t.riskNotes ? ` — ${t.riskNotes}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(job.teamNotes || job.notes || job.customerNotes) && (
        <section className={section}>
          <p className={heading}>Notes</p>
          {job.teamNotes && (
            <p className="whitespace-pre-wrap text-base text-slate-900">
              <span className="font-bold">Team: </span>
              {job.teamNotes}
            </p>
          )}
          {job.notes && (
            <p className="mt-1 whitespace-pre-wrap text-base text-slate-900">
              <span className="font-bold">Job: </span>
              {job.notes}
            </p>
          )}
          {job.customerNotes && (
            <p className="mt-1 whitespace-pre-wrap text-base text-slate-900">
              <span className="font-bold">For the customer: </span>
              {job.customerNotes}
            </p>
          )}
        </section>
      )}

      <section className={section}>
        <p className={heading}>The work</p>
        <p className="text-base text-slate-900">{job.serviceType}</p>
        {pruneClass && <p className="text-base text-slate-800">{pruneClass.name}</p>}
        {trees.length > 0 && (
          <p className="text-base text-slate-800">
            Trees: {trees.map((t) => `${t.label}${t.species ? ` (${t.species})` : ""}`).join(", ")}
          </p>
        )}
        {job.estimatedHours !== null && job.estimatedHours !== undefined && (
          <p className="text-base text-slate-800">About {job.estimatedHours} hours on site</p>
        )}
        {/* People who may see money (a Sales login, crew with "see
            money") get the job's value; the database blanks it for
            everyone else (app_jobs). */}
        {showMoney && prices.length === 0 && jobValue(state, job) !== null && (
          <p className="mt-1 text-base font-semibold text-slate-900">
            Job value: <OldPrice amount={replacedJobPrice(state, job)} />
            {money(jobValue(state, job) ?? 0)}
          </p>
        )}
        <PriceList lines={prices} newPrice={climberNewPrice(job)} />
        <JobFieldGuide job={job} trees={trees} />
      </section>

      <section className={section}>
        <p className={heading}>Crew and equipment</p>
        <p className="text-base text-slate-900">
          {crew.length > 0 ? crew.join(", ") : "No one assigned yet"}
        </p>
        {equipment.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {equipment.map((e) => (
              <li key={e.id} className="text-base text-slate-800">
                <span className="font-semibold">{e.name}</span>
                {e.driver ? ` — ${e.driver === "you" ? "you drive" : `${e.driver} drives`}` : " — no driver set"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base text-slate-700">No equipment listed.</p>
        )}
        <p className="mt-2 text-sm text-slate-600">
          Need something else? Check with the office before you leave the shop.
        </p>
      </section>

      <section className={section}>
        <p className={heading}>Checklist (this phone only)</p>
        <ul className="mt-1 divide-y divide-slate-100">
          {CHECKLIST.map((item) => (
            <li key={item}>
              <label className="flex min-h-12 cursor-pointer items-center gap-3 text-base text-slate-900">
                <input
                  type="checkbox"
                  checked={checks.includes(item)}
                  onChange={() => toggleCheck(item)}
                  className="h-6 w-6 accent-emerald-700"
                />
                <span className={checks.includes(item) ? "text-slate-500 line-through" : ""}>{item}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="min-h-11 w-full text-base font-semibold text-emerald-800 underline"
        >
          Edit this job (office form)
        </button>
      )}
    </div>
  );
}

/** Today's full-screen job sheet, with a big Close. */
export default function JobSheet({
  job,
  mine,
  onClose,
}: {
  job: Job;
  mine: boolean;
  onClose: () => void;
}) {
  const { canEditJobs, openJob } = useStore();
  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label={`Job sheet: ${job.title}`}
    >
      <div className="mx-auto max-w-md px-4 pb-28 pt-4">
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={onClose} className={bigSecondary}>
            Close
          </button>
        </div>
        <JobSheetBody
          job={job}
          mine={mine}
          onEdit={
            canEditJobs
              ? () => {
                  onClose();
                  openJob(job.id, { edit: true });
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}
