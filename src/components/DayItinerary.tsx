import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Job } from "../types";
import { compareByWorkOrder, jobAddress as sharedJobAddress } from "../scheduling";
import { JobStatusButtons } from "./LiveProgress";
import { StatusBadge } from "./ui";
import {
  formatMiles,
  formatMinutes,
  resolveJobCoords,
  routeLeg,
  type LegResult,
} from "../routing";

/**
 * Day itinerary: a day's jobs in start-time order, numbered, each
 * with its address and crew — plus the drive leg from the previous
 * stop (OSRM driving distance/time, straight-line when OSRM is
 * unreachable, unknown when a stop has no location) and a Google
 * Maps directions link for the whole route. The leg pattern is the
 * same as RouteView on the Schedule page; this is the compact,
 * phone-first version shared by the Today "My day" view and the
 * per-crew itineraries on Today + Schedule.
 *
 * showStatus adds live progress to each stop (StatusBadge plus
 * Arrived / Done buttons for viewers who may tap that job) — the
 * printable run sheet leaves it off so the sheet stays a clean
 * snapshot. Done stops stay visible, dimmed, so the office can see
 * what is finished and what is left.
 *
 * useRouteLegs / formatLegText are the shared route derivation:
 * the printable run sheet uses them too, so the sheet and the
 * screen always agree on stop order and drive legs — never two
 * different route calculations.
 */

/** Stops in start-time order, plus the drive leg between each pair. */
export function useRouteLegs(
  jobs: Job[],
  /** Keep the order given (the crew screen's own route order) instead of start time. */
  preserveOrder = false,
): {
  ordered: Job[];
  legs: Array<LegResult | "loading">;
} {
  const { state } = useStore();
  // Results are kept with the stops they were computed for. A render
  // with a different list of stops (a job added, the day changed) shows
  // "Calculating drive…" for every leg until its own results arrive,
  // never another list's legs (that crashed the page when a day gained
  // a stop: there was no leg for the new one yet).
  const [computed, setComputed] = useState<{
    key: string;
    legs: LegResult[];
  } | null>(null);
  const ordered = preserveOrder
    ? [...jobs]
    : [...jobs].sort(compareByWorkOrder);
  const dayKey = ordered.map((j) => j.id).join(",");
  const jobAddress = (j: Job): string | null =>
    state ? sharedJobAddress(state, j) : null;
  const loadKey = `${dayKey}|${state === null}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const coords = await Promise.all(
        ordered.map((j) => resolveJobCoords(j, jobAddress(j))),
      );
      if (cancelled) return;
      const results: LegResult[] = [];
      for (let i = 0; i < ordered.length - 1; i++) {
        const from = coords[i];
        const to = coords[i + 1];
        results.push(
          from && to ? await routeLeg(from, to) : { status: "unknown" },
        );
        if (cancelled) return;
      }
      if (!cancelled) setComputed({ key: loadKey, legs: results });
    })();
    return () => {
      cancelled = true;
    };
    // Recompute when the stops change, or when the store finishes
    // loading. jobAddress reads state, so the boolean dep covers
    // the null -> loaded transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const legs: Array<LegResult | "loading"> =
    computed && computed.key === loadKey
      ? computed.legs
      : ordered.slice(1).map(() => "loading" as const);
  return { ordered, legs };
}

/** One leg, as a line of text ("4.2 mi · ~12 min drive"). */
export function formatLegText(leg: LegResult | "loading"): string {
  if (leg === "loading") return "Calculating drive…";
  if (leg.status === "unknown")
    return "Drive unknown — no pin or address for one stop";
  if (leg.status === "straight")
    return `${formatMiles(leg.miles)} · ~${formatMinutes(leg.minutes)} (straight-line estimate)`;
  return `${formatMiles(leg.miles)} · ~${formatMinutes(leg.minutes)} drive`;
}

export default function DayItinerary({
  jobs,
  title,
  showCrew = true,
  /**
   * Live progress (day-plan part 3): when true, each stop shows its
   * StatusBadge plus Arrived / Done buttons for viewers who may tap
   * that job. Off by default — the printable run sheet uses this
   * same list and must stay a clean snapshot with no buttons.
   */
  showStatus = false,
}: {
  jobs: Job[];
  title?: string;
  showCrew?: boolean;
  showStatus?: boolean;
}) {
  const { state, openJob } = useStore();
  const { ordered, legs } = useRouteLegs(jobs);
  const jobAddress = (j: Job): string | null =>
    state ? sharedJobAddress(state, j) : null;

  if (!state) return null;
  if (ordered.length === 0) return null;

  const stops = ordered.map((j) => {
    if (j.lat !== null && j.lng !== null) return `${j.lat},${j.lng}`;
    return jobAddress(j) ?? "";
  });
  const directionsUrl = `https://www.google.com/maps/dir/${stops
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/")}`;

  return (
    <div className="space-y-2">
      {title && (
        <p className="text-sm font-bold text-slate-900">{title}</p>
      )}
      <a
        href={directionsUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-sm font-semibold text-emerald-700 underline"
      >
        Directions for the whole route →
      </a>
      <ol className="space-y-2">
        {ordered.map((j, i) => {
          const c = state.customers.find((x) => x.id === j.customerId);
          const crew = j.crewIds
            .map((id) => state.crew.find((x) => x.id === id)?.name)
            .filter(Boolean);
          const address = jobAddress(j) ?? "Unknown address";
          const leg = i < ordered.length - 1 ? legs[i] : null;
          return (
            <li key={j.id}>
              <div
                className={`flex gap-3 rounded-lg border p-3 ${
                  // Done stops stay visible, dimmed, so the office
                  // can see what is finished and what is left.
                  j.status === "done"
                    ? "border-slate-200 bg-slate-100 opacity-70"
                    : "border-slate-200 bg-white"
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => openJob(j.id)}
                    className="text-left text-sm font-semibold text-slate-900 hover:text-emerald-700 hover:underline"
                  >
                    {j.startTime} — {j.title}
                  </button>
                  <p className="text-sm text-slate-600">
                    {c ? `${c.firstName} ${c.lastName}` : "Unknown customer"}
                    {j.lat !== null && j.lng !== null ? " · 📍 pin only" : ""}
                  </p>
                  <p className="text-sm text-slate-500">{address}</p>
                  {showCrew && (
                    <p className="text-xs text-slate-500">
                      With: {crew.length > 0 ? crew.join(", ") : "Unassigned"}
                    </p>
                  )}
                  {showStatus && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <StatusBadge status={j.status} />
                      <JobStatusButtons job={j} />
                    </div>
                  )}
                </div>
              </div>
              {leg !== null && (
                <p className="py-1 pl-10 text-xs font-semibold text-slate-500">
                  ↓ {formatLegText(leg)}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
