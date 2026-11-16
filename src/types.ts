export type JobStatus = "scheduled" | "in_progress" | "done";
export type EstimateStatus = "draft" | "sent" | "accepted" | "closed";
export type InvoiceStatus = "unpaid" | "paid" | "overdue" | "partial";

/** How a paid invoice was paid. Null = not recorded — never guessed. */
export type PaymentMethod = "zelle" | "check" | "cash";
export type Role = "owner" | "manager" | "office" | "crew";
export type ServiceType =
  | "Removal"
  | "Trimming"
  | "Stump Grinding"
  | "Plant Health Care"
  | "Emergency"
  | "Fertilization";

/** One address on a customer. A customer can have several (home, rental, parents' house); exactly one is primary. */
export interface CustomerAddress {
  id: string;
  /** Short label shown in pickers, e.g. "Home", "Rental", "Mom's house". */
  label: string;
  street: string;
  city: string;
  /** Two-letter state, default "CO". */
  state: string;
  zip: string;
  isPrimary: boolean;
}

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  zip: string;
  /**
   * Every address on this customer. The legacy address/city/zip fields
   * above always mirror the primary address (saveCustomer keeps them
   * in sync), so older code and imports keep working. Empty / missing
   * on old rows — customerAddresses() synthesizes one from the legacy
   * fields in that case.
   */
  addresses?: CustomerAddress[];
  propertyNotes: string;
  gateCode: string;
  notes: string;
  /**
   * Property map position (WGS84). Null until the property is located
   * (geocoded from the stored address, or placed by hand on the map).
   */
  mapLat: number | null;
  mapLng: number | null;
  /**
   * Hand-drawn property boundary as [lat, lng] points in order, or
   * null when none is drawn. Never auto-guessed: the parcel tile
   * overlay shows lines visually, and this polygon is only ever what
   * the user drew (or a polygon returned by a verified parcel lookup,
   * which is later work).
   */
  boundary: Array<[number, number]> | null;
  /** Residential or Commercial — commercial customers carry project fields below. */
  type: CustomerType;
  /** Commercial only: the contracting company (billing entity). */
  companyName: string | null;
  /** Commercial only: project name and number, shown on jobs/estimates. */
  projectName: string | null;
  projectNumber: string | null;
  /** Commercial only: PO / contract number, shown on jobs/estimates/invoices. */
  poNumber: string | null;
  contractNumber: string | null;
  /** Commercial only: job-site address, which may differ from billing address. */
  jobSiteAddress: string | null;
  /** Commercial only: billing terms, e.g. "Net 30". */
  billingTerms: string | null;
  /** Commercial only: contacts with roles (PM, Superintendent, AP). */
  contacts: CommercialContact[];
  /**
   * "No automatic emails": the Automations page never emails this
   * customer (reminders, thank-yous, review requests). Emails the team
   * sends by hand still go. Missing = false.
   */
  noAutoEmails?: boolean;
}

/** One contact on a commercial customer, with a project role. */
export interface CommercialContact {
  id: string;
  name: string;
  role: "Project Manager" | "Superintendent" | "Accounts Payable" | "Other";
  email: string;
  phone: string;
}

export type CustomerType = "residential" | "commercial";

/**
 * One labeled tree on a customer's property (tree
 * inventory). Positions are map coordinates the team places by hand;
 * the inventory fields are filled out by the team.
 */
export type TreeCondition = "Good" | "Fair" | "Poor" | "Dead";

/** One dated DBH measurement for a tree (history). */
export interface DbhMeasurement {
  date: string; // YYYY-MM-DD
  dbh: string; // e.g. "18 in"
}

/** One dated condition note for a tree. */
export interface ConditionRecord {
  date: string; // YYYY-MM-DD
  condition: TreeCondition;
  notes: string;
}

/** ISA-style risk rating for a tree. Empty = not assessed yet. */
export type RiskRating = "Low" | "Moderate" | "High";

export interface Tree {
  id: string;
  customerId: string;
  lat: number;
  lng: number;
  label: string;
  species: string;
  /** Diameter at breast height — free text (e.g. "18 in"). */
  dbh: string;
  /** Height — free text (e.g. "35 ft"). */
  height: string;
  condition: TreeCondition;
  /** Work status / next work (e.g. "Prune next visit"). */
  status: string;
  notes: string;
  /** Dated DBH measurements, oldest first. */
  dbhHistory: DbhMeasurement[];
  /** Dated condition records, oldest first. */
  conditionHistory: ConditionRecord[];
  /** Risk assessment rating. "" = not assessed yet. */
  riskRating: RiskRating | "";
  /** Risk assessment notes (e.g. "Leaning toward house, monitor"). */
  riskNotes: string;
  /**
   * Field photos of the tree (the estimator's phone photos), stored as data URLs
   * (downscaled on upload). Shown in the tree inventory and on the map.
   */
  photos: string[];
  /** Next risk inspection date (YYYY-MM-DD) or null. */
  nextInspectionDate: string | null;
  /**
   * Where this tree record came from: "manual" (dropped by the team)
   * or "Denver public record" (imported from the public tree
   * inventory — see publicRecordTrees.ts). Public-record trees carry
   * a siteId from the city's inventory.
   */
  source: "manual" | "Denver public record";
  /** City inventory site ID for public-record trees, else null. */
  siteId: string | null;
}

/**
 * Private notes on a customer. Two kinds:
 * - "admin": visible only to the Owner (admin) viewer.
 * - "personal": visible only to the note's author.
 * The role switcher is the stand-in for the viewer in this prototype,
 * so the author is the viewer identity at creation time (see store).
 */
export type PrivateNoteKind = "admin" | "personal" | "team";

export interface PrivateNote {
  id: string;
  customerId: string;
  kind: PrivateNoteKind;
  author: string;
  createdAt: string; // ISO timestamp
  text: string;
}

export interface CrewMember {
  id: string;
  name: string;
  role: string; // job role, e.g. "Foreman", "Climber"
  phone: string;
  color: string;
  /** Login role for the app: who this person is inside the system. */
  appRole: Role;
  email: string;
  /**
   * Supabase Auth user id for this crew member, when linked. The app
   * matches a signed-in user to their crew record by this id first,
   * then by login email. Added by migration 002; absent on databases
   * that have only run the original schema, where email matching still works.
   */
  authUserId?: string | null;
  /**
   * Onboarding state. "active" = full team member; "pending" = signed
   * up in the app and waiting for an owner to approve them (no data
   * access yet — they have no membership row); "revoked" = access
   * removed by an owner. Added by migration 006; rows created before
   * it read as "active".
   */
  status?: "pending" | "active" | "revoked";
  /**
   * Personal message intro, written by this person themselves. It
   * autofills the message composer when they write to a customer
   * (see src/messages.ts). Blank = the default intro is used.
   * Only the owner of the intro may edit it; admins can view it
   * but the UI never lets them overwrite someone else's.
   */
  messageIntro?: string;
  /**
   * Employment classification: W-2 employee or 1099 contractor.
   * Owner-only, like pay. Null = not set yet. (Migration 011.)
   */
  employmentType?: "w2" | "1099" | null;
  /**
   * How this person is paid: hourly, a flat day rate, or a percentage
   * of the job's value. The amount lives in payAmount. Null = not set
   * — those hours fall back to the job's labor rate (default $75/hr).
   * Owner-only. (Migration 011.)
   */
  payType?: "hourly" | "day" | "percent" | null;
  /** The pay amount: $/hr, $/day, or % of the job value, per payType. */
  payAmount?: number | null;
  /** Paid a fixed number of hours each week (e.g. Sam: 32); the weekly pay view uses it instead of clocked hours. */
  fixedWeeklyHours?: number | null;
  /** Added to every job's planned labor cost (office overhead, e.g. Sam). */
  countedOnEveryJob?: boolean;
  /**
   * Weekdays (0 = Sunday … 6 = Saturday) this person is generally
   * available to work. The crew suggestion prefers these days, and
   * scheduling someone on a day outside this list warns that they
   * are usually not available that day (overridable). Null/undefined
   * = available every day. (Migration 020.)
   */
  availableWeekdays?: number[] | null;
  /**
   * Equipment ids this person can drive / transport (checked off on
   * their profile). The crew suggestion assigns a driver for each
   * piece of equipment on the job from the suggested crew.
   * (Migration 020.)
   */
  canDriveEquipment?: string[] | null;
  /**
   * Crew ids this person works well with — typical groupings. The
   * crew suggestion prefers keeping these people together.
   * (Migration 020.)
   */
  worksWellWith?: string[] | null;
  /**
   * Per-user visibility permissions, set by the owner on the Users
   * page. Each is an override of the role default (owner/office see
   * everything; crew see only their own jobs and no money). Undefined
   * = use the role default. (Migration 020.)
   */
  permissions?: CrewPermissions | null;
  /**
   * Skill ids this person holds (see src/skills.ts), ticked by an owner
   * or manager on the Users page. Empty = none recorded yet.
   */
  skills?: string[];
  /** Holds a valid driver's licence. Driving needs this AND companyInsured. */
  driverLicensed?: boolean;
  /** Listed on the company vehicle insurance. */
  companyInsured?: boolean;
  /** Commercial licence class: none, B or A (A tows over 26,001 lb combined). */
  cdlClass?: "none" | "B" | "A";
  /** Only called in when a job would otherwise go unfilled (e.g. an occasional contractor). */
  lastResort?: boolean;
  /** Prefers to drive their own truck; ownTruckId names it in Equipment. */
  prefersOwnTruck?: boolean;
  ownTruckId?: string | null;
}

/**
 * Per-user visibility permissions (owner-set on the Users page).
 * - seeAllCustomers: see the whole customer list, or only the
 *   customers of jobs assigned to them.
 * - seeMoney: see dollar values anywhere in the app.
 * - seeAllJobs: see every job on the schedule, or only jobs they
 *   are assigned to.
 */
export interface CrewPermissions {
  seeAllCustomers?: boolean;
  seeMoney?: boolean;
  seeAllJobs?: boolean;
  /**
   * Whether this person may message customers. Explicit true/false
   * wins; undefined = off. Owner-set on the Users page. Lives in
   * the permissions JSONB (migration 020) — no new column.
   */
  canMessageCustomers?: boolean;
  /**
   * Whether this person may clock in manually / enter hours by hand.
   * Explicit true/false wins; undefined = owners and managers only. Everyone else must tap Clock in at the job.
   * Owner-set on the Users page. Lives in the permissions JSONB
   * (migration 020) — no new column.
   */
  canManualClockIn?: boolean;
  /**
   * Hide this person from the schedule, crew pickers and crew
   * suggestions (e.g. an office-only person, or a second login for
   * someone already on the roster). Their login and access are not
   * affected. Undefined = shown.
   */
  hideFromSchedule?: boolean;
}

export interface Job {
  id: string;
  customerId: string;
  serviceType: ServiceType;
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  status: JobStatus;
  /**
   * The crew assigned to this job — any number of people, or an empty
   * array = unassigned. A job can have several people on it, and a
   * crew member's day may hold many jobs; the schedule stacks them in
   * that person's day cell. (Round 2 briefly used a single assignee;
   * the user reversed that rule: jobs are multi-crew again.)
   */
  crewIds: string[];
  notes: string;
  /**
   * Notes for the customer — shown on the customer-facing side (portal /
   * estimate / invoice). The crew and office both see them too.
   */
  customerNotes: string;
  /**
   * Private notes for the team — the crew sees these on the job and in
   * the day briefing. Never shown to the customer.
   */
  teamNotes: string;
  /**
   * Private notes for the office — owners and office staff only; the
   * crew never sees these.
   */
  officeNotes: string;
  /**
   * ANSI A300 prune class for this job ("1" fine, "2" standard,
   * "3" hazard, "4" crown reduction). Null = not a pruning job or not
   * set. The crew's day briefing shows the definition for the class.
   */
  pruneClass: "1" | "2" | "3" | "4" | null;
  /**
   * The estimator's approximate hours for the job (sales estimate, not the
   * clocked timesheet). Null = not estimated yet.
   */
  estimatedHours: number | null;
  estimateId: string | null;
  invoiceId: string | null;
  /**
   * Which of the customer's addresses this job is at. Null = not
   * chosen yet (or the customer has only one address, so there is
   * nothing to choose). Jobs created before this field existed, and
   * jobs from estimates, land with null and the scheduler picks the
   * address on first edit.
   */
  addressId?: string | null;
  /**
   * Manual job value in dollars. Shown on the schedule only when the
   * job has no linked invoice or estimate; null = none set (no amount
   * is shown rather than an invented number).
   */
  value: number | null;
  /**
   * How this job is billed. "flat" = the manual value (or the linked
   * invoice/estimate, per the shared value rule); "hourly" = the
   * hourly rate × estimated hours, which slots into the same rule
   * below the invoice and above the estimate. Null = flat. The
   * hourly rate lives in hourlyRate; hours come from estimatedHours.
   * (Migration 022.)
   */
  billingType?: "flat" | "hourly" | null;
  /** $/hour when billingType is "hourly". Null = not set. (Migration 022.) */
  hourlyRate?: number | null;
  /**
   * Set when a Climber changed the price (change_job_price, migration
   * the "money fixes" rules): the price the job had before, shown struck
   * through. While set, the job's own price replaces its estimate's
   * (business rule). Set by the database only; never saved by the
   * app's job save. Null = the price was never replaced.
   */
  replacedPrice?: number | null;
  /** Trees this job is for (tree-linked jobs). */
  treeIds: string[];
  /** Equipment assigned to this job (chipper, trucks, trailers). */
  equipmentIds: string[];
  /**
   * Who drives each piece of equipment on this job: equipment id ->
   * crew id. Set by the crew suggestion or picked by hand in the job
   * editor. Internal only. (Migration 020.)
   */
  equipmentDrivers?: Record<string, string> | null;
  /** Plan board: when each person gets here ("HH:MM"), crew id -> time. Null = everyone at startTime. */
  crewArrivals?: Record<string, string> | null;
  /** The customer was promised this start time: the plan board never moves it. */
  timePromised?: boolean;
  /**
   * How many people the job is expected to take — from the estimate
   * the estimator wrote, or set here. Internal only, never shown to the
   * customer. The crew suggestion never suggests more than this.
   * Null = not set (no cap). (Migration 020.)
   */
  expectedCrew?: number | null;
  /** Last day of a multi-day job (YYYY-MM-DD). Null = single day. */
  endDate: string | null;
  /** Recurring service cadence, or null for one-off jobs. */
  recurring: "weekly" | "monthly" | "seasonal" | null;
  /** Last date a recurring service repeats (YYYY-MM-DD) or null. */
  recurringUntil: string | null;
  /** Materials cost for this job in dollars (job costing). */
  materialsCost: number | null;
  /** Other direct costs (e.g. crane rental, permits) in dollars. */
  otherCost: number | null;
  /** Crew labor rate in $/hour used for job costing. Null = default. */
  laborRate: number | null;
  /**
   * Drop-a-pin location (WGS84). A job can be located by a GPS pin
   * instead of, or in addition to, a street address — for work in a
   * random field with no address. Null = no pin dropped; the job then
   * uses the customer's address. "Send to crew" builds a Google Maps
   * link from this pin.
   */
  lat: number | null;
  lng: number | null;
}

/** One piece of company equipment assignable to jobs. */
export type EquipmentKind =
  | "Chipper"
  | "Truck"
  | "Trailer"
  | "Dump trailer"
  | "Equipment trailer"
  | "Mini skid"
  | "Stump grinder"
  | "Other";
export type EquipmentStatus = "available" | "in_shop" | "retired";

export interface Equipment {
  id: string;
  name: string;
  kind: EquipmentKind;
  /** Free-text details (e.g. "Bandit 15XP, 2021"). */
  details: string;
  status: EquipmentStatus;
  /**
   * Quick field report: true = the machine is down (red), false/null
   * = operational (green). Null/absent reads as operational. This is
   * separate from `status` (Available / In the shop / Retired) — a
   * machine can break down in the field without being in the shop.
   * Anyone on the team can flip it, groundsmen included: the crew
   * are the ones who discover a breakdown.
   */
  down?: boolean | null;
  /**
   * Trucks: equipment ids this truck can tow (trailers, chipper). Null
   * = not set yet (the scheduler assumes it can tow any of them).
   */
  tows?: string[] | null;
  /** Seats in the cab (trucks). Null = not set. */
  seats?: number | null;
  /** Weight in lb (GVWR for trucks, loaded weight for trailers/chipper). Over 26,001 lb combined needs a CDL Class A driver. */
  weightLbs?: number | null;
  /** Most times one person may drive this in a week (Big Truck = 1). A second time only when nothing else works, flagged. Null = no limit. */
  weeklyDriverLimit?: number | null;
  /** Shop where it is parked (a company site's address). Null = not set. */
  homeSite?: string | null;
}

/** True when the machine is marked down; null/absent means operational. */
export function isEquipmentDown(eq: Equipment): boolean {
  return eq.down === true;
}

/** One recurring maintenance job for a piece of equipment, e.g. "Oil change" every 90 days. The interval is changeable in Equipment → Settings. */
export interface MaintenanceTask {
  id: string;
  equipmentId: string;
  name: string;
  /** Days between services. */
  intervalDays: number;
}

/** One logged service: a task done on a date, with who did it. */
export interface MaintenanceRecord {
  id: string;
  taskId: string;
  date: string;
  /** Optional hour-meter reading at service (chipper/truck hours). */
  hours: number | null;
  notes: string;
  /** Crew id of who logged it (null when unknown). */
  doneBy: string | null;
}

/**
 * A note left on a piece of equipment, like a text message on it —
 * "chipper is making a grinding noise", "tire looks low". Anyone on
 * the team can leave one, including groundsmen (the usual edit gate
 * does not apply); the author and time travel with the note.
 */
export interface EquipmentNote {
  id: string;
  equipmentId: string;
  authorId: string; // crew member id (or "owner" fallback)
  authorName: string;
  text: string;
  createdAt: string; // ISO timestamp
}

/** Plant Health Care program types (PHC). */
export type PhcProgramType =
  | "EAB treatment"
  | "Fertilization"
  | "Disease care"
  | "Other";
export type PhcProgramStatus = "active" | "paused" | "completed";

/** A recurring plant health care program for a customer (and tree). */
export interface PhcProgram {
  id: string;
  customerId: string;
  /** Tree the program treats, when it is tree-specific. Null = whole property. */
  treeId: string | null;
  name: string;
  type: PhcProgramType;
  status: PhcProgramStatus;
  /** First visit date (YYYY-MM-DD). */
  startDate: string;
  /** Renewal date (YYYY-MM-DD) or null. Drives renewal reminders. */
  renewalDate: string | null;
  /** Months between scheduled visits (e.g. 6 = spring + fall). */
  visitIntervalMonths: number;
  notes: string;
}

/** One scheduled or completed visit in a PHC program. */
export type PhcVisitStatus = "scheduled" | "done" | "skipped";

export interface PhcVisit {
  id: string;
  programId: string;
  date: string; // YYYY-MM-DD
  status: PhcVisitStatus;
  notes: string;
}

/** One chemical application record (compliance documentation). */
export interface ChemicalRecord {
  id: string;
  programId: string;
  date: string; // YYYY-MM-DD
  /** Product applied (e.g. "Tree-äge (emamectin benzoate)"). */
  product: string;
  /** Application rate (e.g. "4 ml per inch DBH"). */
  rate: string;
  /** Crew member who applied it. */
  applicator: string;
  notes: string;
}

/**
 * A crew member's time-off request. Dates are inclusive — a request
 * from Mon to Fri blocks the whole week. The crew member requests it
 * from their Today view; an owner approves or denies it from the
 * Schedule page. Approved time off shows on the calendar and warns
 * anyone assigning that person to a job on those days.
 */
export interface TimeOffRequest {
  id: string;
  crewId: string;
  /** First day off, YYYY-MM-DD. */
  startDate: string;
  /** Last day off, YYYY-MM-DD (inclusive). */
  endDate: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  /** Day the request was made, YYYY-MM-DD. */
  requestedAt: string;
  /** Name of the owner who decided it, or null while pending. */
  decidedBy: string | null;
  /** Day it was decided, YYYY-MM-DD, or null while pending. */
  decidedAt: string | null;
}

/**
 * A day the business is closed to bookings — shown on the Schedule as
 * "Business closed" and hidden from the public booking page. Owners
 * mark and reopen days from the Schedule.
 */
export interface ClosedDay {
  /** The closed date, YYYY-MM-DD. Also the record's id. */
  date: string;
  /** Why it's closed (holiday, company day off, weather, …). */
  reason: string | null;
  /** Crew id of the owner who marked it, if known. */
  createdBy: string | null;
}

/**
 * A booking request from the public website: someone asking for an
 * estimate visit on a day the business is open. Lands on the Sales
 * page; the estimator accepts it (creates a draft estimate) or declines it.
 */
export interface BookingRequest {
  id: string;
  /** The day they asked for, YYYY-MM-DD. */
  date: string;
  name: string;
  phone: string;
  email: string | null;
  address: string;
  /** What they need done, in their words. */
  details: string;
  status: "pending" | "accepted" | "declined";
  /** Day the request came in, YYYY-MM-DD. */
  requestedAt: string;
  /** Estimate created when the request was accepted, if any. */
  estimateId: string | null;
}

export interface EstimateLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  /** Tree this line is for, when the line is tree-specific. */
  treeId?: string | null;
}

/** One option in a multi-option proposal (Good / Better / Best). */
export interface ProposalOption {
  id: string;
  /** Option label, e.g. "Good", "Better", "Best". */
  label: string;
  /** What this option includes (e.g. "Prune only"). */
  description: string;
  lines: EstimateLine[];
}

export type DiscountType = "none" | "percent" | "fixed";

export interface Estimate {
  id: string;
  customerId: string;
  jobId: string | null;
  title: string;
  lines: EstimateLine[];
  taxRate: number; // percent, e.g. 0
  discountType: DiscountType;
  discountValue: number; // percent (0-100) or fixed dollars, by discountType
  status: EstimateStatus;
  createdDate: string;
  notes: string;
  /**
   * Email queue state. Null = never queued. A timestamp = the estimate
   * was queued for sending (preview only — no real email leaves this
   * prototype; real delivery starts when Gmail is connected in Phase 2).
   */
  emailQueuedAt: string | null;
  /**
   * Multi-option proposal options (Good / Better / Best). When present
   * and non-empty, the estimate is a multi-option proposal; `lines`
   * holds the default (Better) option's lines so single-option code
   * keeps working. The accepted option's lines are the ones billed.
   */
  options?: ProposalOption[] | null;
  /** Id of the option the customer accepted, or null. */
  acceptedOptionId?: string | null;
  /** Name typed by the customer when accepting (preview e-sign). */
  acceptedBy?: string | null;
  /** ISO timestamp the customer accepted (preview e-sign). */
  acceptedAt?: string | null;
  /**
   * How many people the estimator expects the job to take, set while writing
   * the quote. Internal only — never shown to the customer, never in
   * the sent estimate or the portal. The crew suggestion never
   * suggests more than this. Null = not set (no cap). (Migration 020.)
   * Kept as the total: the named people when names were picked, else
   * expectedClimbers + expectedGroundsmen (see src/estimateCrew.ts).
   */
  expectedCrew?: number | null;
  /**
   * The estimator's generic crew ("1 climber, 2 groundsmen"). Internal
   * only. When set, it is the job's crew requirement in the crew
   * suggestion instead of the crew rules. Null = not set.
   * (The "estimate equipment and crew" rules.)
   */
  expectedClimbers?: number | null;
  expectedGroundsmen?: number | null;
  /**
   * Named crew the estimator expects on the job (crew ids). Internal
   * only. They go on the job when it is scheduled on a day, minus
   * anyone off or unavailable that day. (The "estimate equipment and crew" rules.)
   */
  expectedCrewIds?: string[] | null;
  /**
   * Equipment the job needs (equipment ids). Internal only, never
   * shown to the customer; copied onto the job when it is made.
   * (The "estimate equipment and crew" rules.)
   */
  equipmentIds?: string[] | null;
  /**
   * The estimator's estimate visit — the day and time they go to look at the
   * property and write the quote. Set from the Sales tab's suggestion
   * ("Schedule it"), not a job: the visit is sales work, the job
   * comes later from the Schedule page. Null until scheduled.
   * (Migration 024.)
   */
  visitDate?: string | null;
  visitTime?: string | null;
  /**
   * Roster card (crew id) of the person who wrote the estimate. Set by
   * the database when the estimate is added, from the signed-in login's
   * own card, and never changed afterwards (the "sales access refine" rules);
   * the app never sends it. Null for estimates added before that.
   */
  createdByCrewId?: string | null;
}

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

/**
 * One bill-to recipient on a split invoice. The split is either a
 * percentage of the invoice total or a fixed dollar amount; the
 * recipient's share is computed from the invoice total, and payment
 * is tracked per recipient (paid / paidDate). An invoice with an
 * empty splits array is a plain single-recipient invoice — billed to
 * the customer in full, exactly as before split invoicing existed.
 */
export interface InvoiceSplit {
  id: string;
  recipientName: string;
  recipientEmail: string;
  kind: "percentage" | "fixed";
  /** Percent (0–100) when kind is percentage, dollars when fixed. */
  value: number;
  paid: boolean;
  paidDate: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  jobId: string | null;
  estimateId: string | null;
  lines: InvoiceLine[];
  taxRate: number;
  discountType: DiscountType;
  discountValue: number; // percent (0-100) or fixed dollars, by discountType
  status: InvoiceStatus;
  issuedDate: string;
  dueDate: string;
  paidDate: string | null;
  /** How the customer paid — Zelle / check / cash. Null = not recorded (never guessed). */
  paymentMethod: PaymentMethod | null;
  /** Same queue semantics as Estimate.emailQueuedAt. */
  emailQueuedAt: string | null;
  /** Bill-to recipients. Empty = single recipient (the customer). */
  splits: InvoiceSplit[];
  /**
   * Set only by the database (the "done creates invoice" rules), never saved by
   * the app: the invoice was made when its job was marked done, and its
   * automatic email. "waiting" = emailed after autoSendAt (the 2-hour
   * grace period) unless stopped; "stopped" says why in autoSendNote.
   */
  autoCreated?: boolean;
  autoSendAt?: string | null;
  autoSendStatus?: "waiting" | "sending" | "sent" | "stopped" | null;
  autoSendNote?: string | null;
  autoSentAt?: string | null;
  /**
   * When the invoice was REALLY emailed (send-invoice or the automatic
   * "Done" email). Set only by the database, never saved by the app;
   * emailQueuedAt is not proof of a send (older builds wrote it alone).
   */
  emailedAt?: string | null;
}

export interface TimesheetEntry {
  id: string;
  crewId: string;
  jobId: string | null; // null = shop / yard time
  date: string; // YYYY-MM-DD
  clockIn: string | null; // HH:MM
  clockOut: string | null; // HH:MM
  hours: number | null; // manual hours when no clock times are used
  notes: string;
  /** Typed location for this entry (job site address or shop/yard). */
  location: string;
  /**
   * The clock-out was set to 20:00 by the 8 PM rule, not tapped
   * (the "crew day and 8pm clockout" rules). Set by the database only; never saved
   * from the app.
   */
  autoClosed?: boolean;
}

/**
 * One email conversation thread per customer. Every estimate, invoice,
 * and reminder for a customer reuses that customer's current thread, so
 * follow-ups land in the same conversation instead of starting new
 * threads. A thread expires after one year: the next send after that
 * starts a fresh thread.
 */
export interface EmailThread {
  id: string;
  customerId: string;
  createdAt: string; // ISO date (YYYY-MM-DD) the thread started
}

/**
 * One customer message in the shared Communications thread. Messages
 * live in the shared database (Phase 2) / shared app state (preview),
 * never on one person's phone: every company member sees the same
 * chronological thread per customer, like a groupchat on the team
 * side. The customer only ever sees the central number
 * (see CENTRAL_SMS_NUMBER in src/messages.ts) for SMS — never a crew
 * member's personal phone.
 */
export type MessageChannel = "sms" | "email" | "call";
export type MessageDirection = "in" | "out";

export interface Message {
  id: string;
  customerId: string;
  /** Linked job, when the message is about one. Null = no job link. */
  jobId: string | null;
  /** Linked estimate, when the message is about one. Null = none. */
  estimateId?: string | null;
  channel: MessageChannel;
  /** "out" = the team sent it; "in" = the customer replied. */
  direction: MessageDirection;
  /** Crew member who sent it (outbound). Empty for inbound messages. */
  senderCrewId: string;
  /** Display name of the sender (outbound) or the customer (inbound). */
  senderName: string;
  body: string;
  createdAt: string; // ISO timestamp
  /**
   * Number the SMS was sent from (outbound) or sent to (inbound).
   * Always the central number for SMS; null for email / call.
   */
  fromNumber: string | null;
  /** The customer's email thread this message belongs to, if any. */
  threadId: string | null;
  /**
   * True when this message was only queued in the preview (no real
   * SMS/email left the app). Seed history is not queued; only messages
   * sent from the composer in this preview are.
   */
  queued?: boolean;
}

/**
 * One field-level audit record. EVERY mutation in the app appends one
 * record per changed field — including tiny edits like changing a
 * quantity from 1 to 2 — with who did it and when.
 */
export interface AuditEntry {
  id: string;
  timestamp: string; // ISO timestamp
  actor: string; // viewer identity at the time (role / crew member name)
  entity: string; // e.g. "Customer", "Job", "Estimate", "Invoice", "Timesheet", "Note", "User", "Automation"
  entityId: string;
  entityLabel: string; // human-readable label, e.g. customer name or invoice number
  field: string; // field name, or "(created)" / "(deleted)"
  oldValue: string;
  newValue: string;
  customerId: string | null; // owning customer, for the customer activity timeline
  /**
   * Owning job, for the per-job activity section and the Activity page
   * job filter. Set on every entry that touches a job (job edits,
   * linked estimate/invoice changes, timesheet entries for the job).
   * Entries recorded before this field existed simply lack it.
   */
  jobId?: string | null;
}

/** Configurable automation rule. Rules never send anything in this preview. */
export type AutomationKind =
  | "invoice_reminder"
  | "review_request"
  | "estimate_reminder"
  | "thank_you"
  | "job_reminder"
  | "overdue_escalation"
  | "phc_renewal"
  | "invoice_send";

export interface AutomationRule {
  id: string;
  kind: AutomationKind;
  label: string;
  description: string;
  enabled: boolean;
  /** Days offset for the rule (meaning depends on the rule; see description). */
  timingDays: number;
  /** Message template. Placeholders: {customer}, {amount}, {title}, {date}. */
  template: string;
}

/**
 * The business this copy of the app serves — filled in by the
 * first-run setup wizard (see src/components/SetupWizard.tsx), which
 * asks for it before the app can be used. Null until the wizard is
 * completed. Everything in the app that names the business, the
 * number customers text, the clock-in shop/yard spots, or how
 * customers pay reads from here (see src/company.ts), so there is
 * exactly one place to change it: Schedule → Calendar settings →
 * Company.
 */
export interface CompanySite {
  /** Short label shown on clock-in ("Shop", "Yard"). */
  label: string;
  /** Street address, as typed in the wizard. */
  address: string;
  /** Geocoded position; null when the address could not be placed. */
  lat: number | null;
  lng: number | null;
}

export interface CompanyProfile {
  /** Business name, shown in the header and on estimates/invoices. */
  name: string;
  /** Business phone, shown to customers (booking page, etc.). */
  phone: string;
  /** Business email. */
  email: string;
  /**
   * The number customers get texts from. Often the same as the
   * business phone; blank = fall back to the business phone.
   */
  smsNumber: string;
  /** Logo uploaded in the wizard, as a data URL; null = generic mark. */
  logoDataUrl: string | null;
  /** The owner login's email (the first account created in the app). */
  ownerEmail: string;
  /** Shop/yard spots clock-in opens near (0.25 mi). May be empty. */
  sites: CompanySite[];
  /** Zelle number customers are told to pay (optional). */
  zelleNumber: string;
  /** Who checks are made out to — usually the business name. */
  checkPayee: string;
  /** Where checks are mailed (optional). */
  checkMailingAddress: string;
  /**
   * "Review link (Google)" from Invoice settings: the "Review us" button
   * in an invoice email the sender chose to ask for a review in. Blank =
   * no review button can be added. Never sent automatically.
   */
  reviewUrl?: string;
}

export interface AppSettings {
  /** Auto clock-in/out by location. Preview-only toggle: live detection is Phase 2. */
  autoClock: boolean;
  /**
   * The business this copy serves — set once by the first-run setup
   * wizard, editable later in Schedule → Calendar settings → Company.
   * Null until the wizard is completed; the app shows the wizard
   * instead of the schedule while it is null.
   */
  company?: CompanyProfile | null;
  /**
   * Desired booked $ for each day. 0 = no target set. Once a day's booked
   * total reaches it, the day total on the calendar turns red (day is full).
   */
  dailyTarget: number;
  /**
   * Suggest a day for newly approved estimates (by target room + proximity
   * to other jobs that day), shown in the "To schedule" rail.
   */
  suggestDays: boolean;
  /**
   * Suggestion rules (Calendar settings). A suggested day only counts
   * when the nearest job that day is within this many minutes' drive
   * and this many road miles, and the day's booked total plus this job
   * exceeds the daily target by at most suggestMaxOver. 0 minutes or
   * 0 miles = no limit on that one; 0 over = the target is a hard cap.
   * Defaults: 30 minutes, 5 miles, $0 over.
   */
  suggestMaxMinutes?: number;
  suggestMaxMiles?: number;
  suggestMaxOver?: number;
  /**
   * Suggestion rules: never suggest a Saturday/Sunday, and never
   * suggest a federal holiday. Both default to true.
   */
  suggestSkipWeekends?: boolean;
  suggestSkipHolidays?: boolean;
  /** Hovering a day on the calendar pops its route map up on the left. */
  hoverRoute: boolean;
  /** Show the booked $ total at the bottom of each day cell. */
  showDayTotals: boolean;
  /**
   * Default payment terms for commercial invoices, in days.
   * 30 = Net 30. 0 = due on receipt. New invoices auto-populate
   * their due date from this (issued date + terms).
   */
  commercialTermsDays: number;
  /**
   * Default payment terms for residential invoices, in days.
   * 0 = due on receipt. New invoices auto-populate their due date
   * from this (issued date + terms).
   */
  residentialTermsDays: number;
  /**
   * Crew-suggestion rules, edited on the Crew Rules page (owner).
   * Each rule names the crew a job needs when its condition matches;
   * the suggestion takes the most crew any matching rule asks for,
   * then caps at the job's expected crew. Null = use the built-in
   * defaults. (Migration 020.)
   */
  crewRules?: CrewRule[] | null;
  /** Auto-scheduler settings, including the owner's skill list. Null = defaults. */
  planner?: PlannerSettings | null;
  /**
   * Master switch "Automatic customer emails" (Automations page).
   * Default off: nothing emails customers until an owner/manager turns
   * it on. Missing = off.
   */
  autoEmails?: boolean;
  /**
   * Day ("YYYY-MM-DD") the master switch was last turned on, set by
   * the database. Only things that come due from then on are emailed.
   * Read-only for the app.
   */
  autoEmailsSince?: string | null;
}

/**
 * One crew-suggestion rule. The condition picks which jobs it
 * applies to; climbers/groundsmen say how many of each the job
 * needs. Conditions:
 * - pruneClass: the job's ANSI prune class is this value.
 * - minTrees: the job is for at least this many trees.
 * - serviceType: the job's service type is this value.
 * - keyword: the job's title or notes contain this word (e.g.
 *   "wires", "backyard") — matched case-insensitively.
 * - dayJobs: the number of jobs on that day meets the comparison
 *   (exactly / at most / at least this many) — e.g. "exactly 1
 *   job that day".
 * - minValue: the job's value under the shared jobValue rule
 *   (invoice → estimate → manual value) is at least this many
 *   dollars. A job with no value never matches.
 * - equipment: the job uses this piece of equipment (by id). If
 *   the equipment item no longer exists, the rule never matches.
 * - always: applies to every job (the fallback rule).
 *
 * When allAvailable is true, a matching rule means "assign every
 * available crew member that day" instead of the fixed
 * climbers/groundsmen numbers (the numbers are ignored).
 */
export type CrewRuleCondition =
  | { kind: "pruneClass"; value: "1" | "2" | "3" | "4" }
  | { kind: "minTrees"; value: number }
  | { kind: "serviceType"; value: ServiceType }
  | { kind: "keyword"; value: string }
  | {
      kind: "dayJobs";
      operator: "exactly" | "at most" | "at least";
      count: number;
    }
  | { kind: "minValue"; value: number }
  | { kind: "equipment"; value: string }
  | { kind: "always" };

export interface CrewRule {
  id: string;
  name: string;
  condition: CrewRuleCondition;
  climbers: number;
  groundsmen: number;
  /** When true, a matching rule assigns everyone available that day. */
  allAvailable?: boolean;
  /** Disabled rules are kept but never match. */
  enabled?: boolean;
}

/**
 * One named day crew: a group of crew members working together on
 * one date. A shortcut group, NOT a change to jobs — applying a crew
 * to a job sets that job's crewIds to the crew's members. The
 * suggestion (suggestDayCrews) proposes up to two crews for a day;
 * the office edits them on the Schedule day detail. (Migration 021.)
 */
export interface DayCrew {
  id: string;
  /** YYYY-MM-DD the crew works together. */
  date: string;
  name: string;
  memberIds: string[];
}

/**
 * A crew member marked unavailable for a stretch of days, by an
 * owner/manager from the Schedule roster (right-click). Dates are
 * inclusive — a span from Mon to Fri blocks the whole week. Unlike
 * time off, there is no request/approval flow: it takes effect the
 * moment it is saved. Unlike availableWeekdays (which weekdays they
 * normally work), this is a one-off date range. (Migration 026.)
 */
export interface UnavailabilitySpan {
  id: string;
  crewId: string;
  /** First day unavailable, YYYY-MM-DD. */
  startDate: string;
  /** Last day unavailable, YYYY-MM-DD (inclusive). */
  endDate: string;
}

/** What a licence / insurance document is (company_documents.kind). */
export type CompanyDocumentKind =
  | "business_licence"
  | "arborist_certification"
  | "liability_insurance"
  | "workers_comp"
  | "auto_insurance"
  | "other";

/**
 * A licence, certificate or insurance policy on the Licences &
 * insurance screen (company_documents). The uploaded PDF or photo is
 * stored apart (company_document_files) and loaded only when opened.
 * Staff only: crew never receive these rows.
 */
export interface CompanyDocument {
  id: string;
  kind: CompanyDocumentKind;
  /** Name or number, e.g. "Policy GL-12345". */
  name: string;
  /** Who it is for: null = the business, else a crew card id. */
  crewId: string | null;
  issuer: string;
  /** YYYY-MM-DD, or null when not known. */
  startDate: string | null;
  /** YYYY-MM-DD, or null when it does not expire. */
  expiryDate: string | null;
  notes: string;
  /** The uploaded file's id (company_document_files), or null. */
  fileId: string | null;
  fileName: string;
  createdAt: string;
}

export interface AppState {
  customers: Customer[];
  crew: CrewMember[];
  jobs: Job[];
  estimates: Estimate[];
  invoices: Invoice[];
  timesheets: TimesheetEntry[];
  notes: PrivateNote[];
  threads: EmailThread[];
  /** Shared customer messages — one thread per customer (see Message). */
  messages: Message[];
  auditLog: AuditEntry[];
  automations: AutomationRule[];
  settings: AppSettings;
  trees: Tree[];
  /** Company equipment assignable to jobs. */
  equipment: Equipment[];
  /** Recurring maintenance schedules, one per equipment task. */
  maintenanceTasks: MaintenanceTask[];
  /** Logged maintenance services, newest by date. */
  maintenanceRecords: MaintenanceRecord[];
  /** Notes left on equipment by the team, like texts on the machine. */
  equipmentNotes: EquipmentNote[];
  /** Plant Health Care programs (recurring care). */
  phcPrograms: PhcProgram[];
  /** Scheduled/completed visits inside PHC programs. */
  phcVisits: PhcVisit[];
  /** Chemical application records for PHC compliance. */
  chemicalRecords: ChemicalRecord[];
  /** Time-off requests from the crew; owners approve or deny them. */
  timeOff: TimeOffRequest[];
  /** Days the business is closed to bookings. */
  closedDays: ClosedDay[];
  /** Estimate-visit requests from the public booking page. */
  bookingRequests: BookingRequest[];
  /** Named day crews: groups of members working together on a date. */
  dayCrews: DayCrew[];
  /**
   * Owner-marked unavailability spans: a crew member out for a
   * stretch of days, set from the Schedule roster. Excludes them
   * from crew suggestions on those days, like approved time off.
   * (Migration 026.)
   */
  unavailability: UnavailabilitySpan[];
  /**
   * The whole calendar, calendar details only (calendar_jobs()): every
   * booked job's date, time, title, type, status, crew and town, for
   * every team member. Read-only, never saved. Jobs the person can see
   * in full are in `jobs`; this fills in the rest of the calendar.
   */
  calendarJobs?: CalendarJob[];
  /**
   * On-demand location requests ("Where is my crew"): one row per
   * person pinged, so a ping can be answered person by person.
   * targetCrewId null = everyone (kept for robustness; the UI pings
   * named people). (Migration 022.)
   */
  locationRequests: LocationRequest[];
  /** One shared location point per tap — never continuous tracking. */
  crewLocations: CrewLocation[];
  /**
   * Suggested customer changes (the "customer edit requests" rules): a Sales
   * login's own, or every one for office staff. Read-only here; sent
   * and decided through the store's suggest/approve/decline actions,
   * never through the whole-state save.
   */
  customerEditRequests?: CustomerEditRequest[];
  /**
   * Job price changes made through change_job_price (migration
   * the "climber price change notes" rules): every one for office staff, those of the jobs
   * they are on for a Climber. Read-only here; added and marked seen
   * through the store's actions, never through the whole-state save.
   */
  jobPriceChanges?: JobPriceChange[];
  /**
   * Licences & insurance (staff only; the "company documents" rules).
   * Optional so an offline copy saved by an older build still loads.
   */
  companyDocuments?: CompanyDocument[];
  /**
   * Equipment problem reports (the "equipment problems" rules): every one for
   * office staff, their own for crew. Read-only here; reported and
   * closed through the store's actions, never through the whole-state
   * save.
   */
  equipmentProblems?: EquipmentProblem[];
}

/** Where an equipment problem stands. */
export type EquipmentProblemStatus = "open" | "in_shop" | "fixed";

/**
 * One "Problem" report on a piece of equipment: a short text and an
 * optional photo (stored apart, loaded only when opened). Who reported
 * it and when are set by the database.
 */
export interface EquipmentProblem {
  id: string;
  equipmentId: string;
  note: string;
  status: EquipmentProblemStatus;
  hasPhoto: boolean;
  /** Crew card id of the reporter. */
  reportedBy: string | null;
  reportedName: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Who last changed the status, and when (ISO), or null. */
  statusByName: string | null;
  statusAt: string | null;
}

/**
 * One change of a job's price (billing, value, hourly rate), with the
 * reason the Climber gave (src/priceChange.ts). Who and when are set
 * by the database.
 */
export interface JobPriceChange {
  id: string;
  jobId: string;
  /** Crew id of the person who changed it. */
  changedBy: string | null;
  changedByName: string;
  /** Changed by the office, a manager or an owner (seen from the start). */
  byOffice: boolean;
  /** ISO timestamp. */
  changedAt: string;
  oldValue: number | null;
  newValue: number | null;
  oldHourlyRate: number | null;
  newHourlyRate: number | null;
  oldBillingType: string | null;
  newBillingType: string | null;
  reason: string;
  seenBy: string | null;
  seenAt: string | null;
}

/**
 * A change to a customer suggested by a Sales login, waiting for the
 * office (src/customerEdits.ts). `changes` holds only allow-listed
 * fields, keyed like the database (first_name, phone, street, ...).
 */
export interface CustomerEditRequest {
  id: string;
  customerId: string;
  /** Crew id of the person who suggested it. */
  requestedBy: string | null;
  requestedName: string;
  /** ISO timestamp. */
  createdAt: string;
  changes: Record<string, string>;
  note: string;
  status: "pending" | "approved" | "declined";
  decidedBy: string | null;
  decidedAt: string | null;
  /** Why the office declined it ('' when none given or not declined). */
  declineReason: string;
  /**
   * What the office applied when approving (the "customer edit followups" rules):
   * Pat's values, or the office's edited ones. Null until approved, and
   * on rows approved before that migration.
   */
  appliedChanges: Record<string, string> | null;
}

/**
 * One on-demand location request: the office asks where someone is.
 * The request is stored in the DB; the crew member answers by
 * opening the app and tapping Share. requestedAt is an ISO timestamp
 * (same convention as the audit log). (Migration 022.)
 */
export interface LocationRequest {
  id: string;
  /** Crew id of the person who asked. */
  requestedBy: string;
  requestedAt: string;
  /** Crew id of the person being asked, or null for everyone. */
  targetCrewId: string | null;
}

/**
 * One location point a crew member shared by tapping Share — one tap
 * = one point + time, never background or continuous tracking.
 * requestId links it to the request it answers (null = shared without
 * a request); jobId is the in-progress job they were on when they
 * shared, if any. recordedAt is an ISO timestamp. (Migration 022.)
 */
export interface CrewLocation {
  id: string;
  crewId: string;
  lat: number;
  lng: number;
  recordedAt: string;
  requestId: string | null;
  jobId: string | null;
}

/** Drafts kept apart from saved records so half-finished work survives. */
export type DraftMap = Record<string, unknown>;

/**
 * One rotating GPS ping for crew tracking (Phase 2). Written by the
 * mobile app while a crew member is clocked in on an assigned job; read
 * by the job map/timeline in a later step. Not part of AppState yet —
 * the adapter does not load or save pings; the table exists in
 * supabase/migrations so the tracking feature has somewhere to write.
 * timestamp is an ISO string in the app; the column is timestamptz.
 */
export interface GpsPing {
  id: string;
  jobId: string;
  crewId: string;
  timestamp: string; // ISO timestamp
  lat: number;
  lng: number;
}

/** One skill in the team's skill list (src/skills.ts). */
export interface SkillDef {
  id: string;
  label: string;
  group: string;
}

/** Auto-scheduler settings (settings.planner). Every field is optional: missing = default. */
export interface PlannerSettings {
  /** The owner's skill list; missing or empty = the starter catalog. */
  skillCatalog?: SkillDef[];
  /** Skill suggestions the owner dismissed ("crewId:skillId"); never shown again. */
  dismissedSkillSuggestions?: string[];
  // Day planner: src/planner/settings.ts holds the default for every key below.
  /** Longest drive between two consecutive stops of one crew, in minutes (default 30). Longer legs are allowed but flagged. */
  clusterMaxMinutes?: number;
  /** Leave-the-yard and finish times, "HH:MM" (defaults 07:00 and 17:00). */
  dayStart?: string;
  dayEnd?: string;
  /** Minutes added between stops (default 10). */
  travelBufferMin?: number;
  /** A crew may run this many minutes past dayEnd (flagged) before its lowest-value job is left off (default 30). */
  overrunToleranceMin?: number;
  /** Most crews the planner splits a day into (default 4). */
  maxCrews?: number;
  /** The shop drive times start and end at: a site's address (Calendar settings → Company). Missing = the first shop on the map. */
  yardSite?: string;
  /** Largest crew when Pat set no expected crew: extra people fill crews up to this, biggest jobs first (default 4). */
  maxCrewSize?: number;
  /** Weight of a crew's idle minutes against drive minutes, 0–1 (default 0.5). */
  idleWeight?: number;
  /** Hours a job takes when the estimate has none, per service type. */
  defaultHoursByService?: Partial<Record<ServiceType, number>>;
  /** Equipment kinds a job needs when none is set on the job, per service type. */
  defaultEquipmentByService?: Partial<Record<ServiceType, EquipmentKind[]>>;
  /** Skill ids every job of a service type needs, per service type. */
  defaultSkillsByService?: Partial<Record<ServiceType, string[]>>;
  /** Plan board: job value done per hour by a crew of up to fullSpeedCrew people (default $400). */
  dollarsPerHour?: number;
  /** Crew size at which dollarsPerHour applies; each person above it adds the same share (default 3). */
  fullSpeedCrew?: number;
  /** Fewest people the auto-fill sends to a job (default 2). */
  minTeam?: number;
  /**
   * Plan board: a different dollarsPerHour for some service types (e.g.
   * stump grinding goes faster). Missing = the overall dollarsPerHour.
   * Usually set by tapping Apply on a plan-board suggestion (src/planner/learn.ts).
   */
  dollarsPerHourByService?: Partial<Record<ServiceType, number>>;
  /** Plan-board suggestions the owner dismissed (keys from src/planner/learn.ts); never shown again. */
  dismissedPlanSuggestions?: string[];
  /** Plan board: email each crew member their day after "Save day" (default true; missing = on). */
  emailCrewOnSave?: boolean;
}

/** A job as the calendar shows it to someone who can't see the full job. */
export interface CalendarJob {
  id: string;
  date: string;
  endDate: string | null;
  startTime: string;
  title: string;
  serviceType: string;
  status: JobStatus;
  crewIds: string[];
  estimatedHours: number | null;
  /** The town (city) only. */
  area: string | null;
}
