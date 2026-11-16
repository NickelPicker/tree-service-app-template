import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  formatMiles,
  formatMinutes,
  resolveJobCoords,
  routeLeg,
  type LatLng,
} from "../routing";

/** One stop on a day map: a job or a sales estimate with a location. */
export interface DayStop {
  key: string;
  label: string;
  sub: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

/**
 * Map of the day: pins in stop order (Leaflet + OpenStreetMap).
 * Coordinates come from the job's dropped pin, else the address is
 * geocoded (same free Nominatim lookup the Schedule route view uses).
 * A stop with no pin and no usable address is listed, never guessed.
 * Pins show 1, 2, 3 by default, or 1st, 2nd, 3rd when `ordinals` is set.
 */
export default function DayMap({
  stops,
  emptyText,
  onOpenStop,
  ordinals = false,
  showList = true,
}: {
  stops: DayStop[];
  emptyText: string;
  /** Optional: when absent, stops are not clickable (e.g. crew
   * location pins — there is no job to open from a person). */
  onOpenStop?: (key: string) => void;
  ordinals?: boolean;
  showList?: boolean;
}) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const [points, setPoints] = useState<
    Array<{ stop: DayStop; coords: LatLng }>
  >([]);
  const [locating, setLocating] = useState(false);
  // Total drive for the day: summed over the legs between consecutive
  // resolved pins, in stop order. Null until at least two pins land.
  const [totals, setTotals] = useState<{
    miles: number;
    minutes: number;
    approx: boolean;
  } | null>(null);
  const stopKey = stops.map((s) => s.key).join(",");
  useEffect(() => {
    let cancelled = false;
    if (stops.length === 0) {
      setPoints([]);
      setLocating(false);
      return;
    }
    setLocating(true);
    setPoints([]);
    (async () => {
      // Resolve one stop at a time and add each pin as it lands, so a
      // day with several jobs fills in progressively instead of
      // showing nothing until every lookup finishes. The geocoder
      // itself spaces requests ~1.1 s apart (see routing.ts), so a
      // burst of parallel lookups can no longer fail all at once.
      for (const s of stops) {
        const c = await resolveJobCoords(
          { lat: s.lat, lng: s.lng },
          s.address,
        );
        if (cancelled) return;
        if (c) setPoints((prev) => [...prev, { stop: s, coords: c }]);
      }
      if (cancelled) return;
      setLocating(false);
    })();
    return () => {
      cancelled = true;
    };
    // Re-resolve only when the stop set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey]);
  const mapKey = points.map((p) => p.stop.key).join(",");
  useEffect(() => {
    if (points.length < 2) {
      setTotals(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const legs = await Promise.all(
        points.slice(1).map((p, i) => routeLeg(points[i].coords, p.coords)),
      );
      if (cancelled) return;
      let miles = 0;
      let minutes = 0;
      let approx = false;
      for (const leg of legs) {
        if (leg.status === "unknown") continue;
        miles += leg.miles;
        minutes += leg.minutes;
        if (leg.status === "straight") approx = true;
      }
      setTotals({ miles, minutes, approx });
    })();
    return () => {
      cancelled = true;
    };
    // Re-total when the resolved pins change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey]);
  useEffect(() => {
    if (!mapEl.current || points.length === 0) return;
    const map = L.map(mapEl.current, { zoomControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    const bounds: Array<[number, number]> = [];
    points.forEach((p, i) => {
      const pin = ordinals ? ordinal(i + 1) : String(i + 1);
      const icon = L.divIcon({
        className: "",
        html: `<div style="display:flex;align-items:center;justify-content:center;min-width:30px;height:26px;padding:0 6px;border-radius:9999px;background:#2f6b40;color:#fff;font-size:11px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${pin}</div>`,
        iconSize: [30, 26],
        iconAnchor: [15, 13],
      });
      L.marker([p.coords.lat, p.coords.lng], { icon })
        .addTo(map)
        .bindPopup(
          `<b>${pin}. ${escapeHtml(p.stop.label)}</b><br>${escapeHtml(p.stop.sub)}`,
        );
      bounds.push([p.coords.lat, p.coords.lng]);
    });
    map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24] });
    return () => {
      map.remove();
    };
    // Recreate the map when the resolved pins change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey]);
  if (stops.length === 0) {
    return <p className="text-sm text-slate-500">{emptyText}</p>;
  }
  return (
    <div>
      {locating && points.length === 0 ? (
        <p className="text-sm text-slate-500">Locating today's stops…</p>
      ) : points.length === 0 ? (
        <p className="text-sm text-slate-500">
          No map locations yet — add a pin or an address to the jobs.
        </p>
      ) : (
        <div
          ref={mapEl}
          className="h-64 w-full rounded-lg border border-slate-200"
        />
      )}
      {totals && points.length >= 2 && (
        <p className="mt-2 text-sm font-semibold text-slate-900">
          Total drive: {formatMinutes(totals.minutes)} ·{" "}
          {formatMiles(totals.miles)}
          {totals.approx && (
            <span className="ml-1 font-normal text-slate-500">
              (approx. — straight-line for one or more legs)
            </span>
          )}
        </p>
      )}
      {showList && (
        <ol className="mt-3 space-y-1 text-sm">
          {stops.map((s, i) => (
            <li key={s.key}>
              {onOpenStop ? (
                <button
                  onClick={() => onOpenStop(s.key)}
                  className="text-left text-slate-700 hover:text-emerald-700 hover:underline"
                >
                  <span className="font-bold text-slate-900">
                    {ordinals ? ordinal(i + 1) : `${i + 1}.`}
                  </span>{" "}
                  {s.label} · {s.sub}
                </button>
              ) : (
                <span className="text-slate-700">
                  <span className="font-bold text-slate-900">
                    {ordinals ? ordinal(i + 1) : `${i + 1}.`}
                  </span>{" "}
                  {s.label} · {s.sub}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
