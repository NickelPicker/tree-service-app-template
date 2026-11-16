/**
 * Turn-by-turn directions in the person's own map app.
 *
 * The first time someone taps Navigate, they pick Google Maps, Apple
 * Maps or Waze; that choice is remembered on this phone (it depends on
 * which apps the phone has) and can be changed on their profile. The
 * links below open the installed app on phones, or the website
 * elsewhere.
 */
export type MapApp = "google" | "apple" | "waze";

export const MAP_APPS: Array<{ id: MapApp; label: string }> = [
  { id: "google", label: "Google Maps" },
  { id: "apple", label: "Apple Maps" },
  { id: "waze", label: "Waze" },
];

/**
 * Kept outside the "treeapp:" keys on purpose: signing out wipes
 * company data, but which map app this phone uses is not company data.
 */
const KEY = "treeapp:map-app";

export function getMapApp(): MapApp | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "google" || v === "apple" || v === "waze" ? v : null;
  } catch {
    return null;
  }
}

export function setMapApp(app: MapApp | null): void {
  try {
    if (app) localStorage.setItem(KEY, app);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: they will be asked again next time.
  }
}

export interface Destination {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
}

/** True when there is somewhere to navigate to. */
export function hasDestination(d: Destination): boolean {
  return (d.lat != null && d.lng != null) || !!d.address?.trim();
}

/** Driving directions from the phone's current location to the destination. */
export function directionsUrl(app: MapApp, d: Destination): string {
  const pin = d.lat != null && d.lng != null ? `${d.lat},${d.lng}` : null;
  const where = encodeURIComponent(pin ?? (d.address ?? "").trim());
  switch (app) {
    case "apple":
      return `https://maps.apple.com/?daddr=${where}&dirflg=d`;
    case "waze":
      return pin
        ? `https://waze.com/ul?ll=${where}&navigate=yes`
        : `https://waze.com/ul?q=${where}&navigate=yes`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${where}&travelmode=driving`;
  }
}
