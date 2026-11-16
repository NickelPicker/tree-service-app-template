/**
 * Real road drive times for the day planner.
 *
 * One OSRM "table" request covers the shop and every job of the day
 * (every drive from each point to each other point), instead of one
 * request per leg. Results are cached on this device per pair of
 * rounded positions, so re-planning the same day costs nothing. Any
 * pair the routing service cannot answer falls back to the straight-line
 * estimate, and the plan says how many legs are estimates.
 *
 * Planning chains every drive from where the crew just was: the shop to
 * the first job, then each job to the next (src/planner/engine.ts).
 */
import { straightLineMinutes } from "./input";
import type { LatLng } from "../routing";

/**
 * Road-time servers, tried in order. Both are free public OSRM servers
 * with no uptime promise; the second (FOSSGIS, Germany) answers when the
 * first is busy or down. Both are in netlify.toml's connect-src.
 */
const OSRM_TABLES = [
  "https://router.project-osrm.org/table/v1/driving",
  "https://routing.openstreetmap.de/routed-car/table/v1/driving",
];
const CACHE_KEY = "treeapp:drive-minutes:v1";
const CACHE_MAX = 4000;
/** The public OSRM server allows about 100 points per table; stay well under. */
const CHUNK = 40;

const keyOf = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
const pairKey = (a: LatLng, b: LatLng) => `${keyOf(a)}>${keyOf(b)}`;

function readCache(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, number>): void {
  try {
    const keys = Object.keys(cache);
    // Keep the newest entries when it grows large (insertion order).
    const trimmed =
      keys.length > CACHE_MAX
        ? Object.fromEntries(keys.slice(keys.length - CACHE_MAX).map((k) => [k, cache[k]]))
        : cache;
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // A full or blocked storage only means no cache.
  }
}

async function fetchTable(
  sources: LatLng[],
  destinations: LatLng[],
  timeoutMs: number,
): Promise<(number | null)[][] | null> {
  for (const base of OSRM_TABLES) {
    const t = await fetchTableFrom(base, sources, destinations, timeoutMs);
    if (t) return t;
  }
  return null;
}

async function fetchTableFrom(
  base: string,
  sources: LatLng[],
  destinations: LatLng[],
  timeoutMs: number,
): Promise<(number | null)[][] | null> {
  const all = [...sources, ...destinations];
  const coords = all.map((p) => `${p.lng},${p.lat}`).join(";");
  const src = sources.map((_, i) => i).join(";");
  const dst = destinations.map((_, i) => i + sources.length).join(";");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${base}/${coords}?annotations=duration&sources=${src}&destinations=${dst}`,
      { headers: { Accept: "application/json" }, signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const data: { code?: string; durations?: (number | null)[][] } = await res.json();
    return data.code === "Ok" && data.durations ? data.durations : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DriveTimes {
  /** Drive minutes from a to b: road time when known, else the straight-line estimate. */
  minutes: (a: LatLng, b: LatLng) => number;
  /** How many of the asked-for legs are road times, and how many are estimates. */
  road: number;
  estimated: number;
}

/**
 * Road drive times between every pair of these points (shop + jobs).
 * Never throws; with no network everything is a flagged estimate.
 */
export async function loadDriveTimes(points: LatLng[], timeoutMs = 8000): Promise<DriveTimes> {
  const unique = [...new Map(points.map((p) => [keyOf(p), p])).values()];
  const cache = readCache();
  const missing = unique.some((a) => unique.some((b) => a !== b && cache[pairKey(a, b)] == null));
  if (missing && unique.length > 1) {
    for (let i = 0; i < unique.length; i += CHUNK) {
      for (let j = 0; j < unique.length; j += CHUNK) {
        const from = unique.slice(i, i + CHUNK);
        const to = unique.slice(j, j + CHUNK);
        const table = await fetchTable(from, to, timeoutMs);
        if (!table) continue;
        from.forEach((a, ai) =>
          to.forEach((b, bi) => {
            const sec = table[ai]?.[bi];
            if (a !== b && typeof sec === "number" && Number.isFinite(sec)) {
              cache[pairKey(a, b)] = Math.round(sec / 60);
            }
          }),
        );
      }
    }
    writeCache(cache);
  }
  let road = 0;
  let estimated = 0;
  for (const a of unique) {
    for (const b of unique) {
      if (a === b) continue;
      if (cache[pairKey(a, b)] != null) road++;
      else estimated++;
    }
  }
  return {
    minutes: (a, b) => cache[pairKey(a, b)] ?? straightLineMinutes(a, b),
    road,
    estimated,
  };
}
