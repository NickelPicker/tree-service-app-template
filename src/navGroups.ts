/**
 * The main tab row and the "More" menu.
 *
 * The app has ~18 screens. Showing them all in one row cut tabs off
 * on laptops and hid most of them off-screen on phones, so each role
 * gets a short row of main tabs; everything else it may see goes
 * under "More". Some main tabs hold a few related screens (Sales =
 * the Sales calendar, Estimates and Pipeline) shown as small
 * sub-tabs on the page.
 *
 * Which screens a person may see is decided elsewhere (App.tsx
 * `viewsFor`); this module only arranges that list, so it can never
 * show a screen the role can't see. No React here, so it is unit
 * tested on its own.
 */

/** A screen id (the same strings as `View` in store.tsx). */
export type ViewId = string;

export interface TabGroupDef {
  id: string;
  label: string;
  /** Screens in this tab, first one is the tab's home screen. */
  views: ViewId[];
  /** Show the screens as sub-tabs on the page. */
  subTabs: boolean;
}

/** Owner, manager and office: the everyday office tabs. */
export const OFFICE_GROUPS: TabGroupDef[] = [
  { id: "dashboard", label: "Dashboard", views: ["dashboard"], subTabs: false },
  { id: "customers", label: "Customers", views: ["customers"], subTabs: false },
  { id: "schedule", label: "Schedule", views: ["schedule"], subTabs: false },
  {
    id: "sales",
    label: "Sales",
    // The Sales calendar first (business rule).
    views: ["sales", "estimates", "pipeline"],
    subTabs: true,
  },
  { id: "invoices", label: "Invoices", views: ["invoices"], subTabs: false },
  {
    id: "team",
    label: "Team",
    views: ["users", "timesheets", "crew-rules"],
    subTabs: true,
  },
];

/** Crew logins: their day, the calendar, equipment and themselves. */
export const FIELD_GROUPS: TabGroupDef[] = [
  { id: "crew", label: "Today", views: ["crew"], subTabs: false },
  { id: "schedule", label: "Schedule", views: ["schedule"], subTabs: false },
  {
    id: "equipment",
    label: "Equipment",
    views: ["equipment", "guide"],
    subTabs: true,
  },
  { id: "me", label: "Me", views: ["me", "timesheets"], subTabs: false },
];

/**
 * The Sales tab for a salesperson with a crew login (job title
 * "Sales"): the Sales calendar first, then their estimates. Added
 * after Today by `fieldGroupsFor`; other crew never get it.
 */
export const SALES_FIELD_GROUP: TabGroupDef = {
  id: "sales",
  label: "Sales",
  views: ["sales", "estimates"],
  subTabs: true,
};

/** The crew tab row; a Sales person also gets the Sales tab, right after Today. */
export function fieldGroupsFor(isSales: boolean): TabGroupDef[] {
  if (!isSales) return FIELD_GROUPS;
  return [FIELD_GROUPS[0], SALES_FIELD_GROUP, ...FIELD_GROUPS.slice(1)];
}

/** Short names for screens inside a main tab or the More menu. */
export const VIEW_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  customers: "Customers",
  schedule: "Schedule",
  pipeline: "Pipeline",
  phc: "Plant Health Care",
  estimates: "Estimates",
  invoices: "Invoices",
  timesheets: "Timesheets",
  automations: "Automations",
  activity: "Activity",
  messages: "Messages",
  crew: "Today",
  guide: "Field guide",
  sales: "Sales calendar",
  equipment: "Equipment",
  "crew-rules": "Crew rules",
  documents: "Licences & insurance",
  portal: "Customer portal",
  users: "Team",
  me: "Me",
};

export function viewLabel(id: ViewId): string {
  return VIEW_LABELS[id] ?? id;
}

export interface TabGroup {
  id: string;
  label: string;
  /** The screens in this tab this person may see, in order. */
  views: ViewId[];
  subTabs: boolean;
}

export interface NavLayout {
  main: TabGroup[];
  more: ViewId[];
}

/**
 * Arrange the screens a person may see into main tabs and More.
 * A main tab shows only if at least one of its screens is visible;
 * when its home screen is not visible (office can't open People, so
 * Team holds only Timesheets) it is named after what it does hold.
 */
export function buildNav(visible: ViewId[], groups: TabGroupDef[]): NavLayout {
  const main: TabGroup[] = [];
  const taken = new Set<ViewId>();
  for (const g of groups) {
    const views = g.views.filter((v) => visible.includes(v));
    if (views.length === 0) continue;
    views.forEach((v) => taken.add(v));
    main.push({
      id: g.id,
      label: views[0] === g.views[0] ? g.label : viewLabel(views[0]),
      views,
      subTabs: g.subTabs && views.length > 1,
    });
  }
  const more = visible.filter((v) => !taken.has(v));
  return { main, more };
}

/** Which main tab a screen sits in, or null when it is under More. */
export function groupForView(layout: NavLayout, view: ViewId): TabGroup | null {
  return layout.main.find((g) => g.views.includes(view)) ?? null;
}

/**
 * The screen to open when a main tab is tapped: the one this person
 * last used inside that tab, if they can still see it, else its home.
 */
export function viewForGroup(group: TabGroup, lastUsed: ViewId | undefined): ViewId {
  return lastUsed && group.views.includes(lastUsed) ? lastUsed : group.views[0];
}
