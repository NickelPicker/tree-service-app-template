import { useMemo } from "react";
import { useStore } from "../store";
import { isBlankCustomer } from "../utils";
import {
  MONTH_NAMES,
  STOCK_BADGE,
  STOCK_LABEL,
  buildPhcDraftEstimate,
  formatMonths,
  phcServicesForMonth,
  type PhcService,
} from "../phcSchedule";
import { primaryBtn, secondaryBtn } from "./ui";

/**
 * The PHC morning briefing for the Sales page (the estimator).
 *
 * Every morning, the first time the Sales page is opened, a pop-up lists
 * the pests and services whose accepted (science) treatment window
 * includes the current month — so the estimator remembers what to quote. The same
 * briefing stays available from a banner on the Sales page.
 *
 * Each item has a "Quote it" button that starts a draft estimate with
 * the treatment as a line item (price $0 — the estimator prices it) and opens it
 * in the estimate editor, where the customer can be picked or added
 * inline. Cultural-only items quote the pruning / assessment work
 * instead of a spray.
 */

export function usePhcBriefingMonth() {
  const now = new Date();
  return useMemo(
    () => ({
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      services: phcServicesForMonth(now.getMonth() + 1),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

function StockBadge({ stock }: { stock: PhcService["stock"] }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STOCK_BADGE[stock]}`}
    >
      {STOCK_LABEL[stock]}
    </span>
  );
}

function BriefingItem({
  service,
  onQuote,
}: {
  service: PhcService;
  onQuote: (s: PhcService) => void;
}) {
  const quotable = !service.doNotSell;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">
            {service.name}{" "}
            <span className="font-normal text-slate-500">
              — {service.hosts}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-slate-700">{service.treatment}</p>
          <p className="text-xs text-slate-500">
            {service.method} · {formatMonths(service.months)}
          </p>
          {service.note && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              {service.note}
            </p>
          )}
        </div>
        <StockBadge stock={service.stock} />
      </div>
      {quotable ? (
        <button
          onClick={() => onQuote(service)}
          className={`${secondaryBtn()} mt-2`}
        >
          Quote it →
        </button>
      ) : (
        <p className="mt-2 text-xs font-semibold text-red-700">
          Don&apos;t quote this as a routine service.
        </p>
      )}
    </li>
  );
}

export function PhcBriefingContent({
  month,
  year,
  onQuote,
}: {
  month: number;
  year: number;
  onQuote: (s: PhcService) => void;
}) {
  const services = phcServicesForMonth(month);
  const treat = services.filter(
    (s) => s.kind === "chemical" && !s.doNotSell,
  );
  const cultural = services.filter((s) => s.kind === "cultural");
  const other = services.filter(
    (s) => s.kind === "service" && !s.doNotSell,
  );
  const dontSell = services.filter((s) => s.doNotSell);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">
          🌿 {MONTH_NAMES[month - 1]} {year} — PHC treatments in season
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {treat.length} treatment{treat.length === 1 ? "" : "s"} to quote
          this month, using the corrected science timings. Phenology
          (bud break, bloom, flight) governs over the calendar — a warm or
          cold spring shifts windows by a week or two.
        </p>
      </div>

      {treat.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-emerald-800">
            Treat this month
          </h3>
          <ul className="space-y-2">
            {treat.map((s) => (
              <BriefingItem key={s.id} service={s} onQuote={onQuote} />
            ))}
          </ul>
        </section>
      )}

      {cultural.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-700">
            No spray — prune / assess only
          </h3>
          <p className="mb-2 text-xs text-slate-500">
            No chemical treatment exists for these. Quote the pruning or
            assessment work, not a spray.
          </p>
          <ul className="space-y-2">
            {cultural.map((s) => (
              <BriefingItem key={s.id} service={s} onQuote={onQuote} />
            ))}
          </ul>
        </section>
      )}

      {other.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-700">
            Services &amp; samples due
          </h3>
          <ul className="space-y-2">
            {other.map((s) => (
              <BriefingItem key={s.id} service={s} onQuote={onQuote} />
            ))}
          </ul>
        </section>
      )}

      {dontSell.length > 0 && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-3">
          <h3 className="text-sm font-bold text-red-800">
            Don&apos;t sell this month
          </h3>
          <ul className="mt-2 space-y-2">
            {dontSell.map((s) => (
              <BriefingItem key={s.id} service={s} onQuote={onQuote} />
            ))}
          </ul>
        </section>
      )}

      {services.length === 0 && (
        <p className="text-sm text-slate-600">
          Nothing is in season this month.
        </p>
      )}
    </div>
  );
}

/** Local-storage key marking the briefing as shown for a given day. */
export function briefingKeyFor(dateStr: string) {
  return `phc-briefing-${dateStr}`;
}

export function PhcBriefingModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const { state, saveEstimate, openEstimate } = useStore();
  const { month, year } = usePhcBriefingMonth();

  const quote = (s: PhcService) => {
    const firstCustomer =
      state?.customers.find((c) => !isBlankCustomer(c)) ?? null;
    const estimate = buildPhcDraftEstimate(
      s,
      firstCustomer?.id ?? "",
      `PHC ${MONTH_NAMES[month - 1]} briefing — price to be set.`,
    );
    saveEstimate(estimate);
    onClose();
    openEstimate(estimate.id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-2xl rounded-2xl bg-slate-50 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Good morning — today&apos;s PHC briefing
          </p>
          <button
            onClick={onClose}
            className={secondaryBtn()}
            aria-label="Close briefing"
          >
            ✕ Close
          </button>
        </div>
        <PhcBriefingContent month={month} year={year} onQuote={quote} />
        <button onClick={onClose} className={`${primaryBtn()} mt-4 w-full`}>
          Got it — I&apos;ll quote these today
        </button>
      </div>
    </div>
  );
}
