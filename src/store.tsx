import { blockedLine, onlyAvailableAdded } from "./crewSuggest";
import { showFlash } from "./flash";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { applyAutoSendRules, jobsMarkedDone, reopenedJobWithAutoInvoice, stopAutoSend } from "./autoInvoice";
import type { ReactNode } from "react";
import type {
  AppSettings,
  AppState,
  AutomationRule,
  BookingRequest,
  ChemicalRecord,
  ClosedDay,
  CrewLocation,
  CrewMember,
  Customer,
  DayCrew,
  Equipment,
  EquipmentNote,
  CompanyDocument,
  Estimate,
  Invoice,
  Job,
  JobStatus,
  LocationRequest,
  MaintenanceRecord,
  MaintenanceTask,
  Message,
  MessageChannel,
  PaymentMethod,
  PhcProgram,
  PhcVisit,
  PrivateNote,
  Role,
  TimesheetEntry,
  TimeOffRequest,
  Tree,
  SkillDef,
  AuditEntry,
  PlannerSettings,
} from "./types";
import { skillCatalog } from "./skills";
import { planToJobPatches, type DayPlan } from "./planner";
import { boardPatchJob, keepArrivals } from "./planner/board";
import type { DataAdapter, SaveResult } from "./data/adapter";
import { planCreateEstimate, type CreateEstimateInput } from "./salesCalendar";
import { bookingCustomerDraft, bookingEstimate, bookingIsPending } from "./salesQueue";
import {
  applySuggestion,
  changesText,
  DECLINE_REASON_MAX,
  sanitizeChanges,
  type CustomerChanges,
} from "./customerEdits";
import {
  changeJobPriceRpc,
  decideCustomerEditRequest,
  insertCustomerEditRequest,
  markJobPriceChangeSeenRpc,
  clearReplacedPriceRpc,
  insertEquipmentProblem,
  resolveEquipmentProblemRpc,
} from "./data/supabaseAdapter";
import { uploadProblemPhoto } from "./data/problemPhotos";
import { isUnresolved, problemNoteProblem, statusAfter } from "./equipmentProblems";
import { priceChanged, priceOf, reasonOk, type JobPrice } from "./priceChange";
import { jobPriceBeforeChange } from "./jobValue";
import { notifySuggestion } from "./suggestionNotify";
import { adapter as defaultAdapter } from "./data/selectAdapter";
import { supabase } from "./data/supabaseClient";
import { clearLocalCompanyData } from "./data/localData";
import { supabaseConfig, supabaseConfigured } from "./config";
import { addDaysISO, fmtDate, termsLabel, todayStr, uid } from "./utils";
import { addressDisplay, customerAddresses } from "./addresses";
import { checkClockIn, type ClockInCheck } from "./geofence";
import { switchClock } from "./crewDay";
import {
  addFieldOp,
  applyFieldOp,
  applyFieldOps,
  fieldOpsSent,
  markTooOldTaps,
  sendableFieldOps,
  isNoSignalError,
  queuedFieldOps,
  selectFieldQueueUser,
  staleFieldOpIds,
  unsentTapsWarning,
  setFieldOpsState,
  type FieldOp,
} from "./fieldQueue";
import { readCurrentPosition } from "./location";
import {
  currentJobFor,
  openRequestsFor,
} from "./location";
import {
  appendAudit,
  createdEntry,
  deletedEntry,
  diffFields,
  diffLines,
  fmtVal,
  memberChangeEntries,
  type AuditContext,
} from "./audit";
import { ensureThread } from "./email";
import { sendEstimateEmail, type EstimateSendResult } from "./estimateSend";
import { sendInvoiceEmail, type InvoiceSendResult } from "./invoiceSend";
import { sendReceipts, type ReceiptSendResult } from "./paymentReceipts";
import { applyJobStatus } from "./liveProgress";
import { smsNumber } from "./company";
import { splitsStatus } from "./splits";
import {
  canManualClockIn as resolveCanManualClockIn,
  mayTypeClockTimes as resolveMayTypeClockTimes,
  limitTimesheetEdit,
  canMessageCustomers as resolveCanMessageCustomers,
  canDecideTimeOff,
  canEditRecords,
  canSellRecords,
  showsMoney,
  isOwnerLike,
} from "./permissions";
import { migrationHintForSaveError } from "./saveErrors";
import { AFTER_8PM_TEXT, CLOCK_DAY_END, clockNow, clockOutTapTime } from "./clockTime";
import { refusalNotice } from "./saveRefusals";
import { dismissFailedSave, hasUnsavedChange, loadArrival, reloadTiming, type SaveQueueState } from "./saveQueue";
import { BUILD_CHECK_EVERY_MS, BUILD_ID, buildAction, latestBuildId, reloadToNewBuild } from "./buildCheck";
import { mergeSpan } from "./unavailability";
import { documentKindLabel } from "./companyDocuments";
import { planFromEstimate } from "./estimateCrew";
import { estimateInvoicePricing, jobInvoicePricing, jobOfEstimate, nextInvoiceNumber, serviceTypeForEstimate } from "./invoiceMaking";

export type { Role } from "./types";

/** Minimal signed-in identity: Supabase Auth user id + login email. */
/** One job's part of a saved plan board. */
export interface DayBoardPatch {
  crewIds: string[];
  startTime?: string;
  /** Undefined = leave the job's arrival times as they are. */
  crewArrivals?: Record<string, string> | null;
  equipmentIds?: string[];
  equipmentDrivers?: Record<string, string> | null;
}

export interface AuthUser {
  id: string;
  email: string;
}

export type View =
  | "dashboard"
  | "customers"
  | "schedule"
  | "estimates"
  | "invoices"
  | "timesheets"
  | "automations"
  | "activity"
  | "messages"
  | "users"
  | "pipeline"
  | "phc"
  | "crew"
  | "portal"
  | "guide"
  | "sales"
  | "equipment"
  | "crew-rules"
  | "documents"
  | "me";

/**
 * One open detail drawer. Drawers stack: opening a record from inside
 * another drawer pushes on top, and closing returns to the drawer below.
 * Nothing navigates away — closing always returns to the same page state.
 */
export type DrawerTarget =
  | {
      kind: "job";
      jobId: string | null;
      defaultDate: string;
      /** Start time to prefill when creating a job (e.g. from the timetable). */
      defaultStartTime?: string;
      /** Customer to prefill when creating a job (customer page "New job"). */
      defaultCustomerId?: string;
      /** Crew logins: open the edit form, not the read-only job sheet. */
      edit?: boolean;
    }
  | { kind: "employee"; employeeId: string | null; edit: boolean }
  | { kind: "customer"; customerId: string }
  | { kind: "estimate"; estimateId: string }
  | { kind: "invoice"; invoiceId: string; justCreated?: boolean }
  /** A brand-new estimate for this customer (customer page "New estimate"). */
  | { kind: "newEstimate"; customerId: string };

interface Store {
  state: AppState | null;
  loading: boolean;
  /**
   * The viewer's app role, derived from the viewing person (see
   * viewerId). Kept for components that gate money visibility and
   * navigation on it: money is hidden for "crew" viewers.
   */
  role: Role;
  setRole: (r: Role) => void;
  /** Crew member the Crew viewer is standing in as (role switcher stand-in). */
  viewerCrewId: string;
  setViewerCrewId: (id: string) => void;
  /** The person currently viewing the app, picked from the roster. */
  viewerId: string;
  setViewerId: (id: string) => void;
  /** The viewing person's crew record, or null before data loads. */
  viewer: CrewMember | null;
  /** True when config.ts points at a real Supabase project. */
  supabaseMode: boolean;
  /** The signed-in Supabase Auth user in Supabase mode, else null. */
  authUser: AuthUser | null;
  /** True while the session is being resolved on first load. */
  authLoading: boolean;
  /** Last sign-in error message, if any. */
  authError: string | null;
  /** Sign in with email + password; returns an error message or null. */
  signIn: (
    email: string,
    password: string,
    captchaToken?: string | null,
  ) => Promise<string | null>;
  /**
   * Create a crew login from the app. Returns an error or null, plus
   * whether Supabase emailed a confirmation link (true while email
   * confirmation is on — the default). The new login lands as a
   * pending roster row; an owner approves it before it sees anything.
   */
  signUp: (
    name: string,
    email: string,
    password: string,
    captchaToken?: string | null,
  ) => Promise<{ error: string | null; confirmationSent: boolean }>;
  /** Sign out and clear the loaded company state. */
  signOut: () => Promise<void>;
  /**
   * "active" once this user has a company membership, "pending" when
   * signed in but not yet approved, "loading" while the membership is
   * being checked. Mock mode is always "active".
   */
  accessStatus: "active" | "pending" | "loading";
  /** Membership roles by Auth user id, owners only (so the Users page can show who has access). */
  memberRoles: Record<string, string>;
  /** Approve a waiting crew member: create their membership and set their roles. Returns an error or null. */
  approveMember: (
    crewId: string,
    jobRole: string,
    appRole: Role,
  ) => Promise<string | null>;
  /** Reject a waiting signup: remove their roster row. Returns an error or null. */
  rejectMember: (crewId: string) => Promise<string | null>;
  /** Remove a member's access and mark them revoked. Returns an error or null. */
  revokeMember: (crewId: string) => Promise<string | null>;
  /** Change an active member's app role (membership + roster, kept in sync). Returns an error or null. */
  changeMemberRole: (crewId: string, appRole: Role) => Promise<string | null>;
  /**
   * Two-step login for this session: "checking" right after sign-in,
   * "needed" until the code from the authenticator app is entered (the
   * database shows company data only after it), "ok" otherwise.
   */
  twoStep: "checking" | "needed" | "ok";
  /** Check a two-step code at sign-in. Returns an error message, or null. */
  confirmTwoStepCode: (code: string) => Promise<string | null>;
  /** Owners and managers: login ids with two-step login on. */
  loadTwoStepLogins: () => Promise<string[]>;
  /** Owners and managers: reset a member's two-step login (lost phone). */
  resetTwoStepLogin: (crewId: string) => Promise<string | null>;
  /** Last company-data load error in Supabase mode, if any. */
  loadError: string | null;
  /** Re-run the company-data load (after a network error). */
  reloadState: () => void;
  /**
   * Save status for the last change: "saving" while the database
   * write is in flight, "saved" briefly after it lands, "error" when
   * it failed (the latest state stays queued for a retry), "idle"
   * otherwise. Shown in the header so the team can see a change
   * actually saved.
   */
  saveStatus: "idle" | "saving" | "saved" | "error";
  /** What the last failed save reported (table + database message), or null when the last save worked. Shown in a banner so a change that "won't stick" can say why. */
  saveError: string | null;
  /** The table the last failed save died on, or null when the last save worked. Shown in the header so the failing table is visible at a glance. */
  saveFailedTable: string | null;
  /** Migration to run when the last save failed on a missing column/table (e.g. "020"), or null. Shown with the save error so the owner knows what to run. */
  saveMigrationHint: string | null;
  /** Retry the queued save after a failure. */
  retrySave: () => void;
  /** Send the crew field actions kept on this phone again (see fieldQueue.ts). */
  retryFieldQueue: () => void;
  /**
   * Dismiss the save-error banner. When a failed save is queued, it is
   * dropped (the change is discarded) and the real data is loaded again,
   * so the screen is never left stale behind a save that keeps failing.
   */
  clearSaveError: () => void;
  /**
   * True while a change that is not a field tap (clock in/out, Arrived,
   * Done) has not reached the database. Such a change lives only in this
   * screen's memory, so the calm "saved on this phone" note must not
   * show for it.
   */
  unsavedNonField: boolean;
  /**
   * Changes the database refused for this login on the last save
   * (it has no permission for them), or null. Those changes were not
   * saved and the screen reloads the real data; the app shows this
   * once so the person knows why their change went away.
   */
  saveRefused: string | null;
  /** Dismiss the "not allowed" notice. */
  clearSaveRefused: () => void;
  /**
   * Whether the viewer may edit records (customers, estimates,
   * invoices, trees, equipment, day crews, profiles; create and
   * delete jobs). Admins (owner, manager), and office staff whose job
   * role is Climber or Sales. Never a crew login: for app role Crew
   * the database allows editing only jobs (see canEditJobs).
   */
  canEdit: boolean;
  /**
   * Whether the viewer may edit the fields of jobs they can see:
   * everyone with canEdit, plus crew logins whose job role is Climber
   * (the database lets a Climber edit the work on their jobs, billing,
   * hourly rate and job value included; the costs (labor rate,
   * materials, other costs) only with "see money", like the job panel:
   * src/permissions.ts jobMoneyEdits). Creating and deleting jobs needs
   * canEdit.
   */
  canEditJobs: boolean;
  /**
   * May book estimate visits, add customers and write draft estimates
   * (Sales calendar, estimate form): canEdit, plus anyone whose job
   * title is "Sales" whatever their app role (src/permissions.ts
   * canSellRecords; database: is_sales_person). Sending estimates and
   * making invoices still need canEdit.
   */
  canSell: boolean;
  /**
   * Per-user visibility permissions, resolved for the viewer: the
   * role default (owner/office see everything; crew see only their
   * own jobs and no money) overridden by the per-user permissions
   * the owner set on the Users page. Preview-local only — the Phase 2
   * backend must enforce this server-side.
   */
  canSeeMoney: boolean;
  canSeeAllCustomers: boolean;
  canSeeAllJobs: boolean;
  /** The one components use to gate $ values: canSeeMoney, or a Sales person (showsMoney). */
  showMoney: boolean;
  /**
   * Whether the viewer may message customers: the owner-set toggle
   * (permissions.canMessageCustomers). Default off — no role
   * fallback, no owner bypass; an owner turns it on per person on
   * the Users page. Preview-local only — the Phase 2 backend must
   * enforce this server-side.
   */
  canMessageCustomers: boolean;
  /**
   * Whether the viewer may clock in manually / enter hours by hand:
   * the owner-set toggle (permissions.canManualClockIn). Default
   * owners only — no other role fallback; an owner turns it on per
   * person on the Users page. Preview-local only — the Phase 2
   * backend must enforce this server-side.
   */
  canManualClockIn: boolean;
  /**
   * Whether the viewer may type clock times, dates and hours on a time
   * entry: owners, managers, the office, or "May enter hours by hand"
   * (src/permissions.ts mayTypeClockTimes; the database enforces it).
   */
  mayTypeClockTimes: boolean;
  /** Human identity used as the audit actor and private-note author. */
  viewerName: string;
  view: View;
  setView: (v: View) => void;
  /** Day the Schedule should jump to (set by the Dashboard mini calendar). Schedule clears it after jumping. */
  scheduleFocusDate: string | null;
  setScheduleFocusDate: (d: string | null) => void;
  /** Open the Schedule on this day's Plan board ("Plan tomorrow"). */
  planDay: (date: string) => void;
  /** Set by planDay: the Schedule opens the Plan board, then clears it. */
  schedulePlanFocus: boolean;
  clearSchedulePlanFocus: () => void;
  /** Customer the Customers page should select (set by the customer drawer). */
  customerFocusId: string | null;
  setCustomerFocusId: (id: string | null) => void;
  /** Shared detail-drawer stack, rendered at the App level. */
  drawerStack: DrawerTarget[];
  openJob: (jobId: string, opts?: { edit?: boolean }) => void;
  createJob: (defaultDate: string, startTime?: string, customerId?: string) => void;
  /** Open a new estimate for this customer in the side panel. */
  newEstimateFor: (customerId: string) => void;
  openEmployee: (employeeId: string | null, edit?: boolean) => void;
  openCustomer: (customerId: string) => void;
  openEstimate: (estimateId: string) => void;
  /** justCreated: the panel leads with "Send" as the next step. */
  openInvoice: (invoiceId: string, opts?: { justCreated?: boolean }) => void;
  /** Close the top drawer, returning to the drawer (or page) below it. */
  closeDrawer: () => void;
  /**
   * Show exactly these panels (browser Back/Forward, or an address
   * opened from a link). Jobs this viewer may not open are left out,
   * the same rule as openJob.
   */
  replaceDrawers: (drawers: DrawerTarget[]) => void;
  /**
   * Title of the job a denied openJob attempt named, or null. Shown
   * as an amber banner in App so a tap on a job you are not assigned
   * to explains itself instead of silently doing nothing.
   */
  jobAccessDenied: string | null;
  clearJobAccessDenied: () => void;
  saveCustomer: (c: Customer) => void;
  deleteCustomer: (id: string) => void;
  /** Tree inventory: create or update one labeled tree dot. */
  saveTree: (t: Tree) => void;
  deleteTree: (id: string) => void;
  /** PHC programs, visits, and chemical records (care). */
  savePhcProgram: (p: PhcProgram) => void;
  deletePhcProgram: (id: string) => void;
  savePhcVisit: (v: PhcVisit) => void;
  saveChemicalRecord: (r: ChemicalRecord) => void;
  deleteChemicalRecord: (id: string) => void;
  /** Company equipment assignable to jobs. */
  saveEquipment: (e: Equipment) => void;
  deleteEquipment: (id: string) => void;
  /**
   * Flip a machine's down/operational flag (the shorthand status
   * board). Open to EVERYONE on the team — groundsmen included —
   * like the equipment notes: the crew are the ones who find a
   * breakdown. Audit-logged. Does not change job assignment or crew
   * suggestions for the machine.
   */
  setEquipmentDown: (equipmentId: string, down: boolean) => void;
  /** Replace a job's equipment list in one step (Dashboard quick-assign). */
  setJobEquipment: (jobId: string, equipmentIds: string[]) => void;
  /** Equipment maintenance schedules and logs. */
  saveMaintenanceTask: (t: MaintenanceTask) => void;
  deleteMaintenanceTask: (id: string) => void;
  logMaintenance: (r: MaintenanceRecord) => void;
  deleteMaintenanceRecord: (id: string) => void;
  /**
   * Leave a note on a piece of equipment. Open to EVERYONE on the
   * team — groundsmen included — because a groundsman is often the
   * one who notices something wrong with a machine. The author is
   * whoever is signed in; notes are never anonymous.
   */
  addEquipmentNote: (equipmentId: string, text: string) => void;
  /** Remove a note — its author, or an owner. */
  deleteEquipmentNote: (id: string) => void;
  /** Licences & insurance: add or change a document (staff only). */
  saveCompanyDocument: (d: CompanyDocument) => void;
  /** Delete a document; the database removes its uploaded file. */
  deleteCompanyDocument: (id: string) => void;
  /**
   * Accept a proposal option (preview e-sign): marks the estimate
   * accepted with the customer's typed name, and creates the job from
   * the accepted option's lines. Returns the new job id, or null.
   */
  acceptProposal: (
    estimateId: string,
    optionId: string,
    signedBy: string,
  ) => string | null;
  /**
   * Create the job for an accepted estimate on the given day and time
   * (from the "To schedule" rail: drop or "Schedule it"). If the
   * estimate already has a job, that job is moved to the day and time
   * instead — so a drop always ends with the job placed, never a
   * duplicate. Returns the job id, or null when the estimate is gone.
   */
  jobFromEstimate: (
    estimateId: string,
    date: string,
    startTime: string,
  ) => string | null;
  saveJob: (j: Job) => void;
  /**
   * Move a job to another date, keeping its crew exactly as-is.
   * (The month view has no crew lanes, so rescheduling never touches
   * assignment; crew changes go through saveJob or the roster drop.)
   */
  rescheduleJob: (jobId: string, date: string) => void;
  /** Move a job to another day AND time in one step (timetable drag). */
  moveJob: (jobId: string, date: string, startTime: string) => void;
  /**
   * Replace a job's crew list in one step (Dashboard quick-assign).
   * No-op when the list is unchanged. Owner/manager-only in the UI; the action itself just saves what it is given.
   */
  setJobCrew: (jobId: string, crewIds: string[]) => void;
  /**
   * Move a job's status (Arrived / Done taps on the day plan).
   * Not a record edit — any crew member assigned to the job may
   * tap it, groundsmen included, like clocking in; owners/office
   * may tap any job. The UI gates who gets the buttons; the action
   * itself just saves what it is given, like setJobCrew. Audit-
   * logged on "status". No-op when unchanged.
   */
  setJobStatus: (jobId: string, status: JobStatus) => void;
  /**
   * Book (or clear) the estimator's estimate visit on a draft estimate: the day
   * and time he goes to look and write the quote. Set from the Sales
   * tab's suggestion ("Schedule it"); clearing puts the estimate back
   * in the "Needs a visit" rail. No-op when unchanged, audit-logged
   * on visitDate/visitTime like setJobCrew. UI-gated on canEdit.
   */
  setEstimateVisit: (
    estimateId: string,
    date: string | null,
    time: string | null,
  ) => void;
  /**
   * Sales calendar "Create estimate": adds the customer when new, then
   * reuses their open draft estimate (no visit yet) or starts a new
   * draft, with the visit day/time when given (src/salesCalendar.ts
   * planCreateEstimate). Returns the estimate id, or null when there
   * is no customer. Audit-logged. UI-gated on canSell.
   */
  createSalesEstimate: (input: CreateEstimateInput) => string | null;
  /**
   * Sales login: suggest a change to a customer (allow-listed fields
   * only, src/customerEdits.ts); it waits for the office. Returns an
   * error message, or null once it is sent.
   */
  suggestCustomerEdit: (customerId: string, changes: CustomerChanges, note: string) => Promise<string | null>;
  /**
   * Office: approve (apply to the customer, with change history) or
   * decline a suggested change. `changes`: the office's edited values
   * (only suggested fields; null = as suggested). `reason`: optional
   * decline reason, shown to the Sales person. Returns an error
   * message, or null.
   */
  decideCustomerEdit: (
    requestId: string,
    decision: "approve" | "decline",
    opts?: { changes?: CustomerChanges | null; reason?: string },
  ) => Promise<string | null>;
  /**
   * Change a job's price (billing, value, hourly rate) with a reason,
   * through change_job_price (the "invoice email by hand" rules): how a Climber
   * changes a price; the office is told. Returns an error message, or
   * null once it is saved.
   */
  changeJobPrice: (jobId: string, price: JobPrice, reason: string) => Promise<string | null>;
  /** Office: mark a crew price change seen. Returns an error message, or null. */
  markPriceChangeSeen: (changeId: string) => Promise<string | null>;
  /**
   * Office: the job's estimate prices it again after a Climber replaced
   * its price (clears replacedPrice). Returns an error message, or null.
   */
  restoreEstimatePrice: (jobId: string) => Promise<string | null>;
  /**
   * Report a problem on a piece of equipment (anyone on the team): a
   * short text and an optional photo, already made small
   * (src/data/problemPhotos.ts). `error` = nothing was saved;
   * `photoError` = the report was saved but its photo was not.
   */
  reportEquipmentProblem: (
    equipmentId: string,
    note: string,
    photo: Uint8Array | null,
  ) => Promise<{ error: string | null; photoError: string | null }>;
  /** Office: mark a report fixed, or send the machine to the shop. Returns an error message, or null. */
  resolveEquipmentProblem: (problemId: string, action: "fixed" | "shop") => Promise<string | null>;
  /**
   * Named day crews (see DayCrew): a shortcut group for one date.
   * Applying a crew to a job sets that job's crew to the crew's
   * members, audit-logged like setJobCrew. UI-gated on canEdit, like
   * the other scheduling actions. addDayCrew returns the new id.
   */
  addDayCrew: (date: string, name: string, memberIds: string[]) => string;
  renameDayCrew: (id: string, name: string) => void;
  setDayCrewMembers: (id: string, memberIds: string[]) => void;
  deleteDayCrew: (id: string) => void;
  applyDayCrewToJob: (jobId: string, dayCrewId: string) => void;
  /**
   * Owner-marked unavailability (Schedule roster right-click):
   * a crew member out for a stretch of days. Takes effect
   * immediately — no request/approval flow like time off — and
   * excludes them from crew suggestions on those days, the same
   * way approved time off does. Overlapping or adjacent spans for
   * the same person merge into one; addUnavailabilitySpan returns
   * the merged span's id. deleteUnavailabilitySpan removes the
   * whole span. Audit-logged, UI-gated on owner/manager.
   */
  addUnavailabilitySpan: (
    crewId: string,
    startDate: string,
    endDate: string,
  ) => string;
  deleteUnavailabilitySpan: (id: string) => void;
  /**
   * On-demand location ("Where is my crew"). There is NO push
   * server: a request is stored in the DB and the crew member
   * answers by opening the app and tapping Share. One tap = one
   * location point + time, never continuous tracking.
   * requestLocations inserts one row per person given (skipping
   * anyone who already has an open request), or for everyone
   * assigned to a job today when called with no ids.
   * shareMyLocation reads the phone's position once at tap time and
   * stores the point; it resolves true when the point was saved,
   * false when the read was denied/failed (the caller shows why).
   */
  requestLocations: (crewIds?: string[]) => void;
  shareMyLocation: () => Promise<boolean>;
  deleteJob: (id: string) => void;
  saveEstimate: (e: Estimate) => void;
  deleteEstimate: (id: string) => void;
  saveInvoice: (i: Invoice) => void;
  /** "Stop" on an invoice made by Done: cancels its automatic email. Error text or null. */
  stopInvoiceAutoSend: (invoiceId: string) => Promise<string | null>;
  markInvoicePaid: (id: string, method?: PaymentMethod | null) => void;
  /**
   * Split invoicing: mark one bill-to recipient's share paid (or
   * unpaid). The invoice's overall status follows the splits —
   * paid when every split is paid, partial when some are.
   */
  markSplitPaid: (invoiceId: string, splitId: string, paid: boolean) => void;
  invoiceFromEstimate: (estimateId: string) => string | null;
  invoiceFromJob: (jobId: string) => string | null;
  addTimesheet: (t: TimesheetEntry) => void;
  /**
   * Clock in, gated by the geofence (see geofence.ts): allowed only
   * within 0.25 mi of one of the company's shop/yard spots, or the
   * crew member's first job site of the day. Resolves with the check
   * result — when it is not allowed, no entry is created and the
   * caller shows the message. Clock-out is never restricted.
   */
  clockIn: (
    crewId: string,
    jobId: string | null,
    location: string,
  ) => Promise<ClockInCheck>;
  clockOut: (entryId: string) => void;
  updateTimesheet: (t: TimesheetEntry) => void;
  deleteTimesheet: (id: string) => void;
  addPrivateNote: (n: PrivateNote) => void;
  deletePrivateNote: (id: string) => void;
  saveCrewMember: (m: CrewMember) => void;
  /** Remove a roster card; removes the login's access first. Returns an error or null. */
  deleteCrewMember: (id: string) => Promise<string | null>;
  /**
   * Update only one person's own message intro. This is the one
   * record edit anyone may make about themselves, including
   * groundsmen — the UI never lets an admin overwrite someone
   * else's intro. Audit-logged as a User change.
   */
  saveMessageIntro: (crewId: string, intro: string) => void;
  saveAutomation: (r: AutomationRule) => void;
  /** Create or update a time-off request (crew asks, owner decides). */
  saveTimeOffRequest: (r: TimeOffRequest) => void;
  /** Cancel a request (the requester, or an owner cleaning up). */
  deleteTimeOffRequest: (id: string) => void;
  /** Owner-only: approve or deny a pending request. */
  decideTimeOffRequest: (id: string, status: "approved" | "denied") => void;
  /** Owner-only: mark a day Business closed (reason optional). */
  setClosedDay: (date: string, reason: string | null) => void;
  /** Owner-only: reopen a closed day. */
  removeClosedDay: (date: string) => void;
  /** Accept (creates customer + draft estimate) or decline a booking request. */
  /**
   * Accept or decline an online booking request. Accept makes a draft
   * estimate (in "Needs a visit", the asked-for day in its notes) for an
   * existing customer (opts.customerId) or a new one. Returns the new
   * estimate's id on accept, or null when the request was no longer
   * waiting (nothing was made).
   */
  decideBookingRequest: (
    id: string,
    status: "accepted" | "declined",
    opts?: { customerId?: string },
  ) => string | null;
  /** Remove a booking request. */
  deleteBookingRequest: (id: string) => void;
  /**
   * Email the estimate to the customer. Live: once the estimate's save
   * reaches the database, the send-estimate function emails it with a
   * private "Review and accept" link (again = send a fresh link even
   * though one was already sent). Demo mode: only marks it queued.
   * onResult gets what happened (plain English via estimateSendText).
   */
  queueEstimateEmail: (
    id: string,
    opts?: { again?: boolean; onResult?: (r: EstimateSendResult) => void },
  ) => void;
  /**
   * "Email invoice": once the invoice's save reaches the database, the
   * send-invoice function emails the customer the thank-you, the full
   * invoice and How to pay, plus a "Review us" button only when
   * askReview is true. The invoice is marked emailed only when it was
   * really sent. Demo mode: nothing is sent or marked. onResult gets
   * what happened (plain English via invoiceSendText).
   */
  queueInvoiceEmail: (
    id: string,
    opts?: {
      askReview?: boolean;
      again?: boolean;
      /** Split invoice: only these payers (split ids). */
      splitIds?: string[];
      /** How many emails the sender confirmed (two-step confirm for more than 3). */
      confirmed?: number;
      onResult?: (r: InvoiceSendResult) => void;
    },
  ) => void;
  /**
   * Split invoice: email the payment receipt to these payers, once
   * everything queued so far (their "paid" mark) is in the database.
   * `again` = "Resend receipt". Demo mode sends nothing.
   */
  sendPaymentReceipts: (
    invoiceId: string,
    opts: {
      splitIds: string[];
      again?: boolean;
      /** How many emails the sender confirmed (two-step confirm for more than 3). */
      confirmed?: number;
      onResult?: (r: ReceiptSendResult) => void;
    },
  ) => void;
  /**
   * Queue a customer message in the shared thread (preview only —
   * nothing is actually sent). Creates the Message row and an audit
   * entry so it shows on the customer activity log and the global
   * Activity page. Outbound SMS is always from the central number.
   */
  sendMessage: (input: {
    customerId: string;
    channel: MessageChannel;
    body: string;
    jobId?: string | null;
    estimateId?: string | null;
  }) => void;
  setAutoClock: (on: boolean) => void;
  /** Master switch "Automatic customer emails" (owners/managers only). */
  setAutoEmails: (on: boolean) => void;
  /** Update calendar settings (daily target, suggest days, hover route, day totals). */
  setCalendarSettings: (patch: Partial<Omit<AppSettings, "autoClock">>) => void;
  /**
   * Replace the team's skill list (owners and managers). A removed
   * skill is also unticked on every person, so no stale skill is left.
   */
  saveSkillCatalog: (catalog: SkillDef[]) => void;
  /** Hide skill suggestions for good (keys "crewId:skillId"). */
  dismissSkillSuggestions: (keys: string[]) => void;
  /** Change auto-scheduler settings (owners and managers), e.g. the shop drive times start from. */
  savePlannerSettings: (patch: Partial<PlannerSettings>) => void;
  /**
   * Apply a day plan from the planner in one save: each job's crew,
   * equipment and drivers (and the suggested start time when setTimes),
   * the day's crews, and an activity-log snapshot of what the planner
   * proposed (the record later "learn from my changes" compares with).
   * Returns how many jobs changed.
   */
  applyDayPlan: (date: string, plan: DayPlan, setTimes: boolean) => number;
  /**
   * Plan board: write the day's people, start times, arrival times (and
   * equipment where given) to the jobs in one save. `snapshot` is what
   * auto-fill proposed and what was saved, kept for learning later.
   * Returns how many jobs changed.
   */
  saveDayBoard: (
    date: string,
    patches: Record<string, DayBoardPatch>,
    snapshot: string,
    /** Called once the save reaches the database (true) or is dropped (false). */
    onSaved?: (ok: boolean) => void,
  ) => number;
  /** Invoice payment-terms defaults (commercial / residential). */
  setInvoiceSettings: (
    patch: Partial<
      Pick<AppSettings, "commercialTermsDays" | "residentialTermsDays">
    >,
  ) => void;
  resetDemo: () => void;
}

const Ctx = createContext<Store | null>(null);

/**
 * Friendly text for a refused membership change. Row-level security
 * reports a blocked insert as error 42501; the last-owner guard
 * raises 23514 with its own message.
 */
function membershipError(error: { code?: string; message: string }): string {
  if (error.code === "42501") return NO_MEMBERSHIP_PERMISSION;
  return error.message;
}
const NO_MEMBERSHIP_PERMISSION =
  "You don't have permission to change this person's access. Only an owner can add, change or remove an owner.";

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used inside AppProvider");
  return s;
}

/**
 * The loaded app state, for components that a parent renders only
 * after `state` is non-null. It lets those components call their
 * hooks unconditionally (no `if (!state) return null` before them,
 * which breaks React's rules of hooks when the state finishes loading).
 */
export function useLoadedState(): AppState {
  const { state } = useStore();
  if (!state) throw new Error("useLoadedState used before state loaded");
  return state;
}

/**
 * Plan board arrival times stay only while they still describe the job:
 * a new date or start time drops them all; people taken off the job drop
 * their own.
 */
/**
 * Due date for a new invoice: issued date + the default terms for the
 * customer's type (commercial = Net 30, residential = due on receipt,
 * both changeable in Invoice settings). 0 days = due the same day.
 */
function dueDateForInvoice(
  p: AppState,
  customerId: string,
  issuedDate: string,
): string {
  const c = p.customers.find((x) => x.id === customerId);
  const days =
    c?.type === "commercial"
      ? (p.settings.commercialTermsDays ?? 30)
      : (p.settings.residentialTermsDays ?? 0);
  return addDaysISO(issuedDate, days);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerId, setViewerId] = useState<string>("");
  const [view, setView] = useState<View>("dashboard");
  const [scheduleFocusDate, setScheduleFocusDate] = useState<string | null>(
    null,
  );
  const [schedulePlanFocus, setSchedulePlanFocus] = useState(false);
  const planDay = useCallback((date: string) => {
    setScheduleFocusDate(date);
    setSchedulePlanFocus(true);
    setView("schedule");
  }, []);
  const clearSchedulePlanFocus = useCallback(() => setSchedulePlanFocus(false), []);
  const [customerFocusId, setCustomerFocusId] = useState<string | null>(null);
  const [drawerStack, setDrawerStack] = useState<DrawerTarget[]>([]);
  const [jobAccessDenied, setJobAccessDenied] = useState<string | null>(
    null,
  );
  const openDrawer = useCallback((t: DrawerTarget) => {
    setDrawerStack((s) => [...s, t]);
  }, []);
  const openJob = useCallback(
    (jobId: string, opts?: { edit?: boolean }) => {
      // Crew job gate (see src/jobVisibility.ts): a viewer without
      // canSeeAllJobs may open only jobs they are assigned to. The
      // drawer is the only way into JobEditor, so this is the choke
      // point for every caller — Schedule, Dashboard, activity
      // entries, per-customer job lists, estimate/invoice links. A
      // denied open leaves the drawer closed and names the job in an
      // amber banner (App) instead of silently swallowing the tap.
      const s = stateRef.current;
      const v = jobVisibilityRef.current;
      const job = s?.jobs.find((j) => j.id === jobId) ?? null;
      if (job && !v.canSeeAllJobs && !job.crewIds.includes(v.viewerId)) {
        setJobAccessDenied(job.title);
        return;
      }
      setJobAccessDenied(null);
      openDrawer({ kind: "job", jobId, defaultDate: todayStr(), edit: opts?.edit });
    },
    [openDrawer],
  );
  const createJob = useCallback(
    (defaultDate: string, startTime?: string, customerId?: string) =>
      openDrawer({
        kind: "job",
        jobId: null,
        defaultDate,
        defaultStartTime: startTime,
        defaultCustomerId: customerId,
      }),
    [openDrawer],
  );
  const newEstimateFor = useCallback(
    (customerId: string) => openDrawer({ kind: "newEstimate", customerId }),
    [openDrawer],
  );
  const openEmployee = useCallback(
    (employeeId: string | null, edit = false) =>
      openDrawer({ kind: "employee", employeeId, edit }),
    [openDrawer],
  );
  const openCustomer = useCallback(
    (customerId: string) => openDrawer({ kind: "customer", customerId }),
    [openDrawer],
  );
  const openEstimate = useCallback(
    (estimateId: string) => openDrawer({ kind: "estimate", estimateId }),
    [openDrawer],
  );
  const openInvoice = useCallback(
    (invoiceId: string, opts?: { justCreated?: boolean }) =>
      openDrawer({ kind: "invoice", invoiceId, justCreated: opts?.justCreated }),
    [openDrawer],
  );
  const closeDrawer = useCallback(() => {
    setDrawerStack((s) => s.slice(0, -1));
  }, []);
  const replaceDrawers = useCallback((drawers: DrawerTarget[]) => {
    const s = stateRef.current;
    const v = jobVisibilityRef.current;
    setDrawerStack(
      drawers.filter((d) => {
        if (d.kind !== "job" || !d.jobId || v.canSeeAllJobs) return true;
        const job = s?.jobs.find((j) => j.id === d.jobId) ?? null;
        return !job || job.crewIds.includes(v.viewerId);
      }),
    );
  }, []);
  const clearJobAccessDenied = useCallback(
    () => setJobAccessDenied(null),
    [],
  );
  const adapterRef = useRef<DataAdapter>(defaultAdapter);
  const supabaseMode = supabaseConfigured;
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  // One object per signed-in login. Token refreshes (about hourly) and
  // two-step checks fire auth events with a fresh user object; keeping
  // the same one stops those from reloading all company data.
  const setSignedIn = useCallback(
    (u: { id: string; email?: string | null } | null | undefined) => {
      setAuthUser((prev) => {
        if (!u) return null;
        const email = u.email ?? "";
        return prev && prev.id === u.id && prev.email === email
          ? prev
          : { id: u.id, email };
      });
    },
    [],
  );
  /**
   * Two-step login for this session: "checking" right after sign-in,
   * "needed" when the login has two-step login on and this session has
   * not entered the code yet (the database shows such a session no
   * company data), "ok" otherwise. Company data loads only once "ok".
   */
  const [twoStepFor, setTwoStepFor] = useState<{
    userId: string;
    status: "needed" | "ok";
  } | null>(null);
  // An answer only counts for the login it was checked for.
  const twoStep: "checking" | "needed" | "ok" =
    authUser && twoStepFor?.userId === authUser.id
      ? twoStepFor.status
      : "checking";
  /**
   * Bumped on auth events (sign-in, returning to the app, token
   * refresh, a code entered in another tab): the two-step and
   * membership checks run again, without a "Loading…" flash.
   */
  const [authCheck, setAuthCheck] = useState(0);
  /** Bumped when a save found the session had no company access. */
  const [accessRecheck, setAccessRecheck] = useState(0);
  const [authLoading, setAuthLoading] = useState(supabaseMode);
  const [authError, setAuthError] = useState<string | null>(null);
  const [membershipRole, setMembershipRole] = useState<string | null>(null);
  const [membershipChecked, setMembershipChecked] = useState(false);
  const [memberRoles, setMemberRoles] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  // A fresh load waits while one of this screen's own changes has not
  // saved yet (src/saveQueue.ts): it runs once the save queue is empty.
  // The refs it reads are declared further down with the save queue.
  const reloadState = useCallback(() => {
    const queue: SaveQueueState = {
      pending: savePending.current !== null,
      running: saveRunning.current,
      blocked: saveBlocked.current,
    };
    if (reloadTiming(queue, stateRef.current !== null) === "after-save") {
      reloadAfterSave.current = true;
      return;
    }
    setLoadNonce((n) => n + 1);
  }, []);

  // Mock mode: load once on mount, exactly as before.
  useEffect(() => {
    if (supabaseMode) return;
    let cancelled = false;
    adapterRef.current
      .loadState()
      .then((s) => {
        if (!cancelled) {
          setState(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supabaseMode]);

  // Supabase mode: resolve the session, then keep it current. The
  // client persists the session itself, so a reload signs back in.
  useEffect(() => {
    if (!supabaseMode || !supabase) {
      setAuthLoading(false);
      return;
    }
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSignedIn(data.session?.user);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Session ended (signed out elsewhere, expired, revoked): drop
        // this device's copy of the company data.
        if (event === "SIGNED_OUT") void clearLocalCompanyData();
        // Re-check two-step login and team access: approvals, removals
        // and role changes made by an owner, and two-step login turned
        // on from another device, show up here.
        if (
          event === "SIGNED_IN" ||
          event === "TOKEN_REFRESHED" ||
          event === "USER_UPDATED" ||
          event === "MFA_CHALLENGE_VERIFIED"
        ) {
          setAuthCheck((n) => n + 1);
        }
        setSignedIn(session?.user);
        setAuthLoading(false);
      },
    );
    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [supabaseMode, setSignedIn]);

  // Supabase mode: does this session still need its two-step code?
  // The factor list stored with the session is only updated at sign-in
  // and token refresh, so ask the server (getUser) which factors the
  // login has now: two-step login turned on from another device shows
  // at once. If the server ended this session (turning two-step login
  // on ends the login's password-only sessions), getUser signs this
  // device out. Offline, fall back to the stored copy.
  useEffect(() => {
    if (!supabaseMode || !supabase || !authUser) return;
    const client = supabase;
    let cancelled = false;
    const userId = authUser.id;
    void (async () => {
      const fresh = await client.auth.getUser().catch(() => null);
      const { data, error } = await client.auth.mfa
        .getAuthenticatorAssuranceLevel()
        .catch(() => ({ data: null, error: true }));
      if (cancelled) return;
      const hasCode = !error && data?.currentLevel === "aal2";
      const freshUser = fresh && !fresh.error ? fresh.data.user : null;
      // On an error, let the normal load run: the database still
      // enforces two-step login and returns nothing to such a session.
      const needed = freshUser
        ? (freshUser.factors ?? []).some((f) => f.status === "verified") &&
          !hasCode
        : !error && data?.nextLevel === "aal2" && !hasCode;
      setTwoStepFor({ userId, status: needed ? "needed" : "ok" });
    })();
    return () => {
      cancelled = true;
    };
  }, [supabaseMode, authUser, authCheck, accessRecheck]);

  // Supabase mode, live: while signed in, listen for changes to the
  // tables the calendar renders and reload the state, so a job moved,
  // added, or deleted on one person's screen appears on everyone
  // else's within about a second, with no refresh. Events are
  // debounced so a burst of writes reloads once. Needs migration 017
  // (these tables in the supabase_realtime publication); without it
  // the subscription simply never fires and the app behaves as before.
  //
  // Deliberately NOT subscribed: customers, estimates, invoices. The
  // whole-state save rewrites every row of those big tables on each
  // save, so listening would flood the channel with thousands of
  // events per change. A customer or estimate edit still shows on the
  // next app open; the calendar itself (jobs) is live.
  const LIVE_TABLES = [
    // settings: a crew screen waiting on "Setting up" opens by itself
    // the moment the owner finishes the setup wizard.
    "settings",
    "crew",
    "jobs",
    "time_off_requests",
    "closed_days",
    "timesheets",
    "day_crews",
    "crew_unavailability",
    "location_requests",
    "crew_locations",
    // Suggested customer changes: the office sees a new one, the Sales
    // person sees the decision (the "customer edit requests" rules).
    "customer_edit_requests",
    // Crew price changes: the office sees one live on the Dashboard
    // (the "invoice email by hand" rules).
    "job_price_changes",
    // Equipment problem reports: the office sees a new one live
    // (the "equipment problems" rules).
    "equipment_problems",
  ] as const;
  const reloadTimer = useRef<number | null>(null);
  // Timestamp (ms) of our own last completed save. The realtime
  // listener below reads it to ignore our own save's echo — without
  // this, every change we make re-fetches the whole state and
  // re-renders the page (the "reload on every change").
  const lastOwnSaveAtRef = useRef(0);
  useEffect(() => {
    if (!supabaseMode || !supabase || !authUser) return;
    const client = supabase;
    const queueReload = () => {
      // Ignore our own save's echo. The whole-state save rewrites
      // the live tables, so every change we make fires a realtime
      // event for it — and reloading on that event re-fetches the
      // entire state and re-renders the page. Our screen already
      // has the new state, so skip events while a save is running
      // and for 5s after one ends. A teammate's change still
      // reloads (their events arrive outside our window).
      // Trade-off: a teammate's change landing inside our 5s
      // window is missed until their next change or a refresh.
      if (saveRunning.current) return;
      if (Date.now() - lastOwnSaveAtRef.current < 5000) return;
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
      }
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = null;
        reloadState();
      }, 800);
    };
    let channel = client.channel("app-changes");
    for (const table of LIVE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        queueReload,
      );
    }
    channel.subscribe();
    return () => {
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = null;
      }
      void client.removeChannel(channel);
    };
  }, [supabaseMode, authUser, reloadState]);

  // Supabase mode: load the company only while signed in. Signing out
  // clears it so the next person never sees the previous user's data.
  useEffect(() => {
    if (!supabaseMode) return;
    if (!authUser) {
      setState(null);
      setLoading(false);
      return;
    }
    // Two-step login: nothing to load until the code is entered.
    if (twoStep !== "ok") return;
    let cancelled = false;
    let discarded = false;
    setLoading(true);
    setLoadError(null);
    adapterRef.current
      .loadState({
        // Asked once the data has arrived: a change made meanwhile is
        // not in it, so keep the screen and load again after the save.
        discard: () => {
          discarded =
            loadArrival(saveQueueNow(), stateRef.current !== null) === "discard";
          return discarded;
        },
      })
      .then((s) => {
        if (!cancelled && discarded) {
          reloadAfterSave.current = true;
          setLoading(false);
          return;
        }
        if (!cancelled) {
          awaitingDoneInvoice.current.clear();
          setState(s);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(
            e instanceof Error
              ? e.message
              : "Could not load company data.",
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [supabaseMode, authUser, loadNonce, twoStep]);

  // Supabase mode: the membership row for this user (the app role comes
  // from it). Members can read only their own rows, per the migrations.
  // membershipChecked flips once the query settles — with or without a
  // row — so the app can tell "waiting for approval" from "still
  // checking" instead of flashing the main screen at a pending user.
  // It runs again on every auth event (see authCheck), so an approval,
  // a removal or a role change reaches an open app without a reload.
  const membershipCheckedRef = useRef(false);
  useEffect(() => {
    if (!supabaseMode || !supabase || !authUser || twoStep !== "ok") {
      membershipCheckedRef.current = false;
      setMembershipRole(null);
      setMembershipChecked(false);
      return;
    }
    let cancelled = false;
    const client = supabase;
    const userId = authUser.id;
    void (async () => {
      const { data, error } = await client
        .from("company_members")
        .select("role")
        .eq("user_id", userId)
        .eq("company_id", supabaseConfig.companyId)
        .maybeSingle();
      if (cancelled) return;
      // A re-check that fails (offline) keeps the last answer.
      if (error && membershipCheckedRef.current) return;
      // "No row" counts as "no access" only when the server confirms
      // who is signed in: a request sent without a valid sign-in
      // (expired) also reads no row, and must not wipe the app. Until
      // then the last answer stays (or "Loading…" on the first check).
      if (!error && !data) {
        const who = await client.auth.getUser().catch(() => null);
        if (cancelled) return;
        if (!who || who.error || who.data.user?.id !== userId) return;
      }
      setMembershipRole(!error && data ? String(data.role) : null);
      setMembershipChecked(true);
      membershipCheckedRef.current = true;
      // Signed in but no access (never approved, or removed): make
      // sure no earlier copy of the company data stays on this device.
      if (!error && !data) void clearLocalCompanyData();
    })();
    return () => {
      cancelled = true;
    };
  }, [supabaseMode, authUser, twoStep, authCheck, accessRecheck]);

  // Access changed while the app is open (approved, removed, new
  // role): load the company again with the new access.
  const lastMembershipRole = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!membershipChecked) {
      lastMembershipRole.current = undefined;
      return;
    }
    if (
      lastMembershipRole.current !== undefined &&
      lastMembershipRole.current !== membershipRole
    ) {
      reloadState();
    }
    lastMembershipRole.current = membershipRole;
  }, [membershipChecked, membershipRole, reloadState]);

  /** Picker viewer (mock mode only; the picker is hidden otherwise). */
  const pickerViewerId = viewerId || state?.crew[0]?.id || "";
  const pickerViewer =
    state?.crew.find((c) => c.id === pickerViewerId) ?? null;

  /**
   * Supabase mode: the logged-in user IS the viewer. Their crew record
   * is matched by Auth user id first, then by login email; the app role
   * comes from their company_members row when present. With no crew
   * record yet (e.g. a fresh company before import), the viewer is a
   * membership-only identity: the right app role, but no personal crew
   * scoping until the admin links the crew record's email.
   */
  const supabaseViewer: CrewMember | null = useMemo(() => {
    if (!supabaseMode || !authUser || !state) return null;
    const email = authUser.email.toLowerCase();
    const match =
      state.crew.find(
        (c) =>
          (c.authUserId && c.authUserId === authUser.id) ||
          (c.email && email && c.email.toLowerCase() === email),
      ) ?? null;
    const mappedRole: Role | null =
      membershipRole === "owner"
        ? "owner"
        : membershipRole === "manager"
          ? "manager"
          : membershipRole === "office"
            ? "office"
            : membershipRole === "crew"
              ? "crew"
              : null;
    if (match) {
      return mappedRole ? { ...match, appRole: mappedRole } : match;
    }
    if (mappedRole) {
      return {
        id: `auth:${authUser.id}`,
        name: authUser.email || "Signed in user",
        role: "Groundsman",
        phone: "",
        color: "#64748b",
        appRole: mappedRole,
        email: authUser.email,
        messageIntro: "",
      };
    }
    return null;
  }, [supabaseMode, authUser, state, membershipRole]);

  const viewer = supabaseMode ? supabaseViewer : pickerViewer;
  /** App role of the viewing person (drives money visibility + nav). */
  const role: Role = viewer?.appRole ?? "owner";
  /**
   * Edit permission (src/permissions.ts canEditRecords): owners,
   * managers and the Office app role, whatever the person's job title
   * (an "Office manager" edits customers, estimates, jobs and
   * invoices; the database lets every office login do that). A crew
   * login never has canEdit: the database refuses its changes to
   * everything but jobs. A crew Climber edits their jobs through
   * canEditJobs instead.
   */
  const canEdit = canEditRecords(viewer?.appRole);
  const canEditJobs =
    canEdit || (role === "crew" && viewer?.role === "Climber");
  const canSell = canSellRecords(viewer?.appRole, viewer?.role);
  /** The viewer's roster card: the author of estimates they add. */
  const viewerCardId = viewer?.id ?? null;
  /**
   * Per-user visibility, resolved for the viewer. Role default:
   * owner/office see everything, crew see only their own jobs and
   * no money. Each flag can be overridden per person on the Users
   * page (viewer.permissions); undefined there = role default.
   */
  const viewerPerms = viewer?.permissions ?? {};
  const roleSeesAll = role !== "crew";
  const canSeeMoney = viewerPerms.seeMoney ?? roleSeesAll;
  /** Dollar amounts on screen: canSeeMoney, or a Sales person (src/permissions.ts showsMoney). */
  const showMoney = showsMoney(canSeeMoney, viewer?.appRole, viewer?.role);
  const canSeeAllCustomers = viewerPerms.seeAllCustomers ?? roleSeesAll;
  const canSeeAllJobs = viewerPerms.seeAllJobs ?? roleSeesAll;
  /** Whether the viewer may message customers (toggle, default off — see src/permissions.ts). */
  const canMessageCustomers = resolveCanMessageCustomers(state, viewer);
  /** Whether the viewer may clock in manually (toggle, default owners only — see src/permissions.ts). */
  const canManualClockIn = resolveCanManualClockIn(state, viewer);
  const mayTypeClockTimes = resolveMayTypeClockTimes(state, viewer);
  const viewerName = viewer?.name ?? "Owner";
  /**
   * Onboarding gate. A signed-in user with no membership row is
   * waiting for approval: they see the pending screen, never the app
   * (and RLS already locks every table to them anyway).
   */
  const accessStatus: "active" | "pending" | "loading" = !supabaseMode
    ? "active"
    : !authUser
      ? "loading"
      : !membershipChecked
        ? "loading"
        : membershipRole
          ? "active"
          : "pending";
  // Owners only: every membership row of this company, so the Users
  // page can show who actually has access. Needs migration 006's
  // owner policy; before it runs, only the owner's own row is
  // readable and everyone else reads as "no access".
  useEffect(() => {
    if (
      !supabaseMode ||
      !supabase ||
      !authUser ||
      twoStep !== "ok" ||
      !isOwnerLike(role)
    ) {
      setMemberRoles({});
      return;
    }
    let cancelled = false;
    supabase
      .from("company_members")
      .select("user_id, role")
      .eq("company_id", supabaseConfig.companyId)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const next: Record<string, string> = {};
        for (const row of data as Array<{
          user_id: string;
          role: string;
        }>) {
          next[String(row.user_id)] = String(row.role);
        }
        setMemberRoles(next);
      });
    return () => {
      cancelled = true;
    };
  }, [supabaseMode, authUser, role, twoStep, authCheck]);
  /**
   * The exposed viewer id. In Supabase mode it is the resolved viewer
   * (crew record or membership identity); the picker never sets it
   * there, so a viewer cannot stand in as someone else.
   */
  const viewerIdExposed = supabaseMode ? (viewer?.id ?? "") : pickerViewerId;
  const viewerCrewId = viewerIdExposed;
  // Fresh-visibility ref so openJob (defined above, before the viewer
  // is resolved) can enforce the crew job rule. It must mirror
  // viewerIdExposed, NOT the raw viewerId state — in Supabase mode
  // the picker never sets that state, so it stays "" and every crew
  // member would fail the crewIds check, including for their own
  // jobs. Mirrors the stateRef/actorRef pattern.
  const jobVisibilityRef = useRef({ viewerId: "", canSeeAllJobs: true });
  useEffect(() => {
    jobVisibilityRef.current = { viewerId: viewerIdExposed, canSeeAllJobs };
  }, [viewerIdExposed, canSeeAllJobs]);
  const setViewerIdSafe = useCallback(
    (id: string) => {
      if (!supabaseMode) setViewerId(id);
    },
    [supabaseMode],
  );
  const setViewerCrewId = setViewerIdSafe;
  const setRole = useCallback(
    (r: Role) => {
      if (supabaseMode) return;
      const first = state?.crew.find((c) => c.appRole === r);
      if (first) setViewerId(first.id);
    },
    [state, supabaseMode],
  );

  const signIn = useCallback(
    async (
      email: string,
      password: string,
      captchaToken?: string | null,
    ): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      setAuthError(null);
      // captchaToken: required by Supabase once Auth CAPTCHA (Turnstile)
      // is on; ignored while it is off.
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: captchaToken ? { captchaToken } : undefined,
      });
      if (error) {
        setAuthError(error.message);
        return error.message;
      }
      const u = data.session?.user;
      if (u) setSignedIn(u);
      return null;
    },
    [setSignedIn],
  );


  const signUp = useCallback(
    async (
      name: string,
      email: string,
      password: string,
      captchaToken?: string | null,
    ): Promise<{ error: string | null; confirmationSent: boolean }> => {
      if (!supabase) {
        return { error: "Supabase is not configured.", confirmationSent: false };
      }
      setAuthError(null);
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name },
          ...(captchaToken ? { captchaToken } : {}),
        },
      });
      if (error) {
        setAuthError(error.message);
        return { error: error.message, confirmationSent: false };
      }
      // No session + a user = Supabase is waiting on email
      // confirmation (the default). With confirmation off, the
      // session is live and the auth listener signs them straight in.
      const confirmationSent = !data.session && !!data.user;
      const u = data.session?.user;
      if (u) setSignedIn(u);
      return { error: null, confirmationSent };
    },
    [setSignedIn],
  );

  // The actor identity for audit entries. Kept in a ref so mutation
  // updaters (which run inside setState) always read the current viewer.
  const actorRef = useRef("Owner");
  useEffect(() => {
    actorRef.current = viewerName;
  }, [viewerName]);

  // Fresh-state ref so actions that must return a value (e.g. the id of
  // a just-created invoice) can check existence before mutating.
  const stateRef = useRef<AppState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /**
   * Serialized saves. Every mutation hands its new state to queueSave
   * the moment it happens — the save starts immediately, not on a
   * timer. Only one save runs at a time and it always writes the
   * newest state: rapid changes (drag a job, then assign crew) queue
   * behind the in-flight save instead of racing it, so an older
   * snapshot can never land after a newer one and silently lose a
   * change. A failed save blocks further attempts until the next
   * change or a manual retry, and the failed state stays queued.
   */
  const savePending = useRef<AppState | null>(null);
  /**
   * Callbacks waiting for the queued snapshot to reach the database
   * (true) or for this login's saves to be dropped (false). They travel
   * with the snapshot: a newer snapshot includes the older change, so
   * its success answers them too.
   */
  const pendingWaiters = useRef<Array<(ok: boolean) => void>>([]);
  const saveRunning = useRef(false);
  const saveBlocked = useRef(false);
  /** See unsavedNonField: a change other than a field tap is not saved yet. */
  const [unsavedNonField, setUnsavedNonField] = useState(false);
  /** The save queue right now, for src/saveQueue.ts. */
  function saveQueueNow(): SaveQueueState {
    return {
      pending: savePending.current !== null,
      running: saveRunning.current,
      blocked: saveBlocked.current,
    };
  }
  const saveStatusTimer = useRef<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFailedTable, setSaveFailedTable] = useState<string | null>(null);
  /** Migration named by the last save failure, if it was a missing column/table (see src/saveErrors.ts). */
  const [saveMigrationHint, setSaveMigrationHint] = useState<string | null>(
    null,
  );
  /**
   * "Not allowed" notice from a save the database partly refused. It
   * belongs to the login whose change was refused: the next person to
   * sign in on this device never sees it.
   */
  const [saveRefusedFor, setSaveRefusedFor] = useState<{
    userId: string;
    text: string;
  } | null>(null);
  const saveRefused =
    saveRefusedFor && saveRefusedFor.userId === (authUser?.id ?? "")
      ? saveRefusedFor.text
      : null;
  const authIdRef = useRef("");
  useEffect(() => {
    authIdRef.current = authUser?.id ?? "";
  }, [authUser]);
  /**
   * Set when a save failed because the session had no company access
   * (expired, or waiting for its two-step code). It is retried by
   * itself after the next auth event.
   */
  const noAccessBlocked = useRef<string | null>(null);
  /**
   * Set when the database refused part of a save. The screen still
   * shows the refused change, so the real data is reloaded as soon as
   * no save is queued (a reload then cannot drop a pending change).
   */
  const reloadAfterSave = useRef(false);
  /**
   * Jobs this screen marked done whose database invoice has not been
   * loaded yet. "Create invoice from this job" waits for the reload
   * instead of making a second invoice for the same job.
   */
  const awaitingDoneInvoice = useRef(new Set<string>());

  const pumpSave = useCallback(async () => {
    if (saveRunning.current || saveBlocked.current) return;
    const next = savePending.current;
    if (!next) return;
    savePending.current = null;
    const waiters = pendingWaiters.current;
    pendingWaiters.current = [];
    saveRunning.current = true;
    if (saveStatusTimer.current !== null) {
      window.clearTimeout(saveStatusTimer.current);
      saveStatusTimer.current = null;
    }
    setSaveStatus("saving");
    let result: SaveResult = { ok: false };
    try {
      result = await adapterRef.current.saveState(next);
    } catch (e) {
      result = {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
    saveRunning.current = false;
    // Stamp our own save so the realtime listener ignores its echo
    // (see queueReload above) instead of re-fetching everything.
    lastOwnSaveAtRef.current = Date.now();
    if (result.refused && result.refused.length > 0) {
      // A clock tap the database refused as too old stays on the phone,
      // marked failed with the time to tell the office (before the
      // waiters below would forget it as sent).
      markTooOldTaps(result.refused.flatMap((r) => r.reasons));
      // The rest of the save was written; these changes never will
      // be. Say so once, and show the real data again.
      setSaveRefusedFor({
        userId: authIdRef.current,
        text: refusalNotice(result.refused),
      });
      reloadAfterSave.current = true;
    }
    if (result.noAccess) {
      // Not a refusal: the session itself has no access right now. The
      // change stays queued; check the sign-in again.
      noAccessBlocked.current = authIdRef.current;
      setAccessRecheck((n) => n + 1);
    }
    if (result.ok) {
      setSaveError(null);
      setSaveFailedTable(null);
      setSaveMigrationHint(null);
      setSaveStatus("saved");
      // Everything changed so far is saved, unless a newer change is queued.
      if (!savePending.current) setUnsavedNonField(false);
      for (const w of waiters) w(true);
      saveStatusTimer.current = window.setTimeout(() => {
        saveStatusTimer.current = null;
        if (!saveRunning.current && !savePending.current) {
          setSaveStatus("idle");
        }
      }, 2500);
    } else {
      // Keep a newer change queued while this one ran (it already
      // includes this one); otherwise retry this one.
      savePending.current = savePending.current ?? next;
      pendingWaiters.current = [...waiters, ...pendingWaiters.current];
      saveBlocked.current = true;
      setSaveFailedTable(result.failedTable ?? null);
      // When the database is missing a column/table the app expects,
      // the save error names the migration that adds it (see
      // src/saveErrors.ts) instead of a bare schema-cache error.
      const hint = migrationHintForSaveError(result.message ?? "");
      setSaveMigrationHint(hint);
      setSaveError(
        [
          result.failedTable
            ? `Couldn't save the ${result.failedTable} table`
            : "Couldn't save",
          result.message,
          hint,
        ]
          .filter(Boolean)
          .join(" — "),
      );
      setSaveStatus("error");
    }
    if (savePending.current && !saveBlocked.current) {
      void pumpSave();
    } else if (
      reloadAfterSave.current &&
      !savePending.current &&
      !saveBlocked.current
    ) {
      reloadAfterSave.current = false;
      reloadState();
    }
  }, [reloadState]);

  const queueSave = useCallback(
    (next: AppState, onSaved?: (ok: boolean) => void) => {
      savePending.current = next;
      if (onSaved) pendingWaiters.current.push(onSaved);
      // A fresh change is a fresh attempt, even after a failure.
      saveBlocked.current = false;
      void pumpSave();
    },
    [pumpSave],
  );

  const retrySave = useCallback(() => {
    saveBlocked.current = false;
    void pumpSave();
  }, [pumpSave]);

  const clearSaveError = useCallback(() => {
    // A failed save still queued is a change the database keeps refusing
    // (or that cannot reach it): drop it and load the real data again.
    // Leaving it queued would hold back every reload (realtime, role
    // changes) and the screen would go stale, so the next edit could
    // overwrite a teammate's newer change.
    if (dismissFailedSave(saveQueueNow()) === "drop-and-reload") {
      savePending.current = null;
      const dropped = pendingWaiters.current;
      pendingWaiters.current = [];
      for (const w of dropped) w(false);
      saveBlocked.current = false;
      reloadAfterSave.current = false;
      noAccessBlocked.current = null;
      setUnsavedNonField(false);
      reloadState(); // the queue is empty now, so this loads at once
    }
    setSaveError(null);
    setSaveFailedTable(null);
    setSaveMigrationHint(null);
    setSaveStatus("idle");
  }, [reloadState]);

  const clearSaveRefused = useCallback(() => setSaveRefusedFor(null), []);

  /** Nothing of this login's saves carries over to the next person. */
  const forgetSaves = useCallback(() => {
    savePending.current = null;
    const dropped = pendingWaiters.current;
    pendingWaiters.current = [];
    for (const w of dropped) w(false);
    saveBlocked.current = false;
    reloadAfterSave.current = false;
    noAccessBlocked.current = null;
    setUnsavedNonField(false);
    setSaveRefusedFor(null);
    setSaveError(null);
    setSaveFailedTable(null);
    setSaveMigrationHint(null);
    setSaveStatus("idle");
  }, []);

  // Set below, once retryFieldQueue exists.
  const retryFieldQueueRef = useRef<() => void>(() => {});
  const signOut = useCallback(async () => {
    // Clock and Done taps made without signal are still on the phone:
    // try to send them, and never wipe them without asking.
    // Taps refused as too old are never sent again: warned about apart.
    const queue = queuedFieldOps();
    const unsent = sendableFieldOps(queue).length;
    const refused = queue.filter((q) => q.tooOld).map((q) => q.tooOld as string);
    if (unsent > 0 || refused.length > 0) {
      if (unsent > 0 && (typeof navigator === "undefined" || navigator.onLine)) retryFieldQueueRef.current();
      const warning = unsentTapsWarning(unsent, refused);
      if (warning && !window.confirm(warning)) return;
    }
    // Wipe this device's copy of the company data FIRST, so it is gone
    // even if the network call below fails (a lost phone must not keep
    // the customer list). If the server sign-out fails, still end the
    // session on this device.
    await clearLocalCompanyData();
    if (supabase) {
      try {
        const { error } = await supabase.auth.signOut();
        if (error) await supabase.auth.signOut({ scope: "local" });
      } catch {
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          // Nothing else to do: the local data is already gone.
        }
      }
    }
    forgetSaves();
    setAuthUser(null);
    setState(null);
  }, [forgetSaves]);

  // The same when a session ends by itself (expired, ended by the
  // server, signed out in another tab) or another login takes over:
  // a change still queued from this login must never be sent with the
  // next person's sign-in.
  const savesForUser = useRef<string | null>(null);
  useEffect(() => {
    const id = authUser?.id ?? null;
    if (savesForUser.current !== null && savesForUser.current !== id) {
      forgetSaves();
    }
    savesForUser.current = id;
  }, [authUser, forgetSaves]);

  // A save that failed for lack of access is tried again after the next
  // auth event (token refreshed, back in the app, code entered).
  useEffect(() => {
    // Only for the login whose save it was.
    if (!noAccessBlocked.current || noAccessBlocked.current !== authIdRef.current) {
      return;
    }
    noAccessBlocked.current = null;
    retrySave();
  }, [authCheck, retrySave]);

  const mutateWith = useCallback(
    (fn: (prev: AppState) => AppState, onSaved: ((ok: boolean) => void) | undefined, fieldTap: boolean) => {
      // A change that is not a field tap is kept only in memory until it saves.
      if (!fieldTap) setUnsavedNonField(true);
      // React may run this updater twice (development); answer once.
      let answered = false;
      const once = onSaved
        ? (ok: boolean) => {
            if (answered) return;
            answered = true;
            onSaved(ok);
          }
        : undefined;
      setState((prev) => {
        if (!prev) return prev;
        // The database's "Done invoice" rules, shown at once (see autoInvoice.ts).
        const next = applyAutoSendRules(prev, fn(prev));
        // A job marked done may get its invoice from the database: show
        // it once this save is through (and until then, "Create invoice"
        // for that job waits for it).
        if (supabaseMode && role !== "crew") {
          const done = jobsMarkedDone(prev, next);
          if (done.length > 0) {
            reloadAfterSave.current = true;
            for (const id of done) awaitingDoneInvoice.current.add(id);
          }
        }
        // Done taken back: the database may remove the automatic invoice.
        if (supabaseMode && reopenedJobWithAutoInvoice(prev, next)) reloadAfterSave.current = true;
        queueSave(next, once);
        return next;
      });
    },
    [queueSave, supabaseMode, role],
  );
  const mutate = useCallback(
    (fn: (prev: AppState) => AppState, onSaved?: (ok: boolean) => void) => mutateWith(fn, onSaved, false),
    [mutateWith],
  );

  /**
   * Crew field actions (clock in/out, Arrived, Done) are kept on the
   * phone until a save containing them succeeds (src/fieldQueue.ts), so
   * one made without signal is sent when the signal returns.
   */
  const runFieldOp = useCallback(
    (op: FieldOp, label: string) => {
      addFieldOp(op, label);
      mutateWith(
        (p) => applyFieldOp(p, op),
        (ok) => {
          if (ok) fieldOpsSent([op.id]);
        },
        true,
      );
    },
    [mutateWith],
  );
  const retryFieldQueue = useCallback(() => {
    const current = stateRef.current;
    // Taps refused as too old are not sent again (they wait for the office).
    const queued = sendableFieldOps(queuedFieldOps());
    if (!current || queued.length === 0) return;
    // Someone changed the job since: their change wins. Checked in tap
    // order, each after the earlier ones (Arrived, then Done).
    fieldOpsSent(staleFieldOpIds(current, queued.map((q) => q.op)));
    const live = sendableFieldOps(queuedFieldOps());
    if (live.length === 0) return;
    const ids = live.map((q) => q.op.id);
    setFieldOpsState("sending");
    mutateWith(
      (p) => applyFieldOps(p, live.map((q) => q.op)),
      (ok) => {
        if (ok) fieldOpsSent(ids);
      },
      true,
    );
  }, [mutateWith]);
  useEffect(() => {
    retryFieldQueueRef.current = retryFieldQueue;
  }, [retryFieldQueue]);
  // A newer build was deployed (src/buildCheck.ts): reload onto it once
  // nothing unsaved would be lost and no panel (a form being filled in)
  // is open. Checked when the app comes back on screen, every few
  // minutes, and after a load or save error (an old build may be what
  // the database now refuses).
  const [newerBuild, setNewerBuild] = useState<string | null>(null);
  const checkBuild = useCallback(async () => {
    if (BUILD_ID === "dev") return;
    const latest = await latestBuildId();
    if (buildAction(BUILD_ID, latest, false) === "reload") setNewerBuild(latest);
  }, []);
  useEffect(() => {
    if (BUILD_ID === "dev") return;
    const onShow = () => {
      if (document.visibilityState === "visible") void checkBuild();
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    const timer = window.setInterval(() => void checkBuild(), BUILD_CHECK_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      window.clearInterval(timer);
    };
  }, [checkBuild]);
  useEffect(() => {
    if (loadError || saveStatus === "error") void checkBuild();
  }, [loadError, saveStatus, checkBuild]);
  const panelsOpen = drawerStack.length > 0;
  useEffect(() => {
    if (!newerBuild) return;
    const unsaved = hasUnsavedChange(saveQueueNow()) || unsavedNonField || panelsOpen;
    if (buildAction(BUILD_ID, newerBuild, unsaved) === "reload") void reloadToNewBuild(newerBuild);
    // saveQueueNow reads refs; saveStatus changes whenever the queue does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newerBuild, saveStatus, unsavedNonField, panelsOpen]);

  // This login's queue; after a load, anything still queued is applied
  // and sent again; "no signal" vs "the database said no" from the save
  // result; and a retry when the phone is back online.
  const fieldQueueUser = authUser?.id ?? (supabaseMode ? null : "local");
  useEffect(() => {
    selectFieldQueueUser(fieldQueueUser);
  }, [fieldQueueUser]);
  const stateLoaded = state !== null;
  const replayedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!stateLoaded || !fieldQueueUser || replayedFor.current === fieldQueueUser) return;
    replayedFor.current = fieldQueueUser;
    retryFieldQueue();
  }, [stateLoaded, fieldQueueUser, retryFieldQueue]);
  useEffect(() => {
    if (saveStatus !== "error") return;
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    setFieldOpsState(isNoSignalError(saveError, online) ? "waiting" : "failed", ["sending", "waiting"]);
  }, [saveStatus, saveError]);
  useEffect(() => {
    const onOnline = () => retryFieldQueue();
    window.addEventListener("online", onOnline);
    const timer = window.setInterval(() => {
      if (navigator.onLine && queuedFieldOps().some((q) => q.state === "waiting")) retryFieldQueue();
    }, 30000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
    };
  }, [retryFieldQueue]);

  /**
   * Owner approvals. Each one writes the database first and only
   * updates local state on success, so a failed write (e.g.
   * migration 006 not run yet, so the owner policy is missing) never
   * shows a permission the user does not actually have.
   */
  const approveMember = useCallback(
    async (
      crewId: string,
      jobRole: string,
      appRole: Role,
    ): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      const m = stateRef.current?.crew.find((c) => c.id === crewId);
      if (!m) return "That crew member was not found.";
      if (!m.authUserId) {
        return "No login is linked to this person yet — they need to sign up in the app first.";
      }
      const { error: memberError } = await supabase
        .from("company_members")
        .upsert(
          {
            user_id: m.authUserId,
            company_id: supabaseConfig.companyId,
            role: appRole,
          },
          { onConflict: "user_id,company_id" },
        );
      if (memberError) return membershipError(memberError);
      // Direct update (not the adapter): the status flip to active
      // must land in the database even though the adapter only sends
      // non-default statuses.
      const { error: crewError } = await supabase
        .from("crew")
        .update({ status: "active", role: jobRole, app_role: appRole })
        .eq("id", crewId)
        .eq("company_id", supabaseConfig.companyId);
      if (crewError) return crewError.message;
      const next: CrewMember = {
        ...m,
        status: "active",
        role: jobRole,
        appRole,
      };
      mutate((p) => ({
        ...p,
        crew: p.crew.map((x) => (x.id === crewId ? next : x)),
        auditLog: appendAudit(
          p.auditLog,
          diffFields(ctx("User", crewId, m.name, null), m, next, [
            "status",
            "role",
            "appRole",
          ]),
        ),
      }));
      setMemberRoles((prev) => ({ ...prev, [m.authUserId as string]: appRole }));
      return null;
    },
    [mutate],
  );

  const rejectMember = useCallback(
    async (crewId: string): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      const m = stateRef.current?.crew.find((c) => c.id === crewId);
      if (!m) return "That crew member was not found.";
      const { error } = await supabase
        .from("crew")
        .delete()
        .eq("id", crewId)
        .eq("company_id", supabaseConfig.companyId);
      if (error) return error.message;
      mutate((p) => ({
        ...p,
        crew: p.crew.filter((x) => x.id !== crewId),
        auditLog: appendAudit(p.auditLog, [
          deletedEntry(ctx("User", crewId, m.name, null)),
        ]),
      }));
      return null;
    },
    [mutate],
  );

  const revokeMember = useCallback(
    async (crewId: string): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      const m = stateRef.current?.crew.find((c) => c.id === crewId);
      if (!m) return "That crew member was not found.";
      if (!m.authUserId) return "No login is linked to this person.";
      if (m.authUserId === authUser?.id) {
        return "You can't remove your own access.";
      }
      // .select() returns the deleted rows: zero rows means the
      // database refused (row-level security hides a blocked row
      // instead of raising an error).
      const { data: removed, error: memberError } = await supabase
        .from("company_members")
        .delete()
        .eq("user_id", m.authUserId)
        .eq("company_id", supabaseConfig.companyId)
        .select("user_id");
      if (memberError) return membershipError(memberError);
      if (!removed || removed.length === 0) return NO_MEMBERSHIP_PERMISSION;
      const { error: crewError } = await supabase
        .from("crew")
        .update({ status: "revoked" })
        .eq("id", crewId)
        .eq("company_id", supabaseConfig.companyId);
      if (crewError) return crewError.message;
      const next: CrewMember = { ...m, status: "revoked" };
      mutate((p) => ({
        ...p,
        crew: p.crew.map((x) => (x.id === crewId ? next : x)),
        auditLog: appendAudit(
          p.auditLog,
          diffFields(ctx("User", crewId, m.name, null), m, next, ["status"]),
        ),
      }));
      setMemberRoles((prev) => {
        const copy = { ...prev };
        delete copy[m.authUserId as string];
        return copy;
      });
      return null;
    },
    [mutate, authUser],
  );

  /**
   * Two-step login, step 2 of signing in: check the 6-digit code from
   * the authenticator app. On success this session can see company
   * data again. Returns an error message, or null.
   */
  const confirmTwoStepCode = useCallback(
    async (code: string): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      const { data: factors, error: listError } =
        await supabase.auth.mfa.listFactors();
      if (listError) return listError.message;
      const factor = factors?.totp?.find((f) => f.status === "verified");
      const userId = authUser?.id;
      if (!factor) {
        // Two-step login was reset meanwhile: the password is enough.
        if (userId) setTwoStepFor({ userId, status: "ok" });
        return null;
      }
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: code.trim(),
      });
      if (error) {
        return /invalid|expired/i.test(error.message)
          ? "That code didn't work. Codes change every 30 seconds; type the one showing now."
          : error.message;
      }
      if (userId) setTwoStepFor({ userId, status: "ok" });
      return null;
    },
    [authUser],
  );

  /** Owners and managers: login ids of team members with two-step login on. */
  const loadTwoStepLogins = useCallback(async (): Promise<string[]> => {
    if (!supabase) return [];
    const { data, error } = await supabase.rpc("two_step_logins", {
      p_company_id: supabaseConfig.companyId,
    });
    if (error || !Array.isArray(data)) return [];
    return (data as Array<{ user_id: string }>).map((r) => r.user_id);
  }, []);

  /**
   * Owners and managers: reset a team member's two-step login (lost
   * phone). They then sign in with just their password and can turn
   * it on again. Only an owner can reset an owner's (the database
   * checks). Returns an error message, or null.
   */
  const resetTwoStepLogin = useCallback(
    async (crewId: string): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      const m = stateRef.current?.crew.find((c) => c.id === crewId);
      if (!m) return "That crew member was not found.";
      if (!m.authUserId) return "No login is linked to this person.";
      const { error } = await supabase.rpc("reset_two_step_login", {
        p_company_id: supabaseConfig.companyId,
        p_user_id: m.authUserId,
      });
      if (error) return error.message;
      mutate((p) => ({
        ...p,
        auditLog: appendAudit(
          p.auditLog,
          diffFields(
            ctx("User", crewId, m.name, null),
            { twoStepLogin: "on" },
            { twoStepLogin: "reset" },
            ["twoStepLogin"],
            { twoStepLogin: "two-step login" },
          ),
        ),
      }));
      return null;
    },
    [mutate],
  );

  const changeMemberRole = useCallback(
    async (crewId: string, appRole: Role): Promise<string | null> => {
      if (!supabase) return "Supabase is not configured.";
      const m = stateRef.current?.crew.find((c) => c.id === crewId);
      if (!m) return "That crew member was not found.";
      if (!m.authUserId) return "No login is linked to this person.";
      const { data: changed, error } = await supabase
        .from("company_members")
        .update({ role: appRole })
        .eq("user_id", m.authUserId)
        .eq("company_id", supabaseConfig.companyId)
        .select("user_id");
      if (error) return membershipError(error);
      if (!changed || changed.length === 0) return NO_MEMBERSHIP_PERMISSION;
      const next: CrewMember = { ...m, appRole };
      mutate((p) => ({
        ...p,
        crew: p.crew.map((x) => (x.id === crewId ? next : x)),
        auditLog: appendAudit(
          p.auditLog,
          diffFields(ctx("User", crewId, m.name, null), m, next, ["appRole"]),
        ),
      }));
      setMemberRoles((prev) => ({ ...prev, [m.authUserId as string]: appRole }));
      return null;
    },
    [mutate],
  );

  /** Lookup helpers used to attach audit records to the right customer. */
  const crewName = (p: AppState, id: string | null): string =>
    id ? (p.crew.find((c) => c.id === id)?.name ?? "(unknown)") : "(unassigned)";
  const customerName = (p: AppState, id: string): string => {
    const c = p.customers.find((x) => x.id === id);
    return c ? `${c.firstName} ${c.lastName}` : "(unknown customer)";
  };
  const jobCustomerId = (p: AppState, jobId: string | null): string | null =>
    jobId ? (p.jobs.find((j) => j.id === jobId)?.customerId ?? null) : null;
  const ctx = (
    entity: string,
    entityId: string,
    entityLabel: string,
    customerId: string | null,
    jobId?: string | null,
  ): AuditContext => ({
    actor: actorRef.current,
    entity,
    entityId,
    entityLabel,
    customerId,
    jobId: jobId ?? null,
  });

  const saveCustomer = useCallback(
    (c: Customer) =>
      mutate((p) => {
        const old = p.customers.find((x) => x.id === c.id);
        const label = `${c.firstName} ${c.lastName}`;
        // Keep the legacy address/city/zip fields mirroring the
        // primary address, so older code, imports, and search keep
        // working. Exactly one primary: the first marked one wins,
        // else the first address.
        const cleaned = (c.addresses ?? [])
          .filter(
            (a) =>
              a.street.trim() !== "" ||
              a.city.trim() !== "" ||
              a.zip.trim() !== "" ||
              a.label.trim() !== "",
          )
          .map((a) => ({ ...a }));
        const primaryIdx = cleaned.findIndex((a) => a.isPrimary);
        cleaned.forEach(
          (a, i) => {
            a.isPrimary = primaryIdx >= 0 ? i === primaryIdx : i === 0;
          },
        );
        const primary = cleaned[0];
        const normalized: Customer = {
          ...c,
          addresses: cleaned,
          address: primary ? primary.street : c.address,
          city: primary ? primary.city : c.city,
          zip: primary ? primary.zip : c.zip,
        };
        const addrStr = (x: Customer | undefined) =>
          x ? customerAddresses(x).map(addressDisplay).join(" | ") : "";
        const entries = old
          ? diffFields(
              ctx("Customer", c.id, label, c.id),
              { ...old, addresses: addrStr(old) },
              { ...normalized, addresses: addrStr(normalized) },
              [
                "firstName",
                "lastName",
                "company",
                "phone",
                "email",
                "address",
                "city",
                "zip",
                "addresses",
                "propertyNotes",
                "gateCode",
                "notes",
                "mapLat",
                "mapLng",
                "boundary",
                "type",
                "companyName",
                "projectName",
                "projectNumber",
                "poNumber",
                "contractNumber",
                "jobSiteAddress",
                "billingTerms",
                "contacts",
              ],
              { addresses: "addresses" },
            )
          : [createdEntry(ctx("Customer", c.id, label, c.id))];
        return {
          ...p,
          customers: old
            ? p.customers.map((x) => (x.id === c.id ? normalized : x))
            : [...p.customers, normalized],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteCustomer = useCallback(
    (id: string) =>
      mutate((p) => {
        const c = p.customers.find((x) => x.id === id);
        if (!c) return p;
        const label = `${c.firstName} ${c.lastName}`;
        const entries = [
          deletedEntry(ctx("Customer", id, label, id)),
          ...p.jobs
            .filter((j) => j.customerId === id)
            .map((j) => deletedEntry(ctx("Job", j.id, j.title, id, j.id))),
          ...p.trees
            .filter((t) => t.customerId === id)
            .map((t) => deletedEntry(ctx("Tree", t.id, t.label, id))),
          ...p.estimates
            .filter((e) => e.customerId === id)
            .map((e) => deletedEntry(ctx("Estimate", e.id, e.title, id))),
          ...p.invoices
            .filter((i) => i.customerId === id)
            .map((i) => deletedEntry(ctx("Invoice", i.id, i.number, id))),
          ...p.phcPrograms
            .filter((x) => x.customerId === id)
            .map((x) => deletedEntry(ctx("PHC program", x.id, x.name, id))),
        ];
        return {
          ...p,
          customers: p.customers.filter((x) => x.id !== id),
          jobs: p.jobs.filter((j) => j.customerId !== id),
          trees: p.trees.filter((t) => t.customerId !== id),
          estimates: p.estimates.filter((e) => e.customerId !== id),
          invoices: p.invoices.filter((i) => i.customerId !== id),
          notes: p.notes.filter((n) => n.customerId !== id),
          messages: (p.messages ?? []).filter((m) => m.customerId !== id),
          phcPrograms: p.phcPrograms.filter((x) => x.customerId !== id),
          phcVisits: p.phcVisits.filter(
            (v) =>
              !p.phcPrograms.some(
                (x) => x.id === v.programId && x.customerId === id,
              ),
          ),
          chemicalRecords: p.chemicalRecords.filter(
            (r) =>
              !p.phcPrograms.some(
                (x) => x.id === r.programId && x.customerId === id,
              ),
          ),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const saveTree = useCallback(
    (t: Tree) =>
      mutate((p) => {
        const old = p.trees.find((x) => x.id === t.id);
        const c = ctx("Tree", t.id, t.label, t.customerId);
        const entries = old
          ? diffFields(c, old, t, [
              "label",
              "species",
              "dbh",
              "height",
              "condition",
              "status",
              "notes",
              "lat",
              "lng",
              "dbhHistory",
              "conditionHistory",
              "riskRating",
              "riskNotes",
              "nextInspectionDate",
            ])
          : [createdEntry(c)];
        return {
          ...p,
          trees: old
            ? p.trees.map((x) => (x.id === t.id ? t : x))
            : [...p.trees, t],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteTree = useCallback(
    (id: string) =>
      mutate((p) => {
        const t = p.trees.find((x) => x.id === id);
        if (!t) return p;
        return {
          ...p,
          trees: p.trees.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(ctx("Tree", id, t.label, t.customerId)),
          ]),
        };
      }),
    [mutate],
  );

  const savePhcProgram = useCallback(
    (prog: PhcProgram) =>
      mutate((p) => {
        const old = p.phcPrograms.find((x) => x.id === prog.id);
        const c = ctx(
          "PHC program",
          prog.id,
          prog.name,
          prog.customerId,
        );
        const entries = old
          ? diffFields(c, old, prog, [
              "name",
              "type",
              "status",
              "startDate",
              "renewalDate",
              "visitIntervalMonths",
              "notes",
              "treeId",
            ])
          : [createdEntry(c)];
        return {
          ...p,
          phcPrograms: old
            ? p.phcPrograms.map((x) => (x.id === prog.id ? prog : x))
            : [...p.phcPrograms, prog],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deletePhcProgram = useCallback(
    (id: string) =>
      mutate((p) => {
        const prog = p.phcPrograms.find((x) => x.id === id);
        if (!prog) return p;
        return {
          ...p,
          phcPrograms: p.phcPrograms.filter((x) => x.id !== id),
          phcVisits: p.phcVisits.filter((v) => v.programId !== id),
          chemicalRecords: p.chemicalRecords.filter(
            (r) => r.programId !== id,
          ),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx("PHC program", id, prog.name, prog.customerId),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const savePhcVisit = useCallback(
    (visit: PhcVisit) =>
      mutate((p) => {
        const old = p.phcVisits.find((x) => x.id === visit.id);
        const prog = p.phcPrograms.find((x) => x.id === visit.programId);
        const c = ctx(
          "PHC visit",
          visit.id,
          `${prog?.name ?? "Program"} — ${visit.date}`,
          prog?.customerId ?? null,
        );
        const entries = old
          ? diffFields(c, old, visit, ["date", "status", "notes"])
          : [createdEntry(c)];
        return {
          ...p,
          phcVisits: old
            ? p.phcVisits.map((x) => (x.id === visit.id ? visit : x))
            : [...p.phcVisits, visit],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const saveChemicalRecord = useCallback(
    (rec: ChemicalRecord) =>
      mutate((p) => {
        const old = p.chemicalRecords.find((x) => x.id === rec.id);
        const prog = p.phcPrograms.find((x) => x.id === rec.programId);
        const c = ctx(
          "Chemical record",
          rec.id,
          `${rec.product} — ${rec.date}`,
          prog?.customerId ?? null,
        );
        const entries = old
          ? diffFields(c, old, rec, ["date", "product", "rate", "applicator", "notes"])
          : [createdEntry(c)];
        return {
          ...p,
          chemicalRecords: old
            ? p.chemicalRecords.map((x) => (x.id === rec.id ? rec : x))
            : [...p.chemicalRecords, rec],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteChemicalRecord = useCallback(
    (id: string) =>
      mutate((p) => {
        const rec = p.chemicalRecords.find((x) => x.id === id);
        if (!rec) return p;
        const prog = p.phcPrograms.find((x) => x.id === rec.programId);
        return {
          ...p,
          chemicalRecords: p.chemicalRecords.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Chemical record",
                id,
                `${rec.product} — ${rec.date}`,
                prog?.customerId ?? null,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const saveEquipment = useCallback(
    (eq: Equipment) =>
      mutate((p) => {
        const old = p.equipment.find((x) => x.id === eq.id);
        const c = ctx("Equipment", eq.id, eq.name, null);
        const entries = old
          ? diffFields(c, old, eq, [
              "name",
              "kind",
              "details",
              "status",
              "down",
              "tows",
              "seats",
              "weightLbs",
              "weeklyDriverLimit",
              "homeSite",
            ])
          : [createdEntry(c)];
        return {
          ...p,
          equipment: old
            ? p.equipment.map((x) => (x.id === eq.id ? eq : x))
            : [...p.equipment, eq],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const setEquipmentDown = useCallback(
    (equipmentId: string, down: boolean) =>
      mutate((p) => {
        // Managers only — the crew report problems by leaving a
        // comment, they don't flip the status themselves.
        if (!isOwnerLike(role)) return p;
        const old = p.equipment.find((x) => x.id === equipmentId);
        if (!old || old.down === down) return p;
        const next: Equipment = { ...old, down };
        const c = ctx("Equipment", old.id, old.name, null);
        return {
          ...p,
          equipment: p.equipment.map((x) =>
            x.id === equipmentId ? next : x,
          ),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(c, old, next, ["down"]),
          ),
        };
      }),
    [mutate, role],
  );

  const deleteEquipment = useCallback(
    (id: string) =>
      mutate((p) => {
        const eq = p.equipment.find((x) => x.id === id);
        if (!eq) return p;
        return {
          ...p,
          equipment: p.equipment.filter((x) => x.id !== id),
          // Unassign it from every job that had it booked.
          jobs: p.jobs.map((j) => ({
            ...j,
            equipmentIds: (j.equipmentIds ?? []).filter((x) => x !== id),
          })),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(ctx("Equipment", id, eq.name, null)),
          ]),
        };
      }),
    [mutate],
  );

  /** Equipment maintenance schedules and logs. */
  const saveMaintenanceTask = useCallback(
    (t: MaintenanceTask) =>
      mutate((p) => {
        const old = p.maintenanceTasks.find((x) => x.id === t.id);
        const eq = p.equipment.find((x) => x.id === t.equipmentId);
        const c = ctx(
          "Maintenance task",
          t.id,
          `${eq?.name ?? "Equipment"} — ${t.name}`,
          null,
        );
        const entries = old
          ? diffFields(c, old, t, ["name", "intervalDays", "equipmentId"])
          : [createdEntry(c)];
        return {
          ...p,
          maintenanceTasks: old
            ? p.maintenanceTasks.map((x) => (x.id === t.id ? t : x))
            : [...p.maintenanceTasks, t],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteMaintenanceTask = useCallback(
    (id: string) =>
      mutate((p) => {
        const t = p.maintenanceTasks.find((x) => x.id === id);
        if (!t) return p;
        const eq = p.equipment.find((x) => x.id === t.equipmentId);
        return {
          ...p,
          maintenanceTasks: p.maintenanceTasks.filter((x) => x.id !== id),
          maintenanceRecords: p.maintenanceRecords.filter(
            (r) => r.taskId !== id,
          ),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Maintenance task",
                id,
                `${eq?.name ?? "Equipment"} — ${t.name}`,
                null,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const logMaintenance = useCallback(
    (r: MaintenanceRecord) =>
      mutate((p) => {
        const old = p.maintenanceRecords.find((x) => x.id === r.id);
        const task = p.maintenanceTasks.find((x) => x.id === r.taskId);
        const eq = task
          ? p.equipment.find((x) => x.id === task.equipmentId)
          : undefined;
        const c = ctx(
          "Maintenance record",
          r.id,
          `${task?.name ?? "Service"} — ${eq?.name ?? "Equipment"} · ${r.date}`,
          null,
        );
        const entries = old
          ? diffFields(c, old, r, ["date", "hours", "notes", "doneBy"])
          : [createdEntry(c)];
        return {
          ...p,
          maintenanceRecords: old
            ? p.maintenanceRecords.map((x) => (x.id === r.id ? r : x))
            : [...p.maintenanceRecords, r],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteMaintenanceRecord = useCallback(
    (id: string) =>
      mutate((p) => {
        const r = p.maintenanceRecords.find((x) => x.id === id);
        if (!r) return p;
        const task = p.maintenanceTasks.find((x) => x.id === r.taskId);
        const eq = task
          ? p.equipment.find((x) => x.id === task.equipmentId)
          : undefined;
        return {
          ...p,
          maintenanceRecords: p.maintenanceRecords.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Maintenance record",
                id,
                `${task?.name ?? "Service"} — ${eq?.name ?? "Equipment"} · ${r.date}`,
                null,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const addEquipmentNote = useCallback(
    (equipmentId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const note: EquipmentNote = {
        id: uid(),
        equipmentId,
        authorId: viewerCrewId || "owner",
        authorName: viewerName,
        text: trimmed,
        createdAt: new Date().toISOString(),
      };
      mutate((p) => {
        const eq = p.equipment.find((x) => x.id === equipmentId);
        return {
          ...p,
          equipmentNotes: [...(p.equipmentNotes ?? []), note],
          auditLog: appendAudit(p.auditLog, [
            createdEntry(
              ctx(
                "Equipment note",
                note.id,
                `${eq?.name ?? "Equipment"} — ${viewerName}: ${trimmed}`,
                null,
              ),
            ),
          ]),
        };
      });
    },
    [mutate, viewerCrewId, viewerName],
  );

  const saveCompanyDocument = useCallback(
    (d: CompanyDocument) =>
      mutate((p) => {
        const list = p.companyDocuments ?? [];
        const old = list.find((x) => x.id === d.id);
        const c = ctx(
          "Licence or insurance",
          d.id,
          `${documentKindLabel(d.kind)}${d.name ? ` — ${d.name}` : ""}`,
          null,
        );
        const entries = old
          ? diffFields(c, old, d, [
              "kind",
              "name",
              "crewId",
              "issuer",
              "startDate",
              "expiryDate",
              "notes",
              "fileName",
            ])
          : [createdEntry(c)];
        return {
          ...p,
          companyDocuments: old
            ? list.map((x) => (x.id === d.id ? d : x))
            : [...list, d],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteCompanyDocument = useCallback(
    (id: string) =>
      mutate((p) => {
        const list = p.companyDocuments ?? [];
        const d = list.find((x) => x.id === id);
        if (!d) return p;
        return {
          ...p,
          companyDocuments: list.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Licence or insurance",
                id,
                `${documentKindLabel(d.kind)}${d.name ? ` — ${d.name}` : ""}`,
                null,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const deleteEquipmentNote = useCallback(
    (id: string) =>
      mutate((p) => {
        const n = p.equipmentNotes.find((x) => x.id === id);
        if (!n) return p;
        // Its author, or an owner/manager — nobody else.
        const isAuthor = n.authorId === viewerCrewId;
        const isOwner = isOwnerLike(viewer?.appRole);
        if (!isAuthor && !isOwner) return p;
        const eq = p.equipment.find((x) => x.id === n.equipmentId);
        return {
          ...p,
          equipmentNotes: p.equipmentNotes.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Equipment note",
                id,
                `${eq?.name ?? "Equipment"} — ${n.authorName}: ${n.text}`,
                null,
              ),
            ),
          ]),
        };
      }),
    [mutate, viewer, viewerCrewId],
  );

  /**
   * Accept a proposal option with a typed name (preview e-sign — no
   * real signature capture, no payment). The estimate becomes
   * accepted with the chosen option, and a job is created from that
   * option's lines so the work can be scheduled.
   */
  const acceptProposal = useCallback(
    (estimateId: string, optionId: string, signedBy: string): string | null => {
      const est = stateRef.current?.estimates.find((e) => e.id === estimateId);
      if (!est) return null;
      const option = (est.options ?? []).find((o) => o.id === optionId);
      if (!option) return null;
      const jobId = uid();
      const now = new Date().toISOString();
      mutate((p) => {
        const fresh = p.estimates.find((e) => e.id === estimateId);
        if (!fresh) return p;
        const accepted: Estimate = {
          ...fresh,
          status: "accepted",
          acceptedOptionId: optionId,
          acceptedBy: signedBy.trim(),
          acceptedAt: now,
        };
        const job: Job = {
          id: jobId,
          customerId: fresh.customerId,
          serviceType: serviceTypeForEstimate(fresh),
          title: `${fresh.title} — ${option.label}`,
          date: todayStr(),
          startTime: "08:00",
          status: "scheduled",
          crewIds: [],
          notes: `Accepted proposal option "${option.label}" signed by ${signedBy.trim()} (preview e-sign).`,
          customerNotes: "",
          teamNotes: "",
          officeNotes: "",
          pruneClass: null,
          estimatedHours: null,
          estimateId: fresh.id,
          invoiceId: null,
          value: null,
          // The estimator's expected crew, set while quoting — caps the suggested
          // crew. Carried from the estimate so the job keeps it.
          expectedCrew: fresh.expectedCrew ?? null,
          equipmentDrivers: null,
          treeIds: [
            ...new Set(
              option.lines
                .map((l) => l.treeId)
                .filter((t): t is string => Boolean(t)),
            ),
          ],
          // The estimator's equipment. Named crew are not put on: this
          // job's day is only a placeholder until the office schedules
          // it (see jobFromEstimate).
          equipmentIds: [...new Set(fresh.equipmentIds ?? [])],
          endDate: null,
          recurring: null,
          recurringUntil: null,
          materialsCost: null,
          otherCost: null,
          laborRate: null,
          lat: null,
          lng: null,
        };
        const entries = [
          ...diffFields(
            ctx("Estimate", fresh.id, fresh.title, fresh.customerId, fresh.jobId),
            { status: fresh.status, acceptedOption: "(none)" },
            { status: "accepted", acceptedOption: option.label },
            ["status", "acceptedOption"],
            { acceptedOption: "accepted option" },
          ),
          createdEntry(
            ctx("Job", job.id, job.title, job.customerId, job.id),
          ),
        ];
        return {
          ...p,
          estimates: p.estimates.map((e) =>
            e.id === estimateId ? accepted : e,
          ),
          jobs: [...p.jobs, job],
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
      return jobId;
    },
    [mutate],
  );

  const saveJob = useCallback(
    (saved0: Job) => {
      // Unavailable people are never added to a job (business rule).
      const cur = stateRef.current;
      if (cur) {
        const before = cur.jobs.find((x) => x.id === saved0.id)?.crewIds ?? [];
        const { blocked } = onlyAvailableAdded(cur, before, saved0.crewIds, saved0.date);
        if (blocked.length > 0) showFlash(blockedLine(blocked), { tone: "warn" });
      }
      mutate((p) => {
        const prev = p.jobs.find((x) => x.id === saved0.id);
        const saved: Job = {
          ...saved0,
          crewIds: onlyAvailableAdded(p, prev?.crewIds ?? [], saved0.crewIds, saved0.date).ids,
        };
        const old = prev;
        const j: Job = old ? { ...saved, crewArrivals: keepArrivals(old, saved) } : saved;
        const c = ctx("Job", j.id, j.title, j.customerId, j.id);
        const entries = old
          ? [
              ...diffFields(
                c,
                old,
                j,
                [
                  "customerId",
                  "serviceType",
                  "title",
                  "date",
                  "startTime",
                  "timePromised",
                  "status",
                  "notes",
                  "customerNotes",
                  "teamNotes",
                  "officeNotes",
                  "pruneClass",
                  "estimatedHours",
                  "value",
                  "billingType",
                  "hourlyRate",
                  "treeIds",
                  "equipmentIds",
                  "endDate",
                  "recurring",
                  "recurringUntil",
                  "materialsCost",
                  "otherCost",
                  "laborRate",
                ],
                { customerId: "customer" },
              ),
              // Crew changes log per person added/removed, not as a
              // whole-list blob.
              ...memberChangeEntries(
                c,
                j.crewIds
                  .filter((id) => !old.crewIds.includes(id))
                  .map((id) => crewName(p, id)),
                old.crewIds
                  .filter((id) => !j.crewIds.includes(id))
                  .map((id) => crewName(p, id)),
              ),
            ]
          : [createdEntry(c)];
        return {
          ...p,
          jobs: old
            ? p.jobs.map((x) => (x.id === j.id ? j : x))
            : [...p.jobs, j],
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
    },
    [mutate],
  );

  const rescheduleJob = useCallback(
    (jobId: string, date: string) =>
      mutate((p) => {
        const old = p.jobs.find((j) => j.id === jobId);
        if (!old || old.date === date) return p;
        const next: Job = { ...old, date };
        const c = ctx("Job", jobId, old.title, old.customerId, jobId);
        return {
          ...p,
          jobs: p.jobs.map((j) => (j.id === jobId ? next : j)),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(c, old, next, ["date"]),
          ),
        };
      }),
    [mutate],
  );

  const moveJob = useCallback(
    (jobId: string, date: string, startTime: string) =>
      mutate((p) => {
        const old = p.jobs.find((j) => j.id === jobId);
        if (!old || (old.date === date && old.startTime === startTime))
          return p;
        const moved: Job = { ...old, date, startTime };
        const next: Job = { ...moved, crewArrivals: keepArrivals(old, moved) };
        const c = ctx("Job", jobId, old.title, old.customerId, jobId);
        return {
          ...p,
          jobs: p.jobs.map((j) => (j.id === jobId ? next : j)),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(c, old, next, ["date", "startTime"]),
          ),
        };
      }),
    [mutate],
  );

  /**
   * Quick-assign a job's crew from the Dashboard: replace the job's
   * crew list in one step. No-op when nothing changed. Crew changes
   * log per person added/removed, like saveJob.
   */
  const setJobCrew = useCallback(
    (jobId: string, crewIds0: string[]) => {
      const cur = stateRef.current;
      const curJob = cur?.jobs.find((j) => j.id === jobId);
      if (cur && curJob) {
        const { blocked } = onlyAvailableAdded(cur, curJob.crewIds, crewIds0, curJob.date);
        if (blocked.length > 0) showFlash(blockedLine(blocked), { tone: "warn" });
      }
      mutate((p) => {
        const old = p.jobs.find((j) => j.id === jobId);
        if (!old) return p;
        const crewIds = onlyAvailableAdded(p, old.crewIds, crewIds0, old.date).ids;
        const same =
          old.crewIds.length === crewIds.length &&
          old.crewIds.every((id) => crewIds.includes(id));
        if (same) return p;
        const recrewed: Job = { ...old, crewIds };
        const next: Job = { ...recrewed, crewArrivals: keepArrivals(old, recrewed) };
        const c = ctx("Job", jobId, old.title, old.customerId, jobId);
        return {
          ...p,
          jobs: p.jobs.map((j) => (j.id === jobId ? next : j)),
          auditLog: appendAudit(
            p.auditLog,
            memberChangeEntries(
              c,
              crewIds
                .filter((id) => !old.crewIds.includes(id))
                .map((id) => crewName(p, id)),
              old.crewIds
                .filter((id) => !crewIds.includes(id))
                .map((id) => crewName(p, id)),
            ),
          ),
        };
      });
    },
    [mutate],
  );

  /**
   * Live-progress status tap (see setJobStatus above). Uses the
   * shared applyJobStatus transition so the no-op rule lives in
   * one place; audit-logged like setJobCrew. A status change saves
   * like any other job edit, so it propagates over realtime (jobs
   * is in the "app-changes" subscription) to every signed-in
   * screen within about a second.
   */
  const setJobStatus = useCallback(
    (jobId: string, status: JobStatus) => {
      const p = stateRef.current;
      if (!p) return;
      const nextJobs = applyJobStatus(p.jobs, jobId, status);
      if (nextJobs === p.jobs) return;
      const old = p.jobs.find((j) => j.id === jobId);
      const next = nextJobs.find((j) => j.id === jobId);
      if (!old || !next) return;
      const c = ctx("Job", jobId, old.title, old.customerId, jobId);
      runFieldOp(
        {
          id: uid(),
          kind: "status",
          jobId,
          from: old.status,
          to: status,
          audit: diffFields(c, old, next, ["status"]),
        },
        status === "done" ? "Done" : status === "in_progress" ? "Arrived" : "Status",
      );
    },
    [runFieldOp],
  );

  /** Book (or clear) the estimator's estimate visit on a draft estimate. */
  const setEstimateVisit = useCallback(
    (estimateId: string, date: string | null, time: string | null) =>
      mutate((p) => {
        const old = p.estimates.find((e) => e.id === estimateId);
        if (!old) return p;
        // Sales crew logins may change drafts only (database rule).
        if (!canEdit && old.status !== "draft") return p;
        if ((old.visitDate ?? null) === date && (old.visitTime ?? null) === time)
          return p;
        const next: Estimate = { ...old, visitDate: date, visitTime: time };
        const c = ctx("Estimate", estimateId, old.title, old.customerId, old.jobId);
        return {
          ...p,
          estimates: p.estimates.map((e) =>
            e.id === estimateId ? next : e,
          ),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(c, old, next, ["visitDate", "visitTime"]),
          ),
        };
      }),
    [mutate, canEdit],
  );

  const createSalesEstimate = useCallback(
    (input: CreateEstimateInput): string | null => {
      const ids = { customerId: uid(), estimateId: uid(), lineId: uid() };
      // Plan against the current state so the id can be returned now;
      // the mutation re-plans against the latest state.
      if (!stateRef.current) return null;
      const first = planCreateEstimate(stateRef.current, input, ids, todayStr());
      if (!first) return null;
      mutate((p) => {
        const plan = planCreateEstimate(p, input, ids, todayStr());
        if (!plan) return p;
        const { customer, previous } = plan;
        // Author: kept on a reused draft, else this login (the database
        // records the same, the "sales access refine" rules).
        const estimate: Estimate = {
          ...plan.estimate,
          createdByCrewId: previous ? (previous.createdByCrewId ?? null) : viewerCardId,
        };
        const name = `${customer.firstName} ${customer.lastName}`.trim();
        const ec = ctx("Estimate", estimate.id, estimate.title, customer.id, estimate.jobId);
        return {
          ...p,
          customers: plan.customerIsNew ? [...p.customers, customer] : p.customers,
          estimates: previous
            ? p.estimates.map((e) => (e.id === estimate.id ? estimate : e))
            : [...p.estimates, estimate],
          auditLog: appendAudit(p.auditLog, [
            ...(plan.customerIsNew
              ? [createdEntry(ctx("Customer", customer.id, name, customer.id))]
              : []),
            ...(previous
              ? diffFields(ec, previous, estimate, ["title", "notes", "visitDate", "visitTime"])
              : [createdEntry(ec)]),
          ]),
        };
      });
      return first.estimate.id;
    },
    [mutate, viewerCardId],
  );

  const suggestCustomerEdit = useCallback(
    async (customerId: string, changes: CustomerChanges, note: string): Promise<string | null> => {
      const clean = sanitizeChanges(changes);
      if (Object.keys(clean).length === 0) return "Nothing was changed.";
      const trimmedNote = note.trim().slice(0, 1000);
      if (supabaseMode) {
        const { id, error } = await insertCustomerEditRequest({ customerId, changes: clean, note: trimmedNote });
        if (error) return error;
        // One email to the business Gmail; never awaited, never undoes the suggestion.
        if (id) void notifySuggestion(id).catch(() => undefined);
        reloadState();
        return null;
      }
      // Demo mode: kept on this device.
      mutate((p) => ({
        ...p,
        customerEditRequests: [
          ...(p.customerEditRequests ?? []),
          {
            id: uid(),
            customerId,
            requestedBy: viewerId || null,
            requestedName: actorRef.current,
            createdAt: new Date().toISOString(),
            changes: clean as Record<string, string>,
            note: trimmedNote,
            status: "pending",
            decidedBy: null,
            decidedAt: null,
            declineReason: "",
            appliedChanges: null,
          },
        ],
      }));
      return null;
    },
    [supabaseMode, reloadState, mutate, viewerId],
  );

  const decideCustomerEdit = useCallback(
    async (
      requestId: string,
      decision: "approve" | "decline",
      opts: { changes?: CustomerChanges | null; reason?: string } = {},
    ): Promise<string | null> => {
      const reason = (opts.reason ?? "").trim();
      if (decision === "decline" && reason.length > DECLINE_REASON_MAX) {
        return `The reason is too long (${DECLINE_REASON_MAX} characters at most).`;
      }
      const edited = decision === "approve" && opts.changes ? sanitizeChanges(opts.changes) : null;
      if (edited && Object.keys(edited).length === 0) return "Nothing would change. Decline it instead.";
      if (supabaseMode) {
        const err = await decideCustomerEditRequest(requestId, decision, {
          changes: edited as Record<string, string> | null,
          reason,
        });
        if (err) return err;
        reloadState();
        return null;
      }
      const req = stateRef.current?.customerEditRequests?.find((r) => r.id === requestId);
      if (!req || req.status !== "pending") return "This suggestion was already decided.";
      mutate((p) => {
        const r = (p.customerEditRequests ?? []).find((x) => x.id === requestId);
        if (!r || r.status !== "pending") return p;
        const old = p.customers.find((c) => c.id === r.customerId);
        const applied = edited ?? sanitizeChanges(r.changes);
        const withChanges = edited !== null;
        const decided = {
          ...r,
          status: decision === "approve" ? ("approved" as const) : ("declined" as const),
          decidedBy: actorRef.current,
          decidedAt: new Date().toISOString(),
          declineReason: decision === "decline" ? reason : "",
          appliedChanges: decision === "approve" ? (applied as Record<string, string>) : null,
        };
        const requests = (p.customerEditRequests ?? []).map((x) => (x.id === requestId ? decided : x));
        if (!old) return { ...p, customerEditRequests: requests };
        const label = `${old.firstName} ${old.lastName}`.trim();
        const c = ctx("Customer", old.id, label, old.id);
        const next = decision === "approve" ? applySuggestion(old, applied) : old;
        const before = withChanges
          ? `suggested by ${r.requestedName}: ${changesText(r.changes)}`
          : `suggested by ${r.requestedName}`;
        const after =
          decision === "decline"
            ? reason
              ? `declined: ${reason}`
              : "declined"
            : withChanges
              ? `approved with changes: ${changesText(applied)}`
              : "approved";
        const entries = [
          ...diffFields(c, old, next, [
            "firstName", "lastName", "company", "phone", "email", "address", "city", "zip",
            "gateCode", "propertyNotes", "notes",
          ]),
          ...diffFields(c, { "suggested change": before }, { "suggested change": after }, ["suggested change"]),
        ];
        return {
          ...p,
          customers: p.customers.map((x) => (x.id === old.id ? next : x)),
          customerEditRequests: requests,
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
      return null;
    },
    [supabaseMode, reloadState, mutate],
  );

  const changeJobPrice = useCallback(
    async (jobId: string, price: JobPrice, reason: string): Promise<string | null> => {
      const trimmed = reason.trim();
      const job = stateRef.current?.jobs.find((j) => j.id === jobId);
      if (!job) return "This job is not loaded.";
      if (!priceChanged(priceOf(job), price)) return "The price did not change.";
      if (role === "crew" && !reasonOk(trimmed)) return "Say why the price changed (at least 3 characters).";
      if (supabaseMode) {
        const err = await changeJobPriceRpc({ jobId, ...price, reason: trimmed });
        if (err) return err;
        reloadState();
        return null;
      }
      // Demo mode: kept on this device, logged the same way.
      mutate((p) => {
        const old = p.jobs.find((j) => j.id === jobId);
        if (!old) return p;
        const office = role !== "crew";
        const next: Job = {
          ...old,
          value: price.value,
          hourlyRate: price.hourlyRate,
          billingType: price.billingType,
          // A Climber's price replaces the one shown before (as the database does).
          replacedPrice: office ? (old.replacedPrice ?? null) : (old.replacedPrice ?? jobPriceBeforeChange(p, old)),
        };
        const c = ctx("Job", old.id, old.title, old.customerId, old.id);
        return {
          ...p,
          jobs: p.jobs.map((j) => (j.id === jobId ? next : j)),
          jobPriceChanges: [
            ...(p.jobPriceChanges ?? []),
            {
              id: uid(),
              jobId,
              changedBy: viewerId || null,
              changedByName: actorRef.current,
              byOffice: office,
              changedAt: new Date().toISOString(),
              oldValue: old.value,
              newValue: price.value,
              oldHourlyRate: old.hourlyRate ?? null,
              newHourlyRate: price.hourlyRate,
              oldBillingType: old.billingType ?? null,
              newBillingType: price.billingType,
              reason: trimmed,
              seenBy: office ? actorRef.current : null,
              seenAt: office ? new Date().toISOString() : null,
            },
          ],
          auditLog: appendAudit(p.auditLog, diffFields(c, old, next, ["value", "billingType", "hourlyRate"])),
        };
      });
      return null;
    },
    [supabaseMode, reloadState, mutate, role, viewerId],
  );

  const markPriceChangeSeen = useCallback(
    async (changeId: string): Promise<string | null> => {
      if (supabaseMode) {
        const err = await markJobPriceChangeSeenRpc(changeId);
        if (err) return err;
        reloadState();
        return null;
      }
      mutate((p) => ({
        ...p,
        jobPriceChanges: (p.jobPriceChanges ?? []).map((x) =>
          x.id === changeId && !x.seenAt ? { ...x, seenBy: actorRef.current, seenAt: new Date().toISOString() } : x,
        ),
      }));
      return null;
    },
    [supabaseMode, reloadState, mutate],
  );

  const restoreEstimatePrice = useCallback(
    async (jobId: string): Promise<string | null> => {
      if (supabaseMode) {
        const err = await clearReplacedPriceRpc(jobId);
        if (err) return err;
        reloadState();
        return null;
      }
      mutate((p) => ({
        ...p,
        jobs: p.jobs.map((j) => (j.id === jobId ? { ...j, replacedPrice: null } : j)),
      }));
      return null;
    },
    [supabaseMode, reloadState, mutate],
  );

  const reportEquipmentProblem = useCallback(
    async (
      equipmentId: string,
      note: string,
      photo: Uint8Array | null,
    ): Promise<{ error: string | null; photoError: string | null }> => {
      const bad = problemNoteProblem(note);
      if (bad) return { error: bad, photoError: null };
      const text = note.trim();
      if (supabaseMode) {
        const { id, error } = await insertEquipmentProblem({ equipmentId, note: text });
        if (error || !id) return { error: error ?? "Not saved. Try again.", photoError: null };
        const photoError = photo ? await uploadProblemPhoto(id, photo) : null;
        reloadState();
        return { error: null, photoError };
      }
      // Demo mode: kept on this device.
      const id = uid();
      const photoError = photo ? await uploadProblemPhoto(id, photo) : null;
      mutate((p) => ({
        ...p,
        equipmentProblems: [
          ...(p.equipmentProblems ?? []),
          {
            id,
            equipmentId,
            note: text,
            status: "open",
            hasPhoto: photo !== null && photoError === null,
            reportedBy: viewerId || null,
            reportedName: actorRef.current,
            createdAt: new Date().toISOString(),
            statusByName: null,
            statusAt: null,
          },
        ],
      }));
      return { error: null, photoError };
    },
    [supabaseMode, reloadState, mutate, viewerId],
  );

  const resolveEquipmentProblem = useCallback(
    async (problemId: string, action: "fixed" | "shop"): Promise<string | null> => {
      if (supabaseMode) {
        const err = await resolveEquipmentProblemRpc(problemId, action);
        if (err) return err;
        reloadState();
        return null;
      }
      // Demo mode: the same rules as resolve_equipment_problem.
      mutate((p) => {
        const r = (p.equipmentProblems ?? []).find((x) => x.id === problemId);
        if (!r) return p;
        const problems = (p.equipmentProblems ?? []).map((x) =>
          x.id === problemId
            ? { ...x, status: statusAfter(action), statusByName: actorRef.current, statusAt: new Date().toISOString() }
            : x,
        );
        const othersLeft = problems.some((x) => x.equipmentId === r.equipmentId && isUnresolved(x));
        const equipment = p.equipment.map((e) => {
          if (e.id !== r.equipmentId) return e;
          if (action === "shop") return e.status === "retired" ? e : { ...e, status: "in_shop" as const };
          if (othersLeft) return e;
          return {
            ...e,
            status: e.status === "in_shop" ? ("available" as const) : e.status,
            down: e.down === true ? false : e.down,
          };
        });
        return { ...p, equipmentProblems: problems, equipment };
      });
      return null;
    },
    [supabaseMode, reloadState, mutate],
  );

  /**
   * Replace a job's equipment list in one step (Dashboard quick-assign).
   * No-op when the list is unchanged.
   */
  const setJobEquipment = useCallback(
    (jobId: string, equipmentIds: string[]) =>
      mutate((p) => {
        const old = p.jobs.find((j) => j.id === jobId);
        if (!old) return p;
        const prev = old.equipmentIds ?? [];
        const same =
          prev.length === equipmentIds.length &&
          prev.every((id) => equipmentIds.includes(id));
        if (same) return p;
        const next: Job = { ...old, equipmentIds };
        const c = ctx("Job", jobId, old.title, old.customerId, jobId);
        return {
          ...p,
          jobs: p.jobs.map((j) => (j.id === jobId ? next : j)),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(c, old, next, ["equipmentIds"]),
          ),
        };
      }),
    [mutate],
  );

  /**
   * Named day crews. A crew is a shortcut group for one date;
   * applying it to a job sets that job's crew to the crew's members.
   * Jobs keep their own crewIds, so deleting a crew never unassigns
   * a job — the job just keeps the members it had.
   */
  const addDayCrew = useCallback(
    (date: string, name: string, memberIds: string[]): string => {
      const id = uid();
      mutate((p) => {
        const crew: DayCrew = { id, date, name, memberIds };
        return {
          ...p,
          dayCrews: [...(p.dayCrews ?? []), crew],
          auditLog: appendAudit(p.auditLog, [
            createdEntry(
              ctx("Day crew", id, `${name} · ${fmtDate(date)}`, null),
            ),
          ]),
        };
      });
      return id;
    },
    [mutate],
  );

  const renameDayCrew = useCallback(
    (id: string, name: string) =>
      mutate((p) => {
        const old = (p.dayCrews ?? []).find((c) => c.id === id);
        if (!old || old.name === name) return p;
        const next: DayCrew = { ...old, name };
        return {
          ...p,
          dayCrews: (p.dayCrews ?? []).map((c) =>
            c.id === id ? next : c,
          ),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(
              ctx("Day crew", id, old.name, null),
              old,
              next,
              ["name"],
            ),
          ),
        };
      }),
    [mutate],
  );

  const setDayCrewMembers = useCallback(
    (id: string, memberIds: string[]) =>
      mutate((p) => {
        const old = (p.dayCrews ?? []).find((c) => c.id === id);
        if (!old) return p;
        const same =
          old.memberIds.length === memberIds.length &&
          old.memberIds.every((m) => memberIds.includes(m));
        if (same) return p;
        const next: DayCrew = { ...old, memberIds };
        return {
          ...p,
          dayCrews: (p.dayCrews ?? []).map((c) =>
            c.id === id ? next : c,
          ),
          auditLog: appendAudit(
            p.auditLog,
            memberChangeEntries(
              ctx("Day crew", id, old.name, null),
              memberIds
                .filter((m) => !old.memberIds.includes(m))
                .map((m) => crewName(p, m)),
              old.memberIds
                .filter((m) => !memberIds.includes(m))
                .map((m) => crewName(p, m)),
            ),
          ),
        };
      }),
    [mutate],
  );

  const deleteDayCrew = useCallback(
    (id: string) =>
      mutate((p) => {
        const old = (p.dayCrews ?? []).find((c) => c.id === id);
        if (!old) return p;
        return {
          ...p,
          dayCrews: (p.dayCrews ?? []).filter((c) => c.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(ctx("Day crew", id, old.name, null)),
          ]),
        };
      }),
    [mutate],
  );

  const addUnavailabilitySpan = useCallback(
    (crewId: string, startDate: string, endDate: string): string => {
      const id = uid();
      mutate((p) => {
        const { spans, merged } = mergeSpan(
          p.unavailability ?? [],
          crewId,
          startDate,
          endDate,
          id,
        );
        const name = crewName(p, crewId);
        const label = `${name} · ${fmtDate(merged.startDate)} – ${fmtDate(merged.endDate)}`;
        // Spans the merge absorbed are gone too — log each removal
        // so the audit trail stays honest about what changed.
        const absorbed = (p.unavailability ?? []).filter(
          (s) =>
            s.crewId === crewId &&
            s.id !== merged.id &&
            !spans.some((x) => x.id === s.id),
        );
        return {
          ...p,
          unavailability: spans,
          auditLog: appendAudit(p.auditLog, [
            createdEntry(
              ctx("Unavailability", merged.id, label, null),
            ),
            ...absorbed.map((s) =>
              deletedEntry(
                ctx(
                  "Unavailability",
                  s.id,
                  `${name} · ${fmtDate(s.startDate)} – ${fmtDate(s.endDate)}`,
                  null,
                ),
              ),
            ),
          ]),
        };
      });
      return id;
    },
    [mutate],
  );

  const deleteUnavailabilitySpan = useCallback(
    (id: string) =>
      mutate((p) => {
        const old = (p.unavailability ?? []).find((s) => s.id === id);
        if (!old) return p;
        const name = crewName(p, old.crewId);
        return {
          ...p,
          unavailability: (p.unavailability ?? []).filter(
            (s) => s.id !== id,
          ),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Unavailability",
                id,
                `${name} · ${fmtDate(old.startDate)} – ${fmtDate(old.endDate)}`,
                null,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const applyDayCrewToJob = useCallback(
    (jobId: string, dayCrewId: string) =>
      mutate((p) => {
        const crew = (p.dayCrews ?? []).find((c) => c.id === dayCrewId);
        const old = p.jobs.find((j) => j.id === jobId);
        if (!crew || !old) return p;
        // Day crew members who are unavailable that day are left off.
        const memberIds = onlyAvailableAdded(p, old.crewIds, [...crew.memberIds], old.date).ids;
        const same =
          old.crewIds.length === memberIds.length &&
          old.crewIds.every((id) => memberIds.includes(id));
        if (same) return p;
        const next: Job = { ...old, crewIds: memberIds };
        const c = ctx("Job", jobId, old.title, old.customerId, jobId);
        return {
          ...p,
          jobs: p.jobs.map((j) => (j.id === jobId ? next : j)),
          auditLog: appendAudit(
            p.auditLog,
            memberChangeEntries(
              c,
              memberIds
                .filter((id) => !old.crewIds.includes(id))
                .map((id) => crewName(p, id)),
              old.crewIds
                .filter((id) => !memberIds.includes(id))
                .map((id) => crewName(p, id)),
            ),
          ),
        };
      }),
    [mutate],
  );

  /**
   * Ask where people are: one location_requests row per person. No
   * push server exists, so this only stores the request — the crew
   * member answers by opening the app and tapping Share. When called
   * with no ids, everyone assigned to a job today (schedulable
   * first). People who already have an open request are skipped, so
   * re-tapping Ping never stacks duplicate requests. Audit-logged
   * like a scheduling action, so the office can see who was asked.
   */
  const requestLocations = useCallback(
    (crewIds?: string[]) => {
      const s = stateRef.current;
      if (!s) return;
      const today = todayStr();
      const targets =
        crewIds && crewIds.length > 0
          ? [...new Set(crewIds)]
          : [
              ...new Set(
                s.jobs
                  .filter((j) => j.date === today)
                  .flatMap((j) => j.crewIds),
              ),
            ];
      const now = new Date().toISOString();
      const hasOpenRequest = (id: string): boolean =>
        (s.locationRequests ?? []).some(
          (r) =>
            (r.targetCrewId === null || r.targetCrewId === id) &&
            (s.crewLocations ?? []).filter(
              (l) => l.crewId === id && l.recordedAt > r.requestedAt,
            ).length === 0,
        );
      const fresh = targets.filter((id) => !hasOpenRequest(id));
      if (fresh.length === 0) return;
      const rows: LocationRequest[] = fresh.map((id) => ({
        id: uid(),
        requestedBy: viewerIdExposed,
        requestedAt: now,
        targetCrewId: id,
      }));
      mutate((p) => ({
        ...p,
        locationRequests: [...(p.locationRequests ?? []), ...rows],
        auditLog: appendAudit(
          p.auditLog,
          rows.map((r) =>
            createdEntry(
              ctx(
                "Location request",
                r.id,
                `Asked ${crewName(p, r.targetCrewId ?? "")} where they are`,
                null,
              ),
            ),
          ),
        ),
      }));
    },
    [mutate, viewerIdExposed],
  );

  /**
   * Share where I am: read the phone's position once, at tap time,
   * and store one point. The point answers the open request (when
   * there is one) and notes the in-progress job the sharer is on
   * (when there is one). A denied or failed read resolves false and
   * writes nothing — the caller shows the reason. Location points
   * are ephemeral: they are never audit-logged.
   */
  const shareMyLocation = useCallback(async (): Promise<boolean> => {
    const me = viewerIdExposed;
    if (!me) return false;
    let pos: GeolocationPosition;
    try {
      pos = await readCurrentPosition();
    } catch {
      return false;
    }
    const s = stateRef.current;
    if (!s) return false;
    const today = todayStr();
    const open = openRequestsFor(s, me);
    const job = currentJobFor(s, me, today);
    const point: CrewLocation = {
      id: uid(),
      crewId: me,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      recordedAt: new Date().toISOString(),
      requestId: open.length > 0 ? open[open.length - 1].id : null,
      jobId: job ? job.id : null,
    };
    mutate((p) => ({
      ...p,
      crewLocations: [...(p.crewLocations ?? []), point],
    }));
    return true;
  }, [mutate, viewerIdExposed]);

  const jobFromEstimate = useCallback(
    (estimateId: string, date: string, startTime: string): string | null => {
      const est = stateRef.current?.estimates.find(
        (e) => e.id === estimateId,
      );
      if (!est) return null;
      // Already has a job: move that job to the day and time instead of
      // creating a duplicate.
      const existing = stateRef.current?.jobs.find(
        (j) => j.estimateId === estimateId,
      );
      if (existing) {
        moveJob(existing.id, date, startTime);
        return existing.id;
      }
      const jobId = uid();
      mutate((p) => {
        const fresh = p.estimates.find((e) => e.id === estimateId);
        if (!fresh) return p;
        if (p.jobs.some((j) => j.estimateId === estimateId)) return p;
        const option = (fresh.options ?? []).find(
          (o) => o.id === fresh.acceptedOptionId,
        );
        const lines = option ? option.lines : fresh.lines;
        const base: Job = {
          id: jobId,
          customerId: fresh.customerId,
          serviceType: serviceTypeForEstimate(fresh),
          title: option ? `${fresh.title} — ${option.label}` : fresh.title,
          date,
          startTime,
          status: "scheduled",
          crewIds: [],
          notes: `Scheduled from accepted estimate${option ? ` option "${option.label}"` : ""}.`,
          customerNotes: "",
          teamNotes: "",
          officeNotes: "",
          pruneClass: null,
          estimatedHours: null,
          estimateId: fresh.id,
          invoiceId: null,
          value: null,
          treeIds: [
            ...new Set(
              lines
                .map((l) => l.treeId)
                .filter((t): t is string => Boolean(t)),
            ),
          ],
          equipmentIds: [],
          endDate: null,
          recurring: null,
          recurringUntil: null,
          materialsCost: null,
          otherCost: null,
          laborRate: null,
          lat: null,
          lng: null,
        };
        // What the estimator put on the estimate: equipment, named crew
        // (only those free that day) and the expected crew total.
        const plan = planFromEstimate(p, base, fresh);
        const job: Job = {
          ...base,
          equipmentIds: plan.equipmentIds,
          crewIds: plan.crewIds,
          expectedCrew: plan.expectedCrew,
          notes:
            plan.skipped.length > 0
              ? `${base.notes} Named on the estimate but not available that day: ${plan.skipped.join(", ")}.`
              : base.notes,
        };
        const entries = [
          createdEntry(ctx("Job", job.id, job.title, job.customerId, job.id)),
          ...diffFields(
            ctx(
              "Estimate",
              fresh.id,
              fresh.title,
              fresh.customerId,
              fresh.jobId,
            ),
            { jobId: fresh.jobId },
            { jobId },
            ["jobId"],
          ),
        ];
        return {
          ...p,
          estimates: p.estimates.map((e) =>
            e.id === estimateId ? { ...fresh, jobId } : e,
          ),
          jobs: [...p.jobs, job],
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
      return jobId;
    },
    [mutate, moveJob],
  );

  const deleteJob = useCallback(
    (id: string) =>
      mutate((p) => {
        const j = p.jobs.find((x) => x.id === id);
        if (!j) return p;
        const entries = [
          deletedEntry(ctx("Job", id, j.title, j.customerId, id)),
          ...p.timesheets
            .filter((t) => t.jobId === id)
            .map((t) =>
              deletedEntry(
                ctx("Timesheet", t.id, `${t.date} timesheet`, j.customerId, id),
              ),
            ),
        ];
        return {
          ...p,
          jobs: p.jobs.filter((x) => x.id !== id),
          timesheets: p.timesheets.filter((t) => t.jobId !== id),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const saveEstimate = useCallback(
    (input: Estimate) =>
      mutate((p) => {
        const old = p.estimates.find((x) => x.id === input.id);
        // Who wrote it: the database records the signed-in login's card
        // on insert and keeps it on every edit (migration
        // the "sales access refine" rules); the screen does the same so "Mine" is right
        // before the next reload.
        const e: Estimate = {
          ...input,
          createdByCrewId: old
            ? (old.createdByCrewId ?? null)
            : (input.createdByCrewId ?? viewerCardId),
        };
        const c = ctx("Estimate", e.id, e.title, e.customerId, e.jobId);
        const entries = old
          ? [
              ...diffFields(c, old, e, [
                "customerId",
                "title",
                "taxRate",
                "discountType",
                "discountValue",
                "status",
                "notes",
                "options",
                "acceptedOptionId",
                "acceptedBy",
                "acceptedAt",
                "visitDate",
                "visitTime",
              ]),
              ...diffLines(c, old.lines, e.lines),
            ]
          : [createdEntry(c)];
        return {
          ...p,
          estimates: old
            ? p.estimates.map((x) => (x.id === e.id ? e : x))
            : [...p.estimates, e],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate, viewerCardId],
  );

  const deleteEstimate = useCallback(
    (id: string) =>
      mutate((p) => {
        const e = p.estimates.find((x) => x.id === id);
        if (!e) return p;
        const entries = [
          deletedEntry(ctx("Estimate", id, e.title, e.customerId, e.jobId)),
          ...p.jobs
            .filter((j) => j.estimateId === id)
            .map((j) =>
              diffFields(
                ctx("Job", j.id, j.title, j.customerId, j.id),
                { estimateId: e.title },
                { estimateId: "(blank)" },
                ["estimateId"],
                { estimateId: "estimate" },
              ),
            )
            .flat(),
        ];
        return {
          ...p,
          estimates: p.estimates.filter((x) => x.id !== id),
          jobs: p.jobs.map((j) =>
            j.estimateId === id ? { ...j, estimateId: null } : j,
          ),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const saveInvoice = useCallback(
    (i: Invoice) =>
      mutate((p) => {
        const old = p.invoices.find((x) => x.id === i.id);
        const c = ctx("Invoice", i.id, i.number, i.customerId, i.jobId);
        const entries = old
          ? [
              ...diffFields(c, old, i, [
                "customerId",
                "status",
                "issuedDate",
                "dueDate",
                "paidDate",
                "paymentMethod",
                "taxRate",
                "discountType",
                "discountValue",
                "splits",
              ],
              { paymentMethod: "payment method" }),
              ...diffLines(c, old.lines, i.lines),
            ]
          : [createdEntry(c)];
        return {
          ...p,
          invoices: old
            ? p.invoices.map((x) => (x.id === i.id ? i : x))
            : [...p.invoices, i],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const stopInvoiceAutoSend = useCallback(
    async (invoiceId: string): Promise<string | null> => {
      const res = await stopAutoSend(invoiceId);
      if (res.reload) reloadState();
      if (res.error) return res.error;
      // Screen only: the auto-send fields are never saved by the app.
      mutate((p) => ({
        ...p,
        invoices: p.invoices.map((i) =>
          i.id === invoiceId && i.autoSendStatus === "waiting"
            ? { ...i, autoSendStatus: "stopped" as const, autoSendNote: "stopped" }
            : i,
        ),
      }));
      return null;
    },
    [mutate, reloadState],
  );

  const markInvoicePaid = useCallback(
    (id: string, method?: PaymentMethod | null) =>
      mutate((p) => {
        const old = p.invoices.find((i) => i.id === id);
        if (!old) return p;
        const today = todayStr();
        const next: Invoice = {
          ...old,
          status: "paid" as const,
          paidDate: today,
          // How they paid — recorded here, or left as whatever was
          // already recorded. Never guessed: null stays null.
          paymentMethod: method ?? old.paymentMethod ?? null,
          // A fully paid invoice means every split is paid too.
          splits: (old.splits ?? []).map((s) => ({
            ...s,
            paid: true,
            paidDate: s.paidDate ?? today,
          })),
        };
        const entries = diffFields(
          ctx("Invoice", id, old.number, old.customerId, old.jobId),
          old,
          next,
          ["status", "paidDate", "paymentMethod"],
          { paymentMethod: "payment method" },
        );
        return {
          ...p,
          invoices: p.invoices.map((i) => (i.id === id ? next : i)),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const markSplitPaid = useCallback(
    (invoiceId: string, splitId: string, paid: boolean) =>
      mutate((p) => {
        const old = p.invoices.find((i) => i.id === invoiceId);
        if (!old || !(old.splits ?? []).some((s) => s.id === splitId)) {
          return p;
        }
        const today = todayStr();
        const splits = (old.splits ?? []).map((s) =>
          s.id === splitId
            ? { ...s, paid, paidDate: paid ? today : null }
            : s,
        );
        const status = splitsStatus(splits);
        const next: Invoice = {
          ...old,
          splits,
          status,
          paidDate: status === "paid" ? (old.paidDate ?? today) : null,
        };
        const changed = splits.find((s) => s.id === splitId);
        const entries = changed
          ? diffFields(
              ctx(
                "Invoice split",
                splitId,
                `${old.number} — ${changed.recipientName}`,
                old.customerId,
                old.jobId,
              ),
              { paid: !paid },
              { paid },
              ["paid"],
            )
          : [];
        return {
          ...p,
          invoices: p.invoices.map((i) => (i.id === invoiceId ? next : i)),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const invoiceFromEstimate = useCallback(
    (estimateId: string): string | null => {
      const est = stateRef.current?.estimates.find(
        (e) => e.id === estimateId,
      );
      if (!est) return null;
      // The database may renumber it (a number another screen just
      // used): show the real number once it is saved.
      if (supabaseMode) reloadAfterSave.current = true;
      const invId = uid();
      mutate((p) => {
        const fresh = p.estimates.find((e) => e.id === estimateId);
        if (!fresh) return p;
        const pricing = estimateInvoicePricing(p, fresh);
        const inv: Invoice = {
          id: invId,
          number: nextInvoiceNumber(p.invoices),
          customerId: fresh.customerId,
          jobId: fresh.jobId ?? jobOfEstimate(p, fresh)?.id ?? null,
          estimateId: fresh.id,
          // Accepted proposal option's lines when one was accepted; the
          // job's own price when a Climber replaced it (business rule).
          lines: pricing.lines.map((l) => ({ ...l, id: "id" in l && typeof l.id === "string" ? l.id : uid() })),
          taxRate: pricing.taxRate,
          discountType: pricing.discountType,
          discountValue: pricing.discountValue,
          status: "unpaid",
          issuedDate: todayStr(),
          dueDate: dueDateForInvoice(p, fresh.customerId, todayStr()),
          paidDate: null,
          paymentMethod: null,
          emailQueuedAt: null,
          // New invoices start single-recipient; splits are added in
          // the invoice editor.
          splits: [],
        };
        const entries = [
          createdEntry(
            ctx("Invoice", inv.id, inv.number, inv.customerId, inv.jobId),
          ),
          // Linking the invoice to the job is itself a job change, so
          // it shows in that job's activity.
          ...(inv.jobId
            ? (() => {
                const linked = p.jobs.find((j) => j.id === inv.jobId);
                return linked
                  ? diffFields(
                      ctx(
                        "Job",
                        linked.id,
                        linked.title,
                        linked.customerId,
                        linked.id,
                      ),
                      { invoice: "(blank)" },
                      { invoice: inv.number },
                      ["invoice"],
                    )
                  : [];
              })()
            : []),
        ];
        return {
          ...p,
          invoices: [...p.invoices, inv],
          jobs: inv.jobId
            ? p.jobs.map((j) =>
                j.id === inv.jobId ? { ...j, invoiceId: inv.id } : j,
              )
            : p.jobs,
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
      return invId;
    },
    [mutate, supabaseMode],
  );

  const invoiceFromJob = useCallback(
    (jobId: string): string | null => {
      const current = stateRef.current;
      const existing = current?.jobs.find((x) => x.id === jobId);
      if (!current || !existing) return null;
      if (existing.invoiceId) return existing.invoiceId;
      // An invoice for this job is already on the screen (made by the
      // database when the job was marked done): open that one.
      const forJob = current.invoices.find((i) => i.jobId === jobId);
      if (forJob) return forJob.id;
      // Just marked done here: the database is making its invoice; it
      // shows in a moment (never a second invoice for the same job).
      if (supabaseMode && awaitingDoneInvoice.current.has(jobId)) return null;
      // The database may renumber it (a number another screen just
      // used): show the real number once it is saved.
      if (supabaseMode) reloadAfterSave.current = true;
      const invId = uid();
      mutate((p) => {
        const j = p.jobs.find((x) => x.id === jobId);
        if (!j || j.invoiceId || p.invoices.some((i) => i.jobId === jobId)) return p;
        const inv: Invoice = {
          id: invId,
          number: nextInvoiceNumber(p.invoices),
          customerId: j.customerId,
          jobId: j.id,
          estimateId: j.estimateId,
          // Priced from the job (hourly, its estimate, or its value): never
          // a $0 line when the job has a price.
          ...(() => {
            const price = jobInvoicePricing(p, j);
            return {
              lines: price.lines.map((l) => ({ ...l, id: uid() })),
              taxRate: price.taxRate,
              discountType: price.discountType,
              discountValue: price.discountValue,
            };
          })(),
          status: "unpaid",
          issuedDate: todayStr(),
          dueDate: dueDateForInvoice(p, j.customerId, todayStr()),
          paidDate: null,
          paymentMethod: null,
          emailQueuedAt: null,
          splits: [],
        };
        return {
          ...p,
          invoices: [...p.invoices, inv],
          jobs: p.jobs.map((x) =>
            x.id === jobId ? { ...x, invoiceId: inv.id } : x,
          ),
          auditLog: appendAudit(
            p.auditLog,
            [
              createdEntry(
                ctx("Invoice", inv.id, inv.number, j.customerId, jobId),
              ),
              // Linking the invoice to the job is itself a job change.
              ...diffFields(
                ctx("Job", jobId, j.title, j.customerId, jobId),
                { invoice: "(blank)" },
                { invoice: inv.number },
                ["invoice"],
              ),
            ],
          ),
        };
      });
      return invId;
    },
    [mutate, supabaseMode],
  );

  const addTimesheet = useCallback(
    (t: TimesheetEntry) => {
      // Manual hours entry is permission-gated (permissions
      // .canManualClockIn, default owners, managers and the office): the manual form is
      // hidden without it, and this backstop stops any caller from
      // adding hours by hand without the toggle. Geofenced tap
      // clock-in goes through clockIn, not here, and is unaffected.
      if (!canManualClockIn) return;
      mutate((p) => ({
        ...p,
        timesheets: [...p.timesheets, t],
        auditLog: appendAudit(p.auditLog, [
          createdEntry(
            ctx(
              "Timesheet",
              t.id,
              `${t.date} · ${crewName(p, t.crewId)}`,
              jobCustomerId(p, t.jobId),
              t.jobId,
            ),
          ),
        ]),
      }));
    },
    [mutate, canManualClockIn],
  );

  const clockIn = useCallback(
    async (
      crewId: string,
      jobId: string | null,
      location: string,
    ): Promise<ClockInCheck> => {
      const current = stateRef.current;
      if (!current) {
        return {
          allowed: false,
          reason: "no-location",
          message: "The app hasn't finished loading — try again in a moment.",
          nearestMiles: null,
          nearestLabel: null,
        };
      }
      // Tap times are Denver time, whatever the phone's zone (src/clockTime.ts).
      const tap = clockNow();
      // The 8 PM rule: no live clock-in at or after 8 PM unless this
      // login may type clock times (the database refuses it too,
      // the "crew day and 8pm clockout" rules).
      if (!mayTypeClockTimes && tap.time >= CLOCK_DAY_END) {
        return {
          allowed: false,
          reason: "after-8pm",
          message: AFTER_8PM_TEXT,
          nearestMiles: null,
          nearestLabel: null,
        };
      }
      // Already on the clock today: moving the clock to another job
      // needs no location check (the hours just go to the new job).
      const onTheClock = current.timesheets.find(
        (t) => t.crewId === crewId && t.date === tap.date && t.clockIn !== null && t.clockOut === null,
      );
      const check: ClockInCheck = onTheClock
        ? { allowed: true, matchedLabel: onTheClock.location, distanceMiles: 0 }
        : await checkClockIn(current, crewId, jobId);
      if (!check.allowed) return check;
      // Record where they clocked in when no location was typed.
      const at = location.trim() ? location : check.matchedLabel;
      const p = stateRef.current ?? current;
      const entry: TimesheetEntry = {
        id: uid(),
        crewId,
        jobId,
        date: tap.date,
        clockIn: tap.time,
        clockOut: null,
        hours: null,
        notes: "",
        location: at,
      };
      // Clocking in somewhere else closes the open entry first (one
      // open clock per person per day; the database does the same).
      const switched = switchClock(p.timesheets, entry);
      if (switched.unchanged) return check;
      const audit = [
        ...switched.closed.flatMap((closed) => {
          const before = p.timesheets.find((t) => t.id === closed.id);
          return diffFields(
            ctx(
              "Timesheet",
              closed.id,
              `${closed.date} · ${crewName(p, crewId)}`,
              jobCustomerId(p, closed.jobId),
              closed.jobId,
            ),
            before,
            closed,
            ["clockOut"],
          );
        }),
        createdEntry(
          ctx(
            "Timesheet",
            entry.id,
            `${entry.date} · ${crewName(p, crewId)} clocked in`,
            jobCustomerId(p, jobId),
            jobId,
          ),
        ),
      ];
      runFieldOp(
        { id: uid(), kind: "clockIn", entry, audit },
        "Clock in",
      );
      return check;
    },
    [runFieldOp, mayTypeClockTimes],
  );

  const clockOut = useCallback(
    (entryId: string) => {
      const p = stateRef.current;
      const old = p?.timesheets.find((t) => t.id === entryId);
      if (!p || !old || old.clockOut !== null) return;
      // Denver time, whatever the phone's zone (src/clockTime.ts); an
      // entry the 8 PM rule already ended closes at 20:00 (the database
      // saves the same, the "crew day and 8pm clockout" rules).
      const tap = clockOutTapTime(old);
      const next: TimesheetEntry = { ...old, clockOut: tap.time, autoClosed: tap.autoClosed };
      const audit = diffFields(
        ctx(
          "Timesheet",
          entryId,
          `${old.date} · ${crewName(p, old.crewId)}`,
          jobCustomerId(p, old.jobId),
          old.jobId,
        ),
        old,
        next,
        ["clockOut"],
      );
      runFieldOp(
        { id: uid(), kind: "clockOut", entryId, at: next.clockOut as string, date: old.date, audit },
        "Clock out",
      );
    },
    [runFieldOp],
  );

  const updateTimesheet = useCallback(
    (edited: TimesheetEntry) =>
      mutate((p) => {
        const old = p.timesheets.find((x) => x.id === edited.id);
        if (!old) return p;
        // Live-only clock-in: without "May enter hours by hand" the
        // date, clock times and hours stay as tapped (the database
        // refuses them too, the "manager pay and live clock-in" rules).
        const t = limitTimesheetEdit(old, edited, mayTypeClockTimes);
        const entries = diffFields(
          ctx(
            "Timesheet",
            t.id,
            `${t.date} · ${crewName(p, t.crewId)}`,
            jobCustomerId(p, t.jobId),
            t.jobId,
          ),
          old,
          t,
          ["date", "clockIn", "clockOut", "hours", "notes", "location"],
        );
        return {
          ...p,
          timesheets: p.timesheets.map((x) => (x.id === t.id ? t : x)),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate, mayTypeClockTimes],
  );

  const deleteTimesheet = useCallback(
    (id: string) =>
      mutate((p) => {
        const t = p.timesheets.find((x) => x.id === id);
        if (!t) return p;
        return {
          ...p,
          timesheets: p.timesheets.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Timesheet",
                id,
                `${t.date} · ${crewName(p, t.crewId)}`,
                jobCustomerId(p, t.jobId),
                t.jobId,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const addPrivateNote = useCallback(
    (n: PrivateNote) =>
      mutate((p) => ({
        ...p,
        notes: [...p.notes, n],
        auditLog: appendAudit(p.auditLog, [
          createdEntry(
            ctx(
              "Note",
              n.id,
              `${n.kind === "admin" ? "Admin-only" : n.kind === "team" ? "Team" : "Private"} note for ${customerName(p, n.customerId)}`,
              n.customerId,
            ),
          ),
        ]),
      })),
    [mutate],
  );

  const deletePrivateNote = useCallback(
    (id: string) =>
      mutate((p) => {
        const n = p.notes.find((x) => x.id === id);
        if (!n) return p;
        return {
          ...p,
          notes: p.notes.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx(
                "Note",
                id,
                `${n.kind === "admin" ? "Admin-only" : n.kind === "team" ? "Team" : "Private"} note for ${customerName(p, n.customerId)}`,
                n.customerId,
              ),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const saveCrewMember = useCallback(
    (m: CrewMember) => {
      const old = stateRef.current?.crew.find((x) => x.id === m.id);
      mutate((p) => {
        const entries = old
          ? diffFields(ctx("User", m.id, m.name, null), old, m, [
              "name",
              "role",
              "appRole",
              "phone",
              "email",
              "messageIntro",
              "employmentType",
              "payType",
              "payAmount",
              "availableWeekdays",
              "canDriveEquipment",
              "worksWellWith",
              "permissions",
              "skills",
              "driverLicensed",
              "companyInsured",
              "cdlClass",
              "lastResort",
              "prefersOwnTruck",
              "ownTruckId",
            ])
          : [createdEntry(ctx("User", m.id, m.name, null))];
        return {
          ...p,
          crew: old
            ? p.crew.map((x) => (x.id === m.id ? m : x))
            : [...p.crew, m],
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
      // Keep the membership row's role in step with the roster: the
      // app reads the app role from the membership, so a profile edit
      // that changes it must land there too. Update-only: never
      // creates a membership (approval does that).
      // The result is checked (audit SEC-9): if the database refuses
      // (only an owner can change an owner) or the request fails, the
      // roster change is undone and the save banner says why.
      if (
        supabaseMode &&
        supabase &&
        m.authUserId &&
        old &&
        old.appRole !== m.appRole
      ) {
        const client = supabase;
        const userId = m.authUserId;
        void (async () => {
          const { data, error } = await client
            .from("company_members")
            .update({ role: m.appRole })
            .eq("user_id", userId)
            .eq("company_id", supabaseConfig.companyId)
            .select("user_id");
          if (!error && data && data.length > 0) return;
          mutate((p) => ({
            ...p,
            crew: p.crew.map((x) =>
              x.id === m.id ? { ...x, appRole: old.appRole } : x,
            ),
          }));
          setSaveError(
            `Couldn't change ${m.name}'s app role: ${
              error ? membershipError(error) : NO_MEMBERSHIP_PERMISSION
            }`,
          );
        })();
      }
    },
    [mutate, supabaseMode],
  );

  const deleteCrewMember = useCallback(
    async (id: string): Promise<string | null> => {
      const m = stateRef.current?.crew.find((x) => x.id === id);
      // Removing someone from the roster also removes their login's
      // access (their membership row), so they can't keep signing in
      // to an empty shell. Self-removal is blocked in the Users page.
      // The access removal must succeed first (audit SEC-9): if it
      // fails, the roster card stays and the caller shows the error.
      if (supabaseMode && supabase && m?.authUserId) {
        const { data, error } = await supabase
          .from("company_members")
          .delete()
          .eq("user_id", m.authUserId)
          .eq("company_id", supabaseConfig.companyId)
          .select("user_id");
        if (error) return membershipError(error);
        if (!data || data.length === 0) {
          // No row deleted: either there was no access to remove, or
          // the database refused. Check which.
          const { data: still } = await supabase
            .from("company_members")
            .select("user_id")
            .eq("user_id", m.authUserId)
            .eq("company_id", supabaseConfig.companyId)
            .maybeSingle();
          if (still) return NO_MEMBERSHIP_PERMISSION;
        }
      }
      mutate((p) => {
        if (!m) return p;
        return {
          ...p,
          crew: p.crew.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(ctx("User", id, m.name, null)),
          ]),
        };
      });
      return null;
    },
    [mutate, supabaseMode],
  );

  const saveMessageIntro = useCallback(
    (crewId: string, intro: string) =>
      mutate((p) => {
        const old = p.crew.find((x) => x.id === crewId);
        if (!old || (old.messageIntro ?? "") === intro) return p;
        const next: CrewMember = { ...old, messageIntro: intro };
        return {
          ...p,
          crew: p.crew.map((x) => (x.id === crewId ? next : x)),
          auditLog: appendAudit(
            p.auditLog,
            diffFields(ctx("User", crewId, old.name, null), old, next, [
              "messageIntro",
            ]),
          ),
        };
      }),
    [mutate],
  );

  const sendMessage = useCallback(
    (input: {
      customerId: string;
      channel: MessageChannel;
      body: string;
      jobId?: string | null;
      estimateId?: string | null;
    }) => {
      // Messaging is owner-gated per person (toggle, default off):
      // never send from a caller that skipped the composer check.
      // Logging a call sends nothing, so anyone who can edit customers
      // may always log one (the database lets office staff add it).
      if (!canMessageCustomers && !(input.channel === "call" && canEdit)) return;
      mutate((p) => {
        const text = input.body.trim();
        if (!text) return p;
        const customer = p.customers.find((c) => c.id === input.customerId);
        if (!customer) return p;
        const { threads, threadId } = ensureThread(
          p.threads,
          input.customerId,
        );
        const jobId = input.jobId ?? null;
        const message: Message = {
          id: uid(),
          customerId: input.customerId,
          jobId,
          estimateId: input.estimateId ?? null,
          channel: input.channel,
          direction: "out",
          senderCrewId: viewerIdExposed,
          senderName: actorRef.current,
          body: text,
          createdAt: new Date().toISOString(),
          fromNumber: input.channel === "sms" ? smsNumber(p) || null : null,
          threadId,
          // Queued only in this preview — no real SMS/email leaves
          // the app until Twilio / Gmail is connected in Phase 2.
          // A logged call is a record, not a queued send.
          queued: input.channel !== "call",
        };
        const label = `${input.channel === "sms" ? "Text" : input.channel === "email" ? "Email" : "Call log"} to ${customer.firstName} ${customer.lastName}`;
        return {
          ...p,
          threads,
          messages: [...(p.messages ?? []), message],
          auditLog: appendAudit(p.auditLog, [
            createdEntry(
              ctx("Message", message.id, label, input.customerId, jobId),
            ),
          ]),
        };
      });
    },
    [mutate, viewerIdExposed, canMessageCustomers, canEdit],
  );

  const saveAutomation = useCallback(
    (r: AutomationRule) =>
      mutate((p) => {
        const old = p.automations.find((x) => x.id === r.id);
        const entries = old
          ? diffFields(ctx("Automation", r.id, r.label, null), old, r, [
              "enabled",
              "timingDays",
              "template",
            ])
          : [createdEntry(ctx("Automation", r.id, r.label, null))];
        return {
          ...p,
          automations: old
            ? p.automations.map((x) => (x.id === r.id ? r : x))
            : [...p.automations, r],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const saveTimeOffRequest = useCallback(
    (r: TimeOffRequest) =>
      mutate((p) => {
        const old = p.timeOff.find((x) => x.id === r.id);
        const name = p.crew.find((c) => c.id === r.crewId)?.name ?? "Crew";
        const label = `${name} · ${r.startDate} → ${r.endDate}`;
        const entries = old
          ? diffFields(ctx("Time off", r.id, label, null), old, r, [
              "startDate",
              "endDate",
              "reason",
              "status",
            ])
          : [createdEntry(ctx("Time off", r.id, label, null))];
        return {
          ...p,
          timeOff: old
            ? p.timeOff.map((x) => (x.id === r.id ? r : x))
            : [...p.timeOff, r],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const deleteTimeOffRequest = useCallback(
    (id: string) =>
      mutate((p) => {
        const old = p.timeOff.find((x) => x.id === id);
        if (!old) return p;
        const name = p.crew.find((c) => c.id === old.crewId)?.name ?? "Crew";
        const entries = [
          deletedEntry(
            ctx(
              "Time off",
              id,
              `${name} · ${old.startDate} → ${old.endDate}`,
              null,
            ),
          ),
        ];
        return {
          ...p,
          timeOff: p.timeOff.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const decideTimeOffRequest = useCallback(
    (id: string, status: "approved" | "denied") =>
      mutate((p) => {
        // Owners, managers and the office decide (the database lets
        // staff update time_off_requests).
        if (!canDecideTimeOff(role)) return p;
        const old = p.timeOff.find((x) => x.id === id);
        if (!old || old.status === status) return p;
        const next: TimeOffRequest = {
          ...old,
          status,
          decidedBy: viewerName,
          decidedAt: todayStr(),
        };
        const name = p.crew.find((c) => c.id === old.crewId)?.name ?? "Crew";
        const entries = diffFields(
          ctx(
            "Time off",
            id,
            `${name} · ${old.startDate} → ${old.endDate}`,
            null,
          ),
          { status: old.status, decidedBy: old.decidedBy ?? "—" },
          { status, decidedBy: viewerName },
          ["status", "decidedBy"],
          { status: "decision", decidedBy: "decided by" },
        );
        return {
          ...p,
          timeOff: p.timeOff.map((x) => (x.id === id ? next : x)),
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate, role, viewerName],
  );

  const setClosedDay = useCallback(
    (date: string, reason: string | null) =>
      mutate((p) => {
        if (!isOwnerLike(role)) return p;
        const old = p.closedDays.find((x) => x.date === date);
        const record: ClosedDay = {
          date,
          reason,
          createdBy: viewer?.id ?? null,
        };
        const entries = old
          ? diffFields(
              ctx("Closed day", date, fmtDate(date), null),
              old,
              record,
              ["reason"],
            )
          : [createdEntry(ctx("Closed day", date, fmtDate(date), null))];
        return {
          ...p,
          closedDays: old
            ? p.closedDays.map((x) => (x.date === date ? record : x))
            : [...p.closedDays, record],
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate, role, viewer],
  );

  const removeClosedDay = useCallback(
    (date: string) =>
      mutate((p) => {
        if (!isOwnerLike(role)) return p;
        const old = p.closedDays.find((x) => x.date === date);
        if (!old) return p;
        return {
          ...p,
          closedDays: p.closedDays.filter((x) => x.date !== date),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(ctx("Closed day", date, fmtDate(date), null)),
          ]),
        };
      }),
    [mutate, role],
  );

  const decideBookingRequest = useCallback(
    (id: string, status: "accepted" | "declined", opts?: { customerId?: string }) => {
      // Already decided (double tap, or a teammate got there first):
      // nothing changes, so no estimate id is handed back.
      if (!bookingIsPending(stateRef.current, id)) return null;
      const estimateId = uid();
      mutate((p) => {
        const old = p.bookingRequests.find((x) => x.id === id);
        if (!old || old.status !== "pending") return p;
        if (status === "declined") {
          const next: BookingRequest = { ...old, status: "declined" };
          return {
            ...p,
            bookingRequests: p.bookingRequests.map((x) =>
              x.id === id ? next : x,
            ),
            auditLog: appendAudit(p.auditLog, [
              ...diffFields(
                ctx("Booking request", id, `${old.name} · ${fmtDate(old.date)}`, null),
                old,
                next,
                ["status"],
              ),
            ]),
          };
        }
        // Accept: the requester becomes a customer, with a draft
        // estimate for the visit. The job itself is scheduled from
        // the estimate, like any other accepted estimate.
        // A returning customer (picked by the office): no new record.
        const existing = opts?.customerId
          ? p.customers.find((c) => c.id === opts.customerId) ?? null
          : null;
        const { firstName, lastName } = bookingCustomerDraft(old);
        const customerId = existing?.id ?? uid();
        const customer: Customer = {
          id: customerId,
          firstName,
          lastName,
          company: "",
          phone: old.phone,
          email: old.email ?? "",
          address: old.address,
          city: "",
          zip: "",
          propertyNotes: "",
          gateCode: "",
          notes: `Booked online ${old.requestedAt} for ${fmtDate(old.date)}. ${old.details}`,
          mapLat: null,
          mapLng: null,
          boundary: null,
          type: "residential",
          companyName: null,
          contacts: [],
          projectName: null,
          projectNumber: null,
          poNumber: null,
          contractNumber: null,
          jobSiteAddress: null,
          billingTerms: null,
        };
        const estimate = bookingEstimate(
          old,
          { estimateId, customerId, lineId: uid() },
          todayStr(),
          existing,
        );
        const next: BookingRequest = {
          ...old,
          status: "accepted",
          estimateId,
        };
        return {
          ...p,
          customers: existing ? p.customers : [...p.customers, customer],
          estimates: [...p.estimates, estimate],
          bookingRequests: p.bookingRequests.map((x) =>
            x.id === id ? next : x,
          ),
          auditLog: appendAudit(p.auditLog, [
            ...(existing
              ? []
              : [
                  createdEntry(
                    ctx("Customer", customerId, `${firstName} ${lastName}`, customerId),
                  ),
                ]),
            createdEntry(
              ctx("Estimate", estimateId, estimate.title, customerId),
            ),
            ...diffFields(
              ctx("Booking request", id, `${old.name} · ${fmtDate(old.date)}`, customerId),
              old,
              next,
              ["status"],
            ),
          ]),
        };
      });
      return status === "accepted" ? estimateId : null;
    },
    [mutate],
  );

  const deleteBookingRequest = useCallback(
    (id: string) =>
      mutate((p) => {
        const old = p.bookingRequests.find((x) => x.id === id);
        if (!old) return p;
        return {
          ...p,
          bookingRequests: p.bookingRequests.filter((x) => x.id !== id),
          auditLog: appendAudit(p.auditLog, [
            deletedEntry(
              ctx("Booking request", id, `${old.name} · ${fmtDate(old.date)}`, null),
            ),
          ]),
        };
      }),
    [mutate],
  );

  const queueEstimateEmail = useCallback(
    (
      id: string,
      opts?: { again?: boolean; onResult?: (r: EstimateSendResult) => void },
    ) => {
      const onResult = opts?.onResult;
      if (!supabaseConfigured) {
        // Demo mode: record it as queued (no email leaves the browser).
        mutate((p) => {
          const old = p.estimates.find((e) => e.id === id);
          if (!old || old.emailQueuedAt) return p;
          const { threads, threadId } = ensureThread(p.threads, old.customerId);
          const next: Estimate = {
            ...old,
            emailQueuedAt: new Date().toISOString(),
          };
          const entries = diffFields(
            ctx("Estimate", id, old.title, old.customerId, old.jobId),
            { emailQueuedAt: "(not queued)" },
            { emailQueuedAt: `queued (thread ${threadId})` },
            ["emailQueuedAt"],
            { emailQueuedAt: "email" },
          );
          return {
            ...p,
            threads,
            estimates: p.estimates.map((e) => (e.id === id ? next : e)),
            auditLog: appendAudit(p.auditLog, entries),
          };
        });
        onResult?.({ sent: 0, reason: "demo" });
        return;
      }
      // Live: wait until everything queued so far (the estimate itself)
      // is in the database, then ask the server to email it.
      mutate(
        (p) => p,
        (saved) => {
          if (!saved) {
            onResult?.({ sent: 0, reason: "not-saved" });
            return;
          }
          void sendEstimateEmail(id, opts?.again === true).then((r) => {
            if (r.sent > 0) {
              // The server marked it emailed; show the same here.
              const at = r.emailedAt ?? new Date().toISOString();
              mutate((p) => {
                const old = p.estimates.find((e) => e.id === id);
                if (!old) return p;
                const next: Estimate = {
                  ...old,
                  emailQueuedAt: at,
                  status: old.status === "draft" ? "sent" : old.status,
                };
                const entries = diffFields(
                  ctx("Estimate", id, old.title, old.customerId, old.jobId),
                  { emailed: old.emailQueuedAt ? "emailed before" : "(not emailed)" },
                  { emailed: "emailed with an accept link" },
                  ["emailed"],
                  { emailed: "email" },
                );
                return {
                  ...p,
                  estimates: p.estimates.map((e) => (e.id === id ? next : e)),
                  auditLog: appendAudit(p.auditLog, entries),
                };
              });
            }
            onResult?.(r);
          });
        },
      );
    },
    [mutate],
  );

  const queueInvoiceEmail = useCallback(
    (
      id: string,
      opts?: {
        askReview?: boolean;
        again?: boolean;
        splitIds?: string[];
        confirmed?: number;
        onResult?: (r: InvoiceSendResult) => void;
      },
    ) => {
      const onResult = opts?.onResult;
      if (!supabaseConfigured) {
        // Demo mode: no email leaves the browser, and nothing is marked sent.
        onResult?.({ sent: 0, reason: "demo" });
        return;
      }
      // Live: wait until everything queued so far (the invoice itself)
      // is in the database, then ask the server to email it.
      mutate(
        (p) => p,
        (saved) => {
          if (!saved) {
            onResult?.({ sent: 0, reason: "not-saved" });
            return;
          }
          void sendInvoiceEmail(id, {
            askReview: opts?.askReview === true,
            again: opts?.again === true,
            splitIds: opts?.splitIds,
            confirmed: opts?.confirmed,
          }).then((r) => {
            if (r.sent > 0 && r.marked !== false) {
              // The server marked it emailed; show the same here.
              const at = r.emailedAt ?? new Date().toISOString();
              mutate((p) => {
                const old = p.invoices.find((i) => i.id === id);
                if (!old) return p;
                // emailedAt is shown only; the database set the real one
                // (invoiceToRow never sends it).
                const next: Invoice = {
                  ...old,
                  emailQueuedAt: at,
                  emailedAt: at,
                  ...(old.autoSendStatus === "waiting"
                    ? { autoSendStatus: "stopped" as const, autoSendNote: "sent-by-hand" }
                    : {}),
                };
                const entries = diffFields(
                  ctx("Invoice", id, old.number, old.customerId, old.jobId),
                  { emailed: old.emailQueuedAt ? "emailed before" : "(not emailed)" },
                  {
                    emailed: r.split
                      ? `emailed to ${r.sent} payer${r.sent === 1 ? "" : "s"} (their shares)${r.review ? ", with a review request" : ""}`
                      : r.review
                        ? "emailed, with a review request"
                        : "emailed",
                  },
                  ["emailed"],
                  { emailed: "email" },
                );
                return {
                  ...p,
                  invoices: p.invoices.map((i) => (i.id === id ? next : i)),
                  auditLog: appendAudit(p.auditLog, entries),
                };
              });
            }
            onResult?.(r);
          });
        },
      );
    },
    [mutate],
  );

  const sendPaymentReceipts = useCallback(
    (
      invoiceId: string,
      opts: { splitIds: string[]; again?: boolean; confirmed?: number; onResult?: (r: ReceiptSendResult) => void },
    ) => {
      const onResult = opts.onResult;
      if (!supabaseConfigured) {
        onResult?.({ sent: 0, reason: "demo", payers: [] });
        return;
      }
      if (opts.splitIds.length === 0) return;
      // Wait until the "paid" mark is in the database: the server reads it.
      mutate(
        (p) => p,
        (saved) => {
          if (!saved) {
            onResult?.({ sent: 0, reason: "not-saved", payers: [] });
            return;
          }
          void sendReceipts(invoiceId, {
            splitIds: opts.splitIds,
            again: opts.again === true,
            confirmed: opts.confirmed ?? 0,
          }).then((r) => onResult?.(r));
        },
      );
    },
    [mutate],
  );

  const setAutoClock = useCallback(
    (on: boolean) =>
      mutate((p) => {
        if (p.settings.autoClock === on) return p;
        const entries = diffFields(
          ctx("Settings", "settings", "App settings", null),
          { autoClock: p.settings.autoClock ? "on" : "off" },
          { autoClock: on ? "on" : "off" },
          ["autoClock"],
          { autoClock: "auto clock-in/out by location" },
        );
        return {
          ...p,
          settings: { ...p.settings, autoClock: on },
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const setAutoEmails = useCallback(
    (on: boolean) =>
      mutate((p) => {
        // The settings row is admin-only in the database too.
        if (!isOwnerLike(role)) return p;
        if ((p.settings.autoEmails === true) === on) return p;
        const entries = diffFields(
          ctx("Settings", "settings", "Automatic customer emails", null),
          { autoEmails: p.settings.autoEmails ? "on" : "off" },
          { autoEmails: on ? "on" : "off" },
          ["autoEmails"],
          { autoEmails: "automatic customer emails" },
        );
        return {
          ...p,
          settings: { ...p.settings, autoEmails: on },
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate, role],
  );

  const saveSkillCatalog = useCallback(
    (catalog: SkillDef[]) =>
      mutate((p) => {
        const before = skillCatalog(p);
        const keep = new Set(catalog.map((x) => x.id));
        const removed = before.filter((x) => !keep.has(x.id));
        const added = catalog.filter(
          (x) => !before.some((b) => b.id === x.id),
        );
        const renamed = catalog.filter((x) =>
          before.some((b) => b.id === x.id && (b.label !== x.label || b.group !== x.group)),
        );
        if (removed.length === 0 && added.length === 0 && renamed.length === 0) {
          return p;
        }
        const c = ctx("Settings", "skills", "Skill list", null);
        const entry = (field: string, oldValue: string, newValue: string) => ({
          ...createdEntry(c),
          field,
          oldValue,
          newValue,
        });
        const entries = [
          ...added.map((x) => entry("skill added", "", x.label)),
          ...removed.map((x) => entry("skill removed", x.label, "")),
          ...renamed.map((x) =>
            entry(
              "skill renamed",
              before.find((b) => b.id === x.id)?.label ?? "",
              x.label,
            ),
          ),
        ];
        const gone = new Set(removed.map((x) => x.id));
        const crew = gone.size
          ? p.crew.map((m) =>
              (m.skills ?? []).some((id) => gone.has(id))
                ? { ...m, skills: (m.skills ?? []).filter((id) => !gone.has(id)) }
                : m,
            )
          : p.crew;
        return {
          ...p,
          crew,
          settings: {
            ...p.settings,
            planner: { ...(p.settings.planner ?? {}), skillCatalog: catalog },
          },
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const applyDayPlan = useCallback(
    (date: string, plan: DayPlan, setTimes: boolean): number => {
      const current = stateRef.current;
      if (!current) return 0;
      const counted = Object.values(planToJobPatches(plan, current)).filter(
        (x) => x.changed,
      ).length;
      mutate((p) => {
        const patches = planToJobPatches(plan, p);
        const entries: AuditEntry[] = [];
        const jobs = p.jobs.map((j) => {
          const pt = patches[j.id];
          if (!pt || !pt.changed) return j;
          const next: Job = {
            ...j,
            crewIds: pt.crewIds,
            equipmentIds: pt.equipmentIds,
            equipmentDrivers: pt.equipmentDrivers,
            ...(setTimes && pt.suggestedStartTime
              ? { startTime: pt.suggestedStartTime }
              : {}),
          };
          const c = ctx("Job", j.id, j.title, j.customerId, j.id);
          entries.push(
            ...diffFields(c, j, next, ["startTime", "equipmentIds"]),
            ...memberChangeEntries(
              c,
              next.crewIds.filter((id) => !j.crewIds.includes(id)).map((id) => crewName(p, id)),
              j.crewIds.filter((id) => !next.crewIds.includes(id)).map((id) => crewName(p, id)),
            ),
          );
          return next;
        });
        // The day's crews become the plan's crews (ids kept by position).
        const existing = (p.dayCrews ?? []).filter((c) => c.date === date);
        const others = (p.dayCrews ?? []).filter((c) => c.date !== date);
        const planned: DayCrew[] = plan.crews.map((c, i) => ({
          id: existing[i]?.id ?? uid(),
          date,
          name: c.name,
          memberIds: [...c.memberIds],
        }));
        // Snapshot of what the planner proposed, for learning later.
        const snapshot = JSON.stringify({
          v: 1,
          mode: plan.mode,
          crews: plan.crews.map((c) => ({
            m: c.memberIds,
            r: c.rigs.map((r) => [r.truckId, r.haulId, ...r.carriedIds]),
            d: c.drivers,
            j: c.stops.map((st) => st.jobId),
          })),
          notPlaced: plan.notPlaced.map((n) => n.jobId),
          spare: plan.spare.map((x) => x.crewId),
        });
        entries.push({
          ...createdEntry(ctx("Day plan", date, `Day plan · ${fmtDate(date)}`, null)),
          field: "plan applied",
          oldValue: "",
          newValue: snapshot,
        });
        return {
          ...p,
          jobs,
          dayCrews: [...others, ...planned],
          auditLog: appendAudit(p.auditLog, entries),
        };
      });
      return counted;
    },
    [mutate],
  );

  const saveDayBoard = useCallback(
    (date: string, patches: Record<string, DayBoardPatch>, snapshot: string, onSaved?: (ok: boolean) => void): number => {
      const current = stateRef.current;
      if (!current) return 0;
      // The same rule the Fill preview and its Undo use (planner/board.ts).
      const apply = (j: Job): Job | null => boardPatchJob(current, j, patches[j.id], date);
      const counted = current.jobs.filter((j) => apply(j) !== null).length;
      mutate((p) => {
        const entries: AuditEntry[] = [];
        const jobs = p.jobs.map((j) => {
          const next = apply(j);
          if (!next) return j;
          const c = ctx("Job", j.id, j.title, j.customerId, j.id);
          entries.push(
            ...diffFields(c, j, next, ["startTime", "equipmentIds"]),
            ...memberChangeEntries(
              c,
              next.crewIds.filter((id) => !j.crewIds.includes(id)).map((id) => crewName(p, id)),
              j.crewIds.filter((id) => !next.crewIds.includes(id)).map((id) => crewName(p, id)),
            ),
          );
          return next;
        });
        entries.push({
          ...createdEntry(ctx("Day plan", date, `Day plan · ${fmtDate(date)}`, null)),
          field: "plan applied",
          oldValue: "",
          newValue: snapshot,
        });
        return { ...p, jobs, auditLog: appendAudit(p.auditLog, entries) };
      }, counted > 0 ? onSaved : undefined);
      return counted;
    },
    [mutate],
  );

  const savePlannerSettings = useCallback(
    (patch: Partial<PlannerSettings>) =>
      mutate((p) => {
        const before = p.settings.planner ?? {};
        const next = { ...before, ...patch };
        if (JSON.stringify(next) === JSON.stringify(before)) return p;
        const c = ctx("Settings", "planner", "Scheduler settings", null);
        const entries = Object.keys(patch).map((k) => ({
          ...createdEntry(c),
          field: k,
          oldValue: JSON.stringify((before as Record<string, unknown>)[k] ?? ""),
          newValue: JSON.stringify((patch as Record<string, unknown>)[k] ?? ""),
        }));
        return {
          ...p,
          settings: { ...p.settings, planner: next },
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const dismissSkillSuggestions = useCallback(
    (keys: string[]) =>
      mutate((p) => {
        const before = p.settings.planner?.dismissedSkillSuggestions ?? [];
        const next = [...new Set([...before, ...keys])];
        if (next.length === before.length) return p;
        return {
          ...p,
          settings: {
            ...p.settings,
            planner: { ...(p.settings.planner ?? {}), dismissedSkillSuggestions: next },
          },
        };
      }),
    [mutate],
  );

  const setCalendarSettings = useCallback(
    (patch: Partial<Omit<AppSettings, "autoClock">>) =>
      mutate((p) => {
        const next = { ...p.settings, ...patch };
        if (
          next.dailyTarget === p.settings.dailyTarget &&
          next.suggestDays === p.settings.suggestDays &&
          next.suggestMaxMinutes === p.settings.suggestMaxMinutes &&
          next.suggestMaxMiles === p.settings.suggestMaxMiles &&
          next.suggestMaxOver === p.settings.suggestMaxOver &&
          next.suggestSkipWeekends === p.settings.suggestSkipWeekends &&
          next.suggestSkipHolidays === p.settings.suggestSkipHolidays &&
          next.hoverRoute === p.settings.hoverRoute &&
          next.showDayTotals === p.settings.showDayTotals &&
          next.crewRules === p.settings.crewRules &&
          next.company === p.settings.company
        )
          return p;
        const entries = diffFields(
          ctx("Settings", "settings", "Calendar settings", null),
          {
            dailyTarget: String(p.settings.dailyTarget ?? 0),
            suggestDays: p.settings.suggestDays ? "on" : "off",
            suggestMaxMinutes: `${p.settings.suggestMaxMinutes ?? 30} min`,
            suggestMaxMiles: `${p.settings.suggestMaxMiles ?? 5} mi`,
            suggestMaxOver: String(p.settings.suggestMaxOver ?? 0),
            suggestSkipWeekends:
              p.settings.suggestSkipWeekends !== false ? "on" : "off",
            suggestSkipHolidays:
              p.settings.suggestSkipHolidays !== false ? "on" : "off",
            hoverRoute: p.settings.hoverRoute ? "on" : "off",
            showDayTotals: p.settings.showDayTotals ? "on" : "off",
          },
          {
            dailyTarget: String(next.dailyTarget ?? 0),
            suggestDays: next.suggestDays ? "on" : "off",
            suggestMaxMinutes: `${next.suggestMaxMinutes ?? 30} min`,
            suggestMaxMiles: `${next.suggestMaxMiles ?? 5} mi`,
            suggestMaxOver: String(next.suggestMaxOver ?? 0),
            suggestSkipWeekends:
              next.suggestSkipWeekends !== false ? "on" : "off",
            suggestSkipHolidays:
              next.suggestSkipHolidays !== false ? "on" : "off",
            hoverRoute: next.hoverRoute ? "on" : "off",
            showDayTotals: next.showDayTotals ? "on" : "off",
          },
          [
            "dailyTarget",
            "suggestDays",
            "suggestMaxMinutes",
            "suggestMaxMiles",
            "suggestMaxOver",
            "suggestSkipWeekends",
            "suggestSkipHolidays",
            "hoverRoute",
            "showDayTotals",
          ],
          {
            dailyTarget: "daily target",
            suggestDays: "suggest days for approved estimates",
            suggestMaxMinutes: "suggest within minutes",
            suggestMaxMiles: "suggest within miles",
            suggestMaxOver: "suggest over target by",
            suggestSkipWeekends: "never suggest weekends",
            suggestSkipHolidays: "never suggest federal holidays",
            hoverRoute: "hover route preview",
            showDayTotals: "show day totals",
          },
        );
        return {
          ...p,
          settings: next,
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const setInvoiceSettings = useCallback(
    (
      patch: Partial<
        Pick<AppSettings, "commercialTermsDays" | "residentialTermsDays">
      >,
    ) =>
      mutate((p) => {
        const next = { ...p.settings, ...patch };
        if (
          next.commercialTermsDays === p.settings.commercialTermsDays &&
          next.residentialTermsDays === p.settings.residentialTermsDays
        )
          return p;
        const entries = diffFields(
          ctx("Settings", "settings", "Invoice settings", null),
          {
            commercialTermsDays: termsLabel(
              p.settings.commercialTermsDays ?? 30,
            ),
            residentialTermsDays: termsLabel(
              p.settings.residentialTermsDays ?? 0,
            ),
          },
          {
            commercialTermsDays: termsLabel(next.commercialTermsDays ?? 30),
            residentialTermsDays: termsLabel(
              next.residentialTermsDays ?? 0,
            ),
          },
          ["commercialTermsDays", "residentialTermsDays"],
          {
            commercialTermsDays: "commercial payment terms",
            residentialTermsDays: "residential payment terms",
          },
        );
        return {
          ...p,
          settings: next,
          auditLog: appendAudit(p.auditLog, entries),
        };
      }),
    [mutate],
  );

  const resetDemo = useCallback(() => {
    void adapterRef.current.reset().then((s) => setState(s));
  }, []);

  const value = useMemo<Store>(
    () => ({
      state,
      loading,
      role,
      setRole,
      viewerCrewId,
      setViewerCrewId,
      viewerId: viewerIdExposed,
      setViewerId: setViewerIdSafe,
      viewer,
      canEdit,
      canEditJobs,
      canSell,
      canSeeMoney,
      canSeeAllCustomers,
      canSeeAllJobs,
      showMoney,
      canMessageCustomers,
      canManualClockIn,
      mayTypeClockTimes,
      viewerName,
      supabaseMode,
      authUser,
      authLoading,
      authError,
      signIn,
      signUp,
      signOut,
      accessStatus,
      memberRoles,
      approveMember,
      rejectMember,
      revokeMember,
      changeMemberRole,
      twoStep,
      confirmTwoStepCode,
      loadTwoStepLogins,
      resetTwoStepLogin,
      loadError,
      reloadState,
      saveStatus,
      saveError,
      saveFailedTable,
      saveMigrationHint,
      retrySave,
      retryFieldQueue,
      clearSaveError,
      unsavedNonField,
      saveRefused,
      clearSaveRefused,
      view,
      scheduleFocusDate,
      planDay,
      schedulePlanFocus,
      clearSchedulePlanFocus,
      setScheduleFocusDate,
      setView,
      customerFocusId,
      setCustomerFocusId,
      drawerStack,
      openJob,
      createJob,
      newEstimateFor,
      openEmployee,
      openCustomer,
      openEstimate,
      openInvoice,
      closeDrawer,
      replaceDrawers,
      jobAccessDenied,
      clearJobAccessDenied,
      saveCustomer,
      deleteCustomer,
      saveTree,
      deleteTree,
      savePhcProgram,
      deletePhcProgram,
      savePhcVisit,
      saveChemicalRecord,
      deleteChemicalRecord,
      saveEquipment,
      deleteEquipment,
      setEquipmentDown,
      acceptProposal,
      jobFromEstimate,
      saveJob,
      rescheduleJob,
      moveJob,
      setJobCrew,
      setJobStatus,
      setEstimateVisit,
      createSalesEstimate,
      suggestCustomerEdit,
      decideCustomerEdit,
      changeJobPrice,
      markPriceChangeSeen,
      restoreEstimatePrice,
      reportEquipmentProblem,
      resolveEquipmentProblem,
      addDayCrew,
      renameDayCrew,
      setDayCrewMembers,
      deleteDayCrew,
      applyDayCrewToJob,
      addUnavailabilitySpan,
      deleteUnavailabilitySpan,
      requestLocations,
      shareMyLocation,
      setJobEquipment,
      saveMaintenanceTask,
      deleteMaintenanceTask,
      logMaintenance,
      deleteMaintenanceRecord,
      addEquipmentNote,
      deleteEquipmentNote,
      saveCompanyDocument,
      deleteCompanyDocument,
      deleteJob,
      saveEstimate,
      deleteEstimate,
      saveInvoice,
      stopInvoiceAutoSend,
      markInvoicePaid,
      markSplitPaid,
      invoiceFromEstimate,
      invoiceFromJob,
      addTimesheet,
      clockIn,
      clockOut,
      updateTimesheet,
      deleteTimesheet,
      addPrivateNote,
      deletePrivateNote,
      saveCrewMember,
      deleteCrewMember,
      saveMessageIntro,
      saveAutomation,
      saveTimeOffRequest,
      deleteTimeOffRequest,
      decideTimeOffRequest,
      setClosedDay,
      removeClosedDay,
      decideBookingRequest,
      deleteBookingRequest,
      queueEstimateEmail,
      queueInvoiceEmail,
      sendPaymentReceipts,
      sendMessage,
      setAutoClock,
      setAutoEmails,
      setCalendarSettings,
      saveSkillCatalog,
      dismissSkillSuggestions,
      savePlannerSettings,
      applyDayPlan,
      saveDayBoard,
      setInvoiceSettings,
      resetDemo,
    }),
    [
      state,
      loading,
      role,
      setRole,
      viewerIdExposed,
      viewer,
      canEdit,
      canEditJobs,
      canSell,
      canSeeMoney,
      showMoney,
      canSeeAllCustomers,
      canSeeAllJobs,
      canMessageCustomers,
      canManualClockIn,
      mayTypeClockTimes,
      viewerName,
      supabaseMode,
      authUser,
      authLoading,
      authError,
      signIn,
      signUp,
      signOut,
      accessStatus,
      memberRoles,
      approveMember,
      rejectMember,
      revokeMember,
      changeMemberRole,
      twoStep,
      confirmTwoStepCode,
      loadTwoStepLogins,
      resetTwoStepLogin,
      loadError,
      reloadState,
      saveStatus,
      saveError,
      saveFailedTable,
      saveMigrationHint,
      retrySave,
      retryFieldQueue,
      clearSaveError,
      unsavedNonField,
      saveRefused,
      clearSaveRefused,
      view,
      scheduleFocusDate,
      planDay,
      schedulePlanFocus,
      clearSchedulePlanFocus,
      setScheduleFocusDate,
      customerFocusId,
      drawerStack,
      openJob,
      createJob,
      newEstimateFor,
      openEmployee,
      openCustomer,
      openEstimate,
      openInvoice,
      closeDrawer,
      replaceDrawers,
      jobAccessDenied,
      clearJobAccessDenied,
      saveCustomer,
      deleteCustomer,
      saveTree,
      deleteTree,
      savePhcProgram,
      deletePhcProgram,
      savePhcVisit,
      saveChemicalRecord,
      deleteChemicalRecord,
      saveEquipment,
      deleteEquipment,
      setEquipmentDown,
      acceptProposal,
      jobFromEstimate,
      saveJob,
      rescheduleJob,
      moveJob,
      setJobCrew,
      setJobStatus,
      setEstimateVisit,
      createSalesEstimate,
      suggestCustomerEdit,
      decideCustomerEdit,
      changeJobPrice,
      markPriceChangeSeen,
      restoreEstimatePrice,
      reportEquipmentProblem,
      resolveEquipmentProblem,
      addDayCrew,
      renameDayCrew,
      setDayCrewMembers,
      deleteDayCrew,
      applyDayCrewToJob,
      addUnavailabilitySpan,
      deleteUnavailabilitySpan,
      requestLocations,
      shareMyLocation,
      setJobEquipment,
      saveMaintenanceTask,
      deleteMaintenanceTask,
      logMaintenance,
      deleteMaintenanceRecord,
      addEquipmentNote,
      deleteEquipmentNote,
      saveCompanyDocument,
      deleteCompanyDocument,
      deleteJob,
      saveEstimate,
      deleteEstimate,
      saveInvoice,
      stopInvoiceAutoSend,
      markInvoicePaid,
      markSplitPaid,
      invoiceFromEstimate,
      invoiceFromJob,
      addTimesheet,
      clockIn,
      clockOut,
      updateTimesheet,
      deleteTimesheet,
      addPrivateNote,
      deletePrivateNote,
      saveCrewMember,
      deleteCrewMember,
      saveMessageIntro,
      saveAutomation,
      saveTimeOffRequest,
      deleteTimeOffRequest,
      decideTimeOffRequest,
      setClosedDay,
      removeClosedDay,
      decideBookingRequest,
      deleteBookingRequest,
      queueEstimateEmail,
      queueInvoiceEmail,
      sendPaymentReceipts,
      sendMessage,
      setAutoClock,
      setAutoEmails,
      setCalendarSettings,
      saveSkillCatalog,
      dismissSkillSuggestions,
      savePlannerSettings,
      applyDayPlan,
      saveDayBoard,
      setInvoiceSettings,
      resetDemo,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Autosaving draft hook. `key` identifies the draft (e.g. "estimate-new"
 * or "customer-edit-<id>"). The value is written to the adapter,
 * debounced by 600 ms, on every change — and restored on mount, so a
 * half-finished form survives navigation and page reloads.
 */
export function useDraft<T>(key: string, initial: T) {
  const [value, setValueState] = useState<T>(initial);
  const [restored, setRestored] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void defaultAdapter.loadDraft(key).then((d) => {
      if (cancelled) return;
      if (d !== undefined) {
        setValueState(d as T);
        setHasDraft(true);
      }
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
    // Load once per draft key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValueState((prev) => {
        const resolved =
          typeof next === "function"
            ? (next as (prev: T) => T)(prev)
            : next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void defaultAdapter.saveDraft(key, resolved);
          setHasDraft(true);
        }, 600);
        return resolved;
      });
    },
    [key],
  );

  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void defaultAdapter.clearDraft(key);
    setHasDraft(false);
    setValueState(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Show these values as saved (no draft kept), e.g. after a save made elsewhere. */
  const replaceSaved = useCallback(
    (next: T) => {
      if (timer.current) clearTimeout(timer.current);
      void defaultAdapter.clearDraft(key);
      setHasDraft(false);
      setValueState(next);
    },
    [key],
  );

  return { value, setValue, restored, hasDraft, discard, replaceSaved };
}

// Re-exported for components that render audit entries.
export { fmtVal };
