/**
 * Drive-distance routing for the Schedule route view.
 *
 * Coordinates per job, in priority order:
 *   (a) the job's dropped pin (lat/lng), if set;
 *   (b) geocoded job address via Nominatim (same free, no-key service
 *       TreeMap uses for "Locate property"), cached per address so the
 *       same address is never looked up twice in one page load;
 *   (c) nothing — the leg is then "unknown", never invented.
 *
 * Distances come from the OSRM public demo server (free, no API key):
 * real driving distance + duration per leg. If OSRM is unreachable
 * (offline, or the demo server is down), the leg falls back to a
 * straight-line (haversine) distance, clearly labelled as such, so
 * the route view still works offline.
 *
 * Production note: the OSRM demo server is fine for this prototype,
 * but a production deployment should self-host OSRM or use a keyed
 * provider (Mapbox, Google, …) — see README.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export type LegResult =
  | { status: "driving"; miles: number; minutes: number }
  | { status: "straight"; miles: number; minutes: number }
  | { status: "unknown" };

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const METERS_PER_MILE = 1609.344;
/** Assumed average speed (mph) for straight-line fallback drive-time estimates. */
const STRAIGHT_LINE_MPH = 30;

/** Straight-line distance in miles between two points. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

/**
 * Geocode cache: address (normalised) -> in-flight or finished lookup.
 * An address that was found is never geocoded twice in one page load, however
 * often the route view re-renders.
 */
const geocodeCache = new Map<string, Promise<LatLng | null>>();

/**
 * Nominatim asks for at most 1 request per second. The route view and
 * the day maps used to fire every stop's lookup at once, and the
 * burst came back as rate-limit errors — every stop then read as
 * "no location" for the whole page load (the failures were cached).
 * Lookups now run through a queue, ~1.1 s apart, so a day full of
 * jobs resolves one stop at a time instead of failing all at once.
 */
let geocodeQueue: Promise<unknown> = Promise.resolve();
const GEOCODE_GAP_MS = 1100;

export function geocodeAddress(address: string): Promise<LatLng | null> {
  const key = address.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached) return cached;
  const lookup = geocodeQueue.then(async (): Promise<LatLng | null> => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return null;
      const data: Array<{ lat: string; lon: string }> = await res.json();
      if (data.length === 0) return null;
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch {
      return null;
    }
  });
  // The next lookup starts after this one finishes, plus the gap.
  geocodeQueue = lookup.then(
    () => new Promise((r) => setTimeout(r, GEOCODE_GAP_MS)),
    () => new Promise((r) => setTimeout(r, GEOCODE_GAP_MS)),
  );
  geocodeCache.set(key, lookup);
  // A failed lookup (no signal, rate limit, no result) is not kept: the
  // next tap asks again (audit 3: a clock-in at a job with no pin kept
  // failing after the signal came back, until the app was reloaded).
  void lookup.then((found) => {
    if (found === null && geocodeCache.get(key) === lookup) geocodeCache.delete(key);
  });
  return lookup;
}

/**
 * Coordinates for one job: its dropped pin first, else the geocoded
 * address. Null when neither exists — callers must show "unknown",
 * never a guessed location.
 */
export function resolveJobCoords(
  job: { lat: number | null; lng: number | null },
  address: string | null,
): Promise<LatLng | null> {
  if (job.lat !== null && job.lng !== null) {
    return Promise.resolve({ lat: job.lat, lng: job.lng });
  }
  if (address) return geocodeAddress(address);
  return Promise.resolve(null);
}

/**
 * One leg between two points. OSRM driving distance/duration when
 * reachable; straight-line distance with an estimated drive time
 * when it is not. Never throws.
 */
export async function routeLeg(a: LatLng, b: LatLng): Promise<LegResult> {
  const straight = haversineMiles(a, b);
  try {
    const url = `${OSRM_URL}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data: {
      routes?: Array<{ distance: number; duration: number }>;
    } = await res.json();
    const route = data.routes?.[0];
    if (!route) throw new Error("OSRM returned no route");
    return {
      status: "driving",
      miles: route.distance / METERS_PER_MILE,
      minutes: route.duration / 60,
    };
  } catch {
    return {
      status: "straight",
      miles: straight,
      minutes: (straight / STRAIGHT_LINE_MPH) * 60,
    };
  }
}

export function formatMiles(miles: number): string {
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} hr` : `${h} hr ${rest} min`;
}
