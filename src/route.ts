/**
 * Web addresses for screens and open panels.
 *
 * Each main screen and each open panel (job, estimate, invoice,
 * customer, person) has its own address after the "#", for example
 *
 *   #/schedule                     the Schedule
 *   #/customers/customer/c1        a customer's panel over Customers
 *   #/customers/customer/c1/job/j9 a job opened from that customer
 *
 * so the browser's Back button (and the Android back swipe) goes to the
 * previous screen or closes the top panel instead of leaving the app,
 * and an address can be sent to a teammate. The part after "#" never
 * reaches the server, so Netlify needs nothing new, and the public
 * pages keep their own addresses (/accept/<token>, #/book,
 * #/runsheet/<id>). No React here, so it is unit tested on its own.
 */
import type { DrawerTarget, View } from "./store";

/** Every screen that may appear in an address. */
export const ROUTE_VIEWS: readonly View[] = [
  "dashboard",
  "customers",
  "schedule",
  "estimates",
  "invoices",
  "timesheets",
  "automations",
  "activity",
  "messages",
  "users",
  "pipeline",
  "phc",
  "crew",
  "guide",
  "sales",
  "equipment",
  "portal",
  "crew-rules",
  "documents",
  "me",
];

/** Friendlier words for some screens in the address bar. */
const VIEW_SLUG: Partial<Record<View, string>> = {
  crew: "today",
  users: "team",
  guide: "field-guide",
  sales: "sales-calendar",
  documents: "licences-insurance",
};

function viewSlug(v: View): string {
  return VIEW_SLUG[v] ?? v;
}

function viewFromSlug(slug: string): View | null {
  for (const v of ROUTE_VIEWS) if (viewSlug(v) === slug) return v;
  return null;
}

/** A panel as it is written in an address. */
type Segment = [kind: string, id: string];

function segmentFor(d: DrawerTarget): Segment {
  switch (d.kind) {
    case "job":
      return ["job", d.jobId ?? "new"];
    case "estimate":
      return ["estimate", d.estimateId];
    case "invoice":
      return ["invoice", d.invoiceId];
    case "customer":
      return ["customer", d.customerId];
    case "employee":
      return ["person", d.employeeId ?? "new"];
    case "newEstimate":
      return ["new-estimate", d.customerId];
  }
}

/** The address (starting with "#/") for a screen and its open panels. */
export function formatRoute(view: View, drawers: readonly DrawerTarget[]): string {
  const parts = [viewSlug(view)];
  for (const d of drawers) {
    const [kind, id] = segmentFor(d);
    parts.push(kind, encodeURIComponent(id));
  }
  return `#/${parts.join("/")}`;
}

export interface ParsedRoute {
  view: View;
  drawers: DrawerTarget[];
}

/** True for addresses this module owns (not the public #/book or #/runsheet pages). */
export function isAppRoute(hash: string): boolean {
  if (!hash.startsWith("#/")) return false;
  const first = hash.slice(2).split("/")[0];
  return viewFromSlug(first) !== null;
}

/**
 * Read an address back. Returns null for anything that is not an app
 * address (empty, a sign-in link's "#access_token=…", the public pages).
 * Unknown panel parts are skipped; `newJobDate` is the date a "new job"
 * panel opened from an address starts on.
 */
export function parseRoute(hash: string, newJobDate: string): ParsedRoute | null {
  if (!isAppRoute(hash)) return null;
  const parts = hash.slice(2).split("/").filter((p) => p !== "");
  const view = viewFromSlug(parts[0]) as View;
  const drawers: DrawerTarget[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const kind = parts[i];
    let id: string;
    try {
      id = decodeURIComponent(parts[i + 1]);
    } catch {
      continue;
    }
    if (!id) continue;
    if (kind === "job") {
      drawers.push({
        kind: "job",
        jobId: id === "new" ? null : id,
        defaultDate: newJobDate,
      });
    } else if (kind === "estimate") {
      drawers.push({ kind: "estimate", estimateId: id });
    } else if (kind === "invoice") {
      drawers.push({ kind: "invoice", invoiceId: id });
    } else if (kind === "customer") {
      drawers.push({ kind: "customer", customerId: id });
    } else if (kind === "person") {
      drawers.push({
        kind: "employee",
        employeeId: id === "new" ? null : id,
        edit: false,
      });
    } else if (kind === "new-estimate") {
      drawers.push({ kind: "newEstimate", customerId: id });
    }
  }
  return { view, drawers };
}

function sameSegment(a: DrawerTarget, b: DrawerTarget): boolean {
  const [ka, ia] = segmentFor(a);
  const [kb, ib] = segmentFor(b);
  return ka === kb && ia === ib;
}

/**
 * The panels to show after Back or Forward: the ones from the address,
 * keeping the open panel objects that match (so a new job keeps the
 * start time it was opened with).
 */
export function mergeDrawers(
  current: readonly DrawerTarget[],
  next: readonly DrawerTarget[],
): DrawerTarget[] {
  return next.map((d, i) =>
    current[i] && sameSegment(current[i], d) ? current[i] : d,
  );
}

/** True when two panel lists would write the same address. */
export function sameDrawers(
  a: readonly DrawerTarget[],
  b: readonly DrawerTarget[],
): boolean {
  return a.length === b.length && a.every((d, i) => sameSegment(d, b[i]));
}

/**
 * How to write the address after the screen changed in the app (not
 * from Back/Forward):
 * - "back": panels were closed in the app (X, Escape, saving a form) and
 *   each of them was opened in the app with its own history entry: step
 *   back over those entries, so Back afterwards does not open them again;
 * - "replace": panels were closed but were not opened in the app (a link
 *   or a reload): rewrite this entry, never add one that Back would undo
 *   into the closed panel;
 * - "push": anything else gets a new entry. `depth` is how many panels
 *   on top of each other were opened one at a time in the app, kept in
 *   the entry's history state.
 * `depth` passed in is the current entry's.
 */
export function addressWrite(
  prev: { view: string; drawers: readonly DrawerTarget[] },
  next: { view: string; drawers: readonly DrawerTarget[] },
  depth: number,
): { kind: "back"; steps: number } | { kind: "replace" } | { kind: "push"; depth: number } {
  const sameView = prev.view === next.view;
  const closed = prev.drawers.length - next.drawers.length;
  if (sameView && closed > 0 && sameDrawers(prev.drawers.slice(0, next.drawers.length), next.drawers)) {
    return depth >= closed ? { kind: "back", steps: closed } : { kind: "replace" };
  }
  const openedOne =
    sameView &&
    next.drawers.length === prev.drawers.length + 1 &&
    sameDrawers(next.drawers.slice(0, prev.drawers.length), prev.drawers);
  return { kind: "push", depth: openedOne ? depth + 1 : 0 };
}
