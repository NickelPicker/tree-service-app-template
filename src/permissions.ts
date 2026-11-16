import type { AppState, CrewMember, Role } from "./types";

/**
 * Owner-equivalent app roles. "Manager" was added 2026-11-12: a manager can do everything an
 * owner can — edit, approve signups, remove team members, closed
 * days, crew rules, settings, quick-assign. The "owner" value is
 * kept (a company may still have one); capability checks must use
 * this helper, never `appRole === "owner"`, or managers silently
 * lose powers.
 */
export function isOwnerLike(
  appRole: Role | null | undefined,
): boolean {
  return appRole === "owner" || appRole === "manager";
}

/**
 * Whether a viewer may message customers. The explicit per-person
 * toggle (permissions.canMessageCustomers, owner-set on the Users
 * page) is the ONLY source of truth: unset means NO. There is no
 * role fallback and no owner bypass — nobody, not even an owner,
 * can message until an owner turns the toggle on for them. New
 * people therefore start with no messaging access, and the owner
 * enables it per person. `state` is used to read the freshest crew
 * record for the viewer when one exists, so a toggle flipped
 * moments ago is honored immediately.
 */
export function canMessageCustomers(
  state: AppState | null,
  viewer: CrewMember | null | undefined,
): boolean {
  if (!viewer) return false;
  const fresh = state?.crew.find((c) => c.id === viewer.id) ?? viewer;
  return fresh.permissions?.canMessageCustomers === true;
}

/**
 * Whether a viewer may clock in manually / enter hours by hand.
 * The explicit per-person toggle (permissions.canManualClockIn,
 * owner-set on the Users page) wins when set; when unset, owners,
 * managers and the office may (business rule: office logins see the
 * manual hours form by default; the database already lets the office
 * type hours). Everyone else must tap Clock in at the job, which
 * is geofenced. `state` is used to read the freshest crew record for
 * the viewer when one exists, so a toggle flipped moments ago is
 * honored immediately.
 */
export function canManualClockIn(
  state: AppState | null,
  viewer: CrewMember | null | undefined,
): boolean {
  if (!viewer) return false;
  const fresh = state?.crew.find((c) => c.id === viewer.id) ?? viewer;
  const explicit = fresh.permissions?.canManualClockIn;
  if (explicit !== undefined) return explicit;
  return canEditRecords(fresh.appRole);
}

/**
 * Weekly pay on Timesheets: hours and pay per person, "Approve week"
 * and "Download for payroll". Owners and managers (business rule:
 * "Sam runs weekly pay"); the database gives week approvals to
 * is_company_admin (owner or manager). Not the office, not crew.
 */
export function canRunWeeklyPay(appRole: Role | null | undefined): boolean {
  return isOwnerLike(appRole);
}

/**
 * Approve or deny time-off requests: owners, managers (Sam) and the
 * office, as the database allows (time_off_requests update for
 * is_company_staff). Crew only ask, and withdraw their own pending ask.
 */
export function canDecideTimeOff(appRole: Role | null | undefined): boolean {
  return canEditRecords(appRole);
}

/**
 * Whether a viewer may type clock times, dates or hours on a time entry
 * (business rule, "Live-only clock-in unless allowed"):
 * owners, managers and the office always may (they fix entries); anyone
 * else only with "May enter hours by hand" (permissions.canManualClockIn
 * === true, default off). Everyone else clocks in and out live with the
 * Clock in / Clock out buttons. The database enforces the same rule
 * (trigger limit_crew_clock_times, the "manager pay and live clock-in" rules).
 */
export function mayTypeClockTimes(
  state: AppState | null,
  viewer: CrewMember | null | undefined,
): boolean {
  if (!viewer) return false;
  const fresh = state?.crew.find((c) => c.id === viewer.id) ?? viewer;
  return canEditRecords(fresh.appRole) || fresh.permissions?.canManualClockIn === true;
}

/**
 * A time-entry edit as this viewer may save it: without
 * `mayTypeClockTimes`, the date, clock times and hours stay as they
 * were (only the job, notes and location change).
 */
export function limitTimesheetEdit<
  T extends { date: string; clockIn: string | null; clockOut: string | null; hours: number | null },
>(old: T, next: T, mayType: boolean): T {
  if (mayType) return next;
  return { ...next, date: old.date, clockIn: old.clockIn, clockOut: old.clockOut, hours: old.hours };
}

/**
 * Office editing rights: owners, managers and the Office app role may
 * change customers, estimates, jobs and invoices. The job title (free
 * text such as "Office manager") plays no part: the database gives
 * every office login these rights (is_company_staff), so the screens
 * do the same.
 */
export function canEditRecords(appRole: Role | null | undefined): boolean {
  return isOwnerLike(appRole) || appRole === "office";
}

/**
 * A salesperson: anyone whose job title (crew.role, free text) is
 * "Sales", any letter case. Their app role may be office or crew.
 */
export function isSalesTitle(jobTitle: string | null | undefined): boolean {
  return (jobTitle ?? "").trim().toLowerCase() === "sales";
}

/**
 * May book estimate visits, add customers and write draft estimates
 * on the Sales calendar: the office, owners and managers, and Sales
 * people even when their app role is crew. The database allows a
 * crew-role Sales person exactly this (is_sales_person, migration
 * the "sales people book visits" rules): read customers and estimates, add customers, add
 * and change draft estimates.
 */
export function canSellRecords(
  appRole: Role | null | undefined,
  jobTitle: string | null | undefined,
): boolean {
  return canEditRecords(appRole) || (appRole != null && isSalesTitle(jobTitle));
}

/**
 * Whether the screens show dollar amounts (job values, estimate totals)
 * to this person. The "see money" switch on the Team page (or the role
 * default: everyone but crew) decides, and a Sales person always sees
 * them (business rule: "Pat can see the money"): the database gives
 * a Sales login his estimates and job prices, except on commercial jobs
 * he did not estimate, which come without prices (job_money_visible, migrations
 * the "sales access refine" rules and the "sales job money" rules). The switch itself still
 * decides the Invoices tab, so a Sales login does not get invoices.
 */
export function showsMoney(
  seeMoney: boolean,
  appRole: Role | null | undefined,
  jobTitle: string | null | undefined,
): boolean {
  return seeMoney || (appRole != null && isSalesTitle(jobTitle));
}

/** Owners, managers and the office open the app on the Dashboard; crew on Today. */
export function landsOnDashboard(appRole: Role | null | undefined): boolean {
  return canEditRecords(appRole);
}

/**
 * Send this person from the default landing screen to Today? Only crew
 * (no Dashboard), only from the Dashboard default, and only when no
 * screen was chosen on purpose yet (a tab, or an address from a link or
 * a reload): `screenChosen`.
 */
export function redirectToToday(
  appRole: Role | null | undefined,
  view: string,
  screenChosen: boolean,
): boolean {
  return !landsOnDashboard(appRole) && view === "dashboard" && !screenChosen;
}

/**
 * A short plain line for the header when this person cannot change
 * everything they can see, or null when nothing needs saying.
 */
export function accessNote(canEdit: boolean, canEditJobs: boolean): string | null {
  if (canEdit) return null;
  if (canEditJobs) return "You can update the jobs you are on.";
  return "You can look at records here. Ask the office to change them.";
}

/**
 * Whether this viewer may move a job to `toDate`. Crew (Climbers
 * included) may not change a job's day: the office decides when a job
 * is, and the database refuses it (the "crew privacy notes prices and dates" rules). Moving
 * it to another time on the same day is fine.
 */
export function mayMoveJobToDate(
  role: Role | null | undefined,
  jobDate: string,
  toDate: string,
): boolean {
  return role !== "crew" || jobDate === toDate;
}

/** What crew are told when they try to move a job to another day. */
export const CREW_CANNOT_MOVE_JOB =
  "Only the office can move a job to another day. Ask the office to change it.";

/**
 * May this viewer change this job's fields (the work, crew, prices)?
 * The same rule as the database's job_row_assigned (migration
 * the "rls tightening" rules): the office, managers and owners change any job; a
 * crew Climber only a job they are on, or whose crew shares their day
 * crew that day. "See all jobs" lets crew look at every job, never
 * change one they are not on. A new job (null) keeps the role rule.
 */
export function mayChangeJob(
  job: { crewIds: string[]; date: string } | null,
  viewerId: string,
  opts: {
    canManage: boolean;
    canEditJobs: boolean;
    dayCrews: ReadonlyArray<{ date: string; memberIds: string[] }>;
  },
): boolean {
  if (opts.canManage) return true;
  if (!opts.canEditJobs) return false;
  if (!job) return true;
  if (job.crewIds.includes(viewerId)) return true;
  return opts.dayCrews.some(
    (d) =>
      d.date === job.date &&
      d.memberIds.includes(viewerId) &&
      d.memberIds.some((m) => job.crewIds.includes(m)),
  );
}

/** What crew are told when they try to change a job they are not on. */
export const CREW_ONLY_THEIR_JOBS =
  "You can only change the jobs you are on. Ask the office to change this one.";

/**
 * Which of a job's money fields this viewer may change.
 * - prices: job value, hourly rate and flat/hourly billing;
 * - costs: labor rate, materials cost and other costs.
 * The office, managers and owners (`canEdit`) change both. A crew
 * Climber (`canEditJobs` without `canEdit`) changes the prices of the
 * jobs they are on even without "see money" (business rule, the "climbers change prices" rules), but the costs only with
 * "see money". Everyone else changes neither (the database refuses
 * them: crew may change only a job's status).
 * - withReason: the prices change only with a reason, through the
 *   price box (change_job_price), never with the job's Save (business rule; the "invoice email by hand" rules): true for the Climber.
 */
export function jobMoneyEdits(opts: {
  canEdit: boolean;
  canEditJobs: boolean;
  seeMoney: boolean;
}): { prices: boolean; costs: boolean; withReason: boolean } {
  if (opts.canEdit) return { prices: true, costs: true, withReason: false };
  if (opts.canEditJobs) return { prices: true, costs: opts.seeMoney, withReason: true };
  return { prices: false, costs: false, withReason: false };
}
