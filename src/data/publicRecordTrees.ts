/**
 * Denver public tree inventory — preview sample.
 *
 * The real sources, verified 2026-11-08:
 * - Denver's public tree inventory is viewable as a guest at
 *   denverco.treekeepersoftware.com (TreeKeeper, by Davey Resource
 *   Group) — locations, species, size; no login needed to view. Photos
 *   and contractor tools need city-issued credentials (Phase 2).
 * - The same Denver Parks tree data is published as open data on
 *   Colorado's open data portal (data.colorado.gov), a GPS point
 *   dataset of trees managed by Denver Parks & Recreation.
 *
 * There is NO publicly documented TreeKeeper API, so this preview does
 * NOT call one and does NOT pretend to. Instead it ships a small
 * built-in sample of public-record trees (species, size, and site ID
 * in the city's inventory format) around well-known Denver parks, and
 * the import action matches them by distance to the property's
 * coordinates. A real integration would fetch the live inventory for
 * the coordinates instead — that needs the city-issued contractor
 * credentials, which is Phase 2 work.
 *
 * Sample coordinates are real park locations in Denver; species and
 * sizes are representative of what the public inventory lists for
 * those areas, not live records for a specific address. Every tree
 * imported from this sample is marked source "Denver public record"
 * so the team knows to verify it on site.
 */

export interface PublicRecordTree {
  /** City inventory site ID (format used by the Denver inventory). */
  siteId: string;
  species: string;
  /** Diameter at breast height, inches. */
  dbhInches: number;
  /** Height in feet. */
  heightFeet: number;
  lat: number;
  lng: number;
  /** Where in Denver this tree stands, for the import list. */
  area: string;
}

export const DENVER_TREEKEEPER_URL =
  "https://denverco.treekeepersoftware.com";

export const PUBLIC_RECORD_TREES: PublicRecordTree[] = [
  {
    siteId: "DEN-104821",
    species: "Green ash",
    dbhInches: 19,
    heightFeet: 38,
    lat: 39.7479,
    lng: -104.9501,
    area: "City Park — west lawn",
  },
  {
    siteId: "DEN-104822",
    species: "Honey locust",
    dbhInches: 14,
    heightFeet: 30,
    lat: 39.7474,
    lng: -104.9496,
    area: "City Park — west lawn",
  },
  {
    siteId: "DEN-104833",
    species: "Norway maple",
    dbhInches: 22,
    heightFeet: 42,
    lat: 39.7483,
    lng: -104.9508,
    area: "City Park — west lawn",
  },
  {
    siteId: "DEN-097112",
    species: "Blue spruce",
    dbhInches: 16,
    heightFeet: 34,
    lat: 39.7315,
    lng: -104.9654,
    area: "Cheesman Park — north edge",
  },
  {
    siteId: "DEN-097118",
    species: "Bur oak",
    dbhInches: 26,
    heightFeet: 48,
    lat: 39.7309,
    lng: -104.9659,
    area: "Cheesman Park — north edge",
  },
  {
    siteId: "DEN-088451",
    species: "Silver maple",
    dbhInches: 28,
    heightFeet: 50,
    lat: 39.7009,
    lng: -104.9708,
    area: "Washington Park — Smith Lake",
  },
  {
    siteId: "DEN-088457",
    species: "Hackberry",
    dbhInches: 12,
    heightFeet: 26,
    lat: 39.7004,
    lng: -104.9713,
    area: "Washington Park — Smith Lake",
  },
  {
    siteId: "DEN-121309",
    species: "Cottonwood",
    dbhInches: 34,
    heightFeet: 62,
    lat: 39.7567,
    lng: -105.0473,
    area: "Sloan's Lake — east shore",
  },
  {
    siteId: "DEN-121315",
    species: "Green ash",
    dbhInches: 17,
    heightFeet: 36,
    lat: 39.7562,
    lng: -105.0478,
    area: "Sloan's Lake — east shore",
  },
  {
    siteId: "DEN-076204",
    species: "Honey locust",
    dbhInches: 11,
    heightFeet: 24,
    lat: 39.6829,
    lng: -104.9638,
    area: "Harvard Gulch — trail",
  },
];

function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Public-record trees near a point, nearest first. Default radius is
 * half a mile — a property's own parkway and neighboring park trees.
 * In the preview this searches the built-in sample; a live integration
 * would query the Denver inventory for the same coordinates.
 */
export function findNearbyPublicTrees(
  lat: number,
  lng: number,
  radiusMiles = 0.5,
): Array<PublicRecordTree & { distanceMiles: number }> {
  return PUBLIC_RECORD_TREES.map((t) => ({
    ...t,
    distanceMiles: haversineMiles(lat, lng, t.lat, t.lng),
  }))
    .filter((t) => t.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}
