import type { DataAdapter, LoadOptions, SaveRefusal, SaveResult } from "./adapter";
import type {
  AppSettings,
  AppState,
  CalendarJob,
  AuditEntry,
  AutomationRule,
  BookingRequest,
  ChemicalRecord,
  ClosedDay,
  CrewMember,
  Customer,
  CustomerAddress,
  CustomerEditRequest,
  CrewLocation,
  JobPriceChange,
  DayCrew,
  DraftMap,
  Equipment,
  Estimate,
  Invoice,
  Job,
  EquipmentNote,
  EquipmentProblem,
  CompanyDocument,
  LocationRequest,
  MaintenanceRecord,
  MaintenanceTask,
  Message,
  PhcProgram,
  PhcVisit,
  PrivateNote,
  EmailThread,
  TimesheetEntry,
  TimeOffRequest,
  Tree,
  UnavailabilitySpan,
} from "../types";
import { supabaseConfig } from "../config";
import { supabase } from "./supabaseClient";
import { defaultAutomations } from "./seed";
import { isDocumentKind } from "../companyDocuments";
import { TAP_TOO_OLD_CODE } from "../clockTime";

/**
 * Phase 2 implementation of the DataAdapter: talks to Supabase through
 * the official @supabase/supabase-js client, directly from the browser.
 * The client sends the publishable anon key as `apikey` and the
 * logged-in user's session JWT as the Authorization bearer, which is
 * what the membership-keyed row-level security in supabase/migrations
 * checks. It is only selected when config.ts is filled in (see
 * selectAdapter.ts); with placeholders the app keeps using the mock
 * adapter. Session storage and token refresh belong to the client, so
 * this adapter never touches tokens, and the service_role key appears
 * nowhere in this codebase.
 *
 * Mapping conventions (see supabase/migrations for the same notes):
 * - Postgres columns are snake_case; TypeScript fields are camelCase.
 *   Every mapping lives in the toRow/fromRow functions below.
 * - Dates and timestamps the app treats as opaque ISO strings are stored
 *   as text, so they round-trip exactly (createdDate, issuedDate, date,
 *   clockIn, timestamps, ...). Only gps_pings.recorded_at is a real
 *   timestamptz, and gps pings are not read by this adapter yet.
 * - Money/rate fields (unitPrice, taxRate, discountValue, value, hours)
 *   are Postgres numeric; the adapter converts with Number().
 * - Estimate/invoice lines and the customer boundary are jsonb and pass
 *   through unchanged.
 * - Every row is stamped with config.companyId on write and filtered to
 *   it on read. Row-level security (supabase/migrations) additionally restricts
 *   each company's rows to its own members: the client sends the
 *   logged-in user's session JWT, and the policies check it against
 *   company_members. A signed-out request carries no membership, so it
 *   returns no rows — that is why the app shows a login screen instead
 *   of data in Supabase mode with no session.
 * - Drafts stay in localStorage even in Supabase mode (the simplest
 *   option the README allows): drafts are per-browser half-finished
 *   work, and moving them server-side is a later decision.
 * - The audit log is append-only here: saveState upserts it but never
 *   prunes it, so a truncated load can never delete history on save.
 * - PostgREST caps rows per request (server max-rows, typically 1000);
 *   a load past that cap silently truncates. At this app's scale that
 *   only matters for a very old audit log; pagination is later work.
 */

type Row = Record<string, unknown>;

const CACHE_KEY = "treeapp:supabase:cache:v1";
const DRAFTS_KEY = "treeapp:supabase:drafts:v1";

/** The client, or an error when the adapter is used unconfigured. */
function client() {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }
  return supabase;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

/* ------------------------------------------------------------------ */
/* Row mapping: one pair per table. fromRow = DB row -> app object.    */
/* toRow = app object -> DB row (company_id stamped on every row).    */
/* ------------------------------------------------------------------ */

function customerFromRow(r: Row): Customer {
  return {
    id: str(r.id),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    company: str(r.company),
    phone: str(r.phone),
    email: str(r.email),
    address: str(r.address),
    city: str(r.city),
    zip: str(r.zip),
    propertyNotes: str(r.property_notes),
    gateCode: str(r.gate_code),
    notes: str(r.notes),
    mapLat: numOrNull(r.map_lat),
    mapLng: numOrNull(r.map_lng),
    boundary: (r.boundary as Array<[number, number]> | null) ?? null,
    type: (r.customer_type as Customer["type"]) ?? "residential",
    companyName: strOrNull(r.company_name),
    projectName: strOrNull(r.project_name),
    projectNumber: strOrNull(r.project_number),
    poNumber: strOrNull(r.po_number),
    contractNumber: strOrNull(r.contract_number),
    jobSiteAddress: strOrNull(r.job_site_address),
    billingTerms: strOrNull(r.billing_terms),
    contacts: (r.contacts as Customer["contacts"]) ?? [],
    noAutoEmails: r.no_auto_emails === true,
    // Addresses live in their own table and are attached in loadState.
    addresses: [],
  };
}

function customerAddressFromRow(r: Row): CustomerAddress {
  return {
    id: str(r.id),
    label: str(r.label),
    street: str(r.street),
    city: str(r.city),
    state: str(r.state) || "CO",
    zip: str(r.zip),
    isPrimary: r.is_primary === true,
  };
}

function customerAddressToRow(customerId: string, a: CustomerAddress): Row {
  return {
    id: a.id,
    company_id: supabaseConfig.companyId,
    customer_id: customerId,
    label: a.label,
    street: a.street,
    city: a.city,
    state: a.state,
    zip: a.zip,
    is_primary: a.isPrimary,
  };
}

function customerToRow(c: Customer): Row {
  return {
    id: c.id,
    company_id: supabaseConfig.companyId,
    first_name: c.firstName,
    last_name: c.lastName,
    company: c.company,
    phone: c.phone,
    email: c.email,
    address: c.address,
    city: c.city,
    zip: c.zip,
    property_notes: c.propertyNotes,
    gate_code: c.gateCode,
    notes: c.notes,
    map_lat: c.mapLat,
    map_lng: c.mapLng,
    boundary: c.boundary,
    // Bulk-upsert rule: a NOT NULL column must be sent on EVERY row.
    // In one upsert request, a column sent by one row and omitted by
    // another lands as NULL on the omitted rows and violates the
    // not-null constraint. customer_type and contacts are NOT NULL,
    // so they are always sent; the other 004 columns are nullable
    // and stay guarded.
    customer_type: c.type ?? "residential",
    // Migration 004 columns: only sent when set (see above).
    ...(c.companyName ? { company_name: c.companyName } : {}),
    ...(c.projectName ? { project_name: c.projectName } : {}),
    ...(c.projectNumber ? { project_number: c.projectNumber } : {}),
    ...(c.poNumber ? { po_number: c.poNumber } : {}),
    ...(c.contractNumber ? { contract_number: c.contractNumber } : {}),
    ...(c.jobSiteAddress ? { job_site_address: c.jobSiteAddress } : {}),
    ...(c.billingTerms ? { billing_terms: c.billingTerms } : {}),
    contacts: c.contacts ?? [],
    // NOT NULL column: sent on every row (see the bulk-upsert rule above).
    no_auto_emails: c.noAutoEmails === true,
  };
}

function crewFromRow(r: Row): CrewMember {
  return {
    id: str(r.id),
    name: str(r.name),
    role: str(r.role),
    phone: str(r.phone),
    color: str(r.color),
    appRole: (r.app_role as CrewMember["appRole"]) ?? "crew",
    email: str(r.email),
    // Demo-only legacy field; real auth replaces it. Never a real secret.
    // Added by migration 002; undefined on databases that only ran
    // the original schema, where email matching still resolves the viewer.
    authUserId: (r.auth_user_id as string | null) ?? null,
    // Onboarding state (migration 006); rows from before it read as
    // active, and the app never invents a status.
    status: (r.status as CrewMember["status"]) ?? "active",
    // Personal message intro (migration 003); blank on older rows.
    messageIntro: str(r.message_intro),
    // Employment type + pay structure (migration 011); null when not set.
    employmentType: (r.employment_type as CrewMember["employmentType"]) ?? null,
    payType: (r.pay_type as CrewMember["payType"]) ?? null,
    payAmount: numOrNull(r.pay_amount),
    fixedWeeklyHours: numOrNull(r.fixed_weekly_hours),
    countedOnEveryJob: r.counted_on_every_job === true,
    // Crew suggestions (migration 020); null when not set.
    availableWeekdays: (r.available_weekdays as number[] | null) ?? null,
    canDriveEquipment: (r.can_drive_equipment as string[] | null) ?? null,
    worksWellWith: (r.works_well_with as string[] | null) ?? null,
    permissions: (r.permissions as CrewMember["permissions"]) ?? null,
    // Skills and driving (migration team_skills_and_fleet).
    skills: (r.skills as string[] | null) ?? [],
    driverLicensed: r.driver_licensed === true,
    companyInsured: r.company_insured === true,
    cdlClass: (r.cdl_class as CrewMember["cdlClass"]) ?? "none",
    lastResort: r.last_resort === true,
    prefersOwnTruck: r.prefers_own_truck === true,
    ownTruckId: (r.own_truck_id as string | null) ?? null,
  };
}

function crewToRow(c: CrewMember): Row {
  return {
    id: c.id,
    company_id: supabaseConfig.companyId,
    name: c.name,
    role: c.role,
    phone: c.phone,
    color: c.color,
    app_role: c.appRole,
    email: c.email,
    // Sent only when set, so writes still work on databases that have
    // not run migration 002 (no auth_user_id column there yet).
    ...(c.authUserId ? { auth_user_id: c.authUserId } : {}),
    // Onboarding state is only ever pending/revoked on databases that
    // ran migration 006, which is also what adds the column — but
    // status is NOT NULL, so it is always sent (see customerToRow):
    // omitting it on active members while a pending member sends it
    // lands as NULL on the active rows.
    status: c.status ?? "active",
    // message_intro is NOT NULL, so it is always sent (see
    // customerToRow). This was the "Couldn't save (crew)" failure:
    // one member's intro made the column land as NULL on everyone
    // without one.
    message_intro: c.messageIntro ?? "",
    // Same guard for migration 011: only send pay fields when set, so
    // writes keep working on databases without the columns.
    ...(c.employmentType ? { employment_type: c.employmentType } : {}),
    ...(c.payType ? { pay_type: c.payType } : {}),
    ...(c.payAmount ? { pay_amount: c.payAmount } : {}),
    // The "fixed hours and job cost flag" rules: always sent so clearing them saves.
    fixed_weekly_hours: c.fixedWeeklyHours ?? null,
    counted_on_every_job: c.countedOnEveryJob === true,
    // Same guard for migration 020: availability, drivers, groupings
    // and permissions are all nullable, so they are only sent when
    // set and a pre-020 database keeps working.
    ...(c.availableWeekdays != null
      ? { available_weekdays: c.availableWeekdays }
      : {}),
    ...(c.canDriveEquipment != null
      ? { can_drive_equipment: c.canDriveEquipment }
      : {}),
    ...(c.worksWellWith != null
      ? { works_well_with: c.worksWellWith }
      : {}),
    ...(c.permissions ? { permissions: c.permissions } : {}),
    // Skills and driving are always sent (NOT NULL with safe defaults;
    // own_truck_id as an explicit null so clearing it saves).
    skills: c.skills ?? [],
    driver_licensed: c.driverLicensed === true,
    company_insured: c.companyInsured === true,
    cdl_class: c.cdlClass ?? "none",
    last_resort: c.lastResort === true,
    prefers_own_truck: c.prefersOwnTruck === true,
    own_truck_id: c.ownTruckId ?? null,
  };
}

function jobFromRow(r: Row): Job {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    serviceType: r.service_type as Job["serviceType"],
    title: str(r.title),
    date: str(r.date),
    startTime: str(r.start_time),
    status: r.status as Job["status"],
    crewIds: (r.crew_ids as string[]) ?? [],
    notes: str(r.notes),
    customerNotes: str(r.customer_notes),
    teamNotes: str(r.team_notes),
    officeNotes: str(r.office_notes),
    pruneClass: (r.prune_class as Job["pruneClass"]) ?? null,
    estimatedHours: numOrNull(r.estimated_hours),
    estimateId: strOrNull(r.estimate_id),
    invoiceId: strOrNull(r.invoice_id),
    addressId: strOrNull(r.address_id),
    value: numOrNull(r.value),
    treeIds: (r.tree_ids as string[]) ?? [],
    equipmentIds: (r.equipment_ids as string[]) ?? [],
    endDate: strOrNull(r.end_date),
    recurring: (r.recurring as Job["recurring"]) ?? null,
    recurringUntil: strOrNull(r.recurring_until),
    materialsCost: numOrNull(r.materials_cost),
    otherCost: numOrNull(r.other_cost),
    laborRate: numOrNull(r.labor_rate),
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    expectedCrew: numOrNull(r.expected_crew),
    equipmentDrivers: (r.equipment_drivers as Job["equipmentDrivers"]) ?? null,
    crewArrivals: (r.crew_arrivals as Job["crewArrivals"]) ?? null,
    timePromised: r.time_promised === true,
    billingType: (r.billing_type as Job["billingType"]) ?? null,
    hourlyRate: numOrNull(r.hourly_rate),
    // The "money fixes" rules: set by change_job_price only, never sent.
    replacedPrice: numOrNull(r.replaced_price),
  };
}

function jobToRow(j: Job): Row {
  return {
    id: j.id,
    company_id: supabaseConfig.companyId,
    customer_id: j.customerId,
    service_type: j.serviceType,
    title: j.title,
    date: j.date,
    start_time: j.startTime,
    status: j.status,
    crew_ids: j.crewIds,
    notes: j.notes,
    estimate_id: j.estimateId,
    invoice_id: j.invoiceId,
    value: j.value,
    // Migration 010 columns: only sent when set (see customerToRow).
    ...(j.customerNotes ? { customer_notes: j.customerNotes } : {}),
    ...(j.teamNotes ? { team_notes: j.teamNotes } : {}),
    ...(j.officeNotes ? { office_notes: j.officeNotes } : {}),
    ...(j.pruneClass ? { prune_class: j.pruneClass } : {}),
    ...(j.estimatedHours !== null
      ? { estimated_hours: j.estimatedHours }
      : {}),
    // Migration 004 columns: tree_ids and equipment_ids are NOT NULL,
    // so they are always sent (see customerToRow); the rest are
    // nullable and stay guarded.
    tree_ids: j.treeIds ?? [],
    equipment_ids: j.equipmentIds ?? [],
    ...(j.endDate ? { end_date: j.endDate } : {}),
    ...(j.recurring ? { recurring: j.recurring } : {}),
    ...(j.recurringUntil ? { recurring_until: j.recurringUntil } : {}),
    ...(j.materialsCost !== null ? { materials_cost: j.materialsCost } : {}),
    ...(j.otherCost !== null ? { other_cost: j.otherCost } : {}),
    ...(j.laborRate !== null ? { labor_rate: j.laborRate } : {}),
    ...(j.lat !== null ? { lat: j.lat } : {}),
    ...(j.lng !== null ? { lng: j.lng } : {}),
    // Migration 018 column: only sent when set (see customerToRow).
    ...(j.addressId ? { address_id: j.addressId } : {}),
    // Migration 020 columns: only sent when set (see customerToRow).
    ...(j.expectedCrew != null ? { expected_crew: j.expectedCrew } : {}),
    // Always sent, so taking every driver off a job saves (null clears it).
    equipment_drivers: j.equipmentDrivers && Object.keys(j.equipmentDrivers).length > 0 ? j.equipmentDrivers : null,
    // The "crew arrival times" rules: when each person arrives (plan board).
    crew_arrivals: j.crewArrivals && Object.keys(j.crewArrivals).length > 0 ? j.crewArrivals : null,
    // The "promised start time" rules.
    time_promised: j.timePromised === true,
    // Migration 022 columns: only sent when set (see customerToRow).
    ...(j.billingType ? { billing_type: j.billingType } : {}),
    ...(j.hourlyRate != null ? { hourly_rate: j.hourlyRate } : {}),
  };
}

function estimateFromRow(r: Row): Estimate {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    jobId: strOrNull(r.job_id),
    title: str(r.title),
    lines: (r.lines as Estimate["lines"]) ?? [],
    taxRate: num(r.tax_rate),
    discountType: (r.discount_type as Estimate["discountType"]) ?? "none",
    discountValue: num(r.discount_value),
    status: r.status as Estimate["status"],
    createdDate: str(r.created_date),
    notes: str(r.notes),
    emailQueuedAt: strOrNull(r.email_queued_at),
    options: (r.options as Estimate["options"]) ?? null,
    acceptedOptionId: strOrNull(r.accepted_option_id),
    acceptedBy: strOrNull(r.accepted_by),
    acceptedAt: strOrNull(r.accepted_at),
    expectedCrew: numOrNull(r.expected_crew),
    // The "estimate equipment and crew" rules columns (internal only).
    expectedClimbers: numOrNull(r.expected_climbers),
    expectedGroundsmen: numOrNull(r.expected_groundsmen),
    expectedCrewIds: (r.expected_crew_ids as string[] | null) ?? null,
    equipmentIds: (r.equipment_ids as string[] | null) ?? null,
    visitDate: strOrNull(r.visit_date),
    visitTime: strOrNull(r.visit_time),
    // The "sales access refine" rules: who wrote it (set by the database).
    createdByCrewId: strOrNull(r.created_by_crew_id),
  };
}

// created_by_crew_id is never sent: the database fills it in on insert
// from the signed-in login and keeps it on every update.
function estimateToRow(e: Estimate): Row {
  return {
    id: e.id,
    company_id: supabaseConfig.companyId,
    customer_id: e.customerId,
    job_id: e.jobId,
    title: e.title,
    lines: e.lines,
    tax_rate: e.taxRate,
    discount_type: e.discountType,
    discount_value: e.discountValue,
    status: e.status,
    created_date: e.createdDate,
    notes: e.notes,
    email_queued_at: e.emailQueuedAt,
    // Migration 004 columns: only sent when set (see customerToRow).
    ...(e.options && e.options.length > 0 ? { options: e.options } : {}),
    ...(e.acceptedOptionId ? { accepted_option_id: e.acceptedOptionId } : {}),
    ...(e.acceptedBy ? { accepted_by: e.acceptedBy } : {}),
    ...(e.acceptedAt ? { accepted_at: e.acceptedAt } : {}),
    // Migration 020 column: the estimator's expected crew (internal only).
    // Always sent, so clearing the crew on the estimate saves (null).
    expected_crew: e.expectedCrew ?? null,
    // The "estimate equipment and crew" rules columns: always sent (null clears).
    expected_climbers: e.expectedClimbers ?? null,
    expected_groundsmen: e.expectedGroundsmen ?? null,
    expected_crew_ids: e.expectedCrewIds && e.expectedCrewIds.length > 0 ? e.expectedCrewIds : null,
    equipment_ids: e.equipmentIds && e.equipmentIds.length > 0 ? e.equipmentIds : null,
    // The estimator's estimate-visit day + time (in the baseline).
    // Always sent, null included: an update sends only changed
    // columns, so leaving them out when cleared would never save
    // "Clear visit".
    visit_date: e.visitDate ?? null,
    visit_time: e.visitTime ?? null,
  };
}

function invoiceFromRow(r: Row): Invoice {
  return {
    id: str(r.id),
    number: str(r.number),
    customerId: str(r.customer_id),
    jobId: strOrNull(r.job_id),
    estimateId: strOrNull(r.estimate_id),
    lines: (r.lines as Invoice["lines"]) ?? [],
    taxRate: num(r.tax_rate),
    discountType: (r.discount_type as Invoice["discountType"]) ?? "none",
    discountValue: num(r.discount_value),
    status: r.status as Invoice["status"],
    issuedDate: str(r.issued_date),
    dueDate: str(r.due_date),
    paidDate: strOrNull(r.paid_date),
    // Migration 027 column: null = paid before methods were recorded.
    paymentMethod: (r.payment_method as Invoice["paymentMethod"]) ?? null,
    emailQueuedAt: strOrNull(r.email_queued_at),
    splits: (r.splits as Invoice["splits"]) ?? [],
    // Read-only here: written by the database, never sent by invoiceToRow.
    autoCreated: r.auto_created === true,
    autoSendAt: strOrNull(r.auto_send_at),
    autoSendStatus: (r.auto_send_status as Invoice["autoSendStatus"]) ?? null,
    autoSendNote: strOrNull(r.auto_send_note),
    autoSentAt: strOrNull(r.auto_sent_at),
    emailedAt: strOrNull(r.emailed_at),
  };
}

function invoiceToRow(i: Invoice): Row {
  return {
    id: i.id,
    company_id: supabaseConfig.companyId,
    number: i.number,
    customer_id: i.customerId,
    job_id: i.jobId,
    estimate_id: i.estimateId,
    lines: i.lines,
    tax_rate: i.taxRate,
    discount_type: i.discountType,
    discount_value: i.discountValue,
    status: i.status,
    issued_date: i.issuedDate,
    due_date: i.dueDate,
    paid_date: i.paidDate,
    // Migration 027 column: only sent when a method is recorded, so
    // the app keeps working before 027 runs (same pattern as the 024
    // visit columns — an unset method is never sent).
    ...(i.paymentMethod ? { payment_method: i.paymentMethod } : {}),
    email_queued_at: i.emailQueuedAt,
    // splits is NOT NULL, so it is always sent (see customerToRow).
    splits: i.splits ?? [],
  };
}

function timesheetFromRow(r: Row): TimesheetEntry {
  return {
    id: str(r.id),
    crewId: str(r.crew_id),
    jobId: strOrNull(r.job_id),
    date: str(r.date),
    clockIn: strOrNull(r.clock_in),
    clockOut: strOrNull(r.clock_out),
    hours: numOrNull(r.hours),
    notes: str(r.notes),
    location: str(r.location),
    autoClosed: r.auto_closed === true,
  };
}

// auto_closed is set by the database only (the 8 PM rule), never sent.
function timesheetToRow(t: TimesheetEntry): Row {
  return {
    id: t.id,
    company_id: supabaseConfig.companyId,
    crew_id: t.crewId,
    job_id: t.jobId,
    date: t.date,
    clock_in: t.clockIn,
    clock_out: t.clockOut,
    hours: t.hours,
    notes: t.notes,
    location: t.location,
  };
}

function noteFromRow(r: Row): PrivateNote {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    kind: r.kind as PrivateNote["kind"],
    author: str(r.author),
    createdAt: str(r.created_at),
    text: str(r.text),
  };
}

function noteToRow(n: PrivateNote): Row {
  return {
    id: n.id,
    company_id: supabaseConfig.companyId,
    customer_id: n.customerId,
    kind: n.kind,
    author: n.author,
    created_at: n.createdAt,
    text: n.text,
  };
}

function threadFromRow(r: Row): EmailThread {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    createdAt: str(r.created_at),
  };
}

function threadToRow(t: EmailThread): Row {
  return {
    id: t.id,
    company_id: supabaseConfig.companyId,
    customer_id: t.customerId,
    created_at: t.createdAt,
  };
}

function messageFromRow(r: Row): Message {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    jobId: strOrNull(r.job_id),
    estimateId: strOrNull(r.estimate_id),
    channel: r.channel as Message["channel"],
    direction: r.direction as Message["direction"],
    senderCrewId: str(r.sender_crew_id),
    senderName: str(r.sender_name),
    body: str(r.body),
    createdAt: str(r.created_at),
    fromNumber: strOrNull(r.from_number),
    threadId: strOrNull(r.thread_id),
    // Queued state is a preview concept (nothing is really sent
    // yet); rows loaded from the server are treated as delivered.
    queued: false,
  };
}

function messageToRow(m: Message): Row {
  return {
    id: m.id,
    company_id: supabaseConfig.companyId,
    customer_id: m.customerId,
    job_id: m.jobId,
    estimate_id: m.estimateId ?? null,
    channel: m.channel,
    direction: m.direction,
    sender_crew_id: m.senderCrewId,
    sender_name: m.senderName,
    body: m.body,
    created_at: m.createdAt,
    from_number: m.fromNumber,
    thread_id: m.threadId,
  };
}

function auditFromRow(r: Row): AuditEntry {
  return {
    id: str(r.id),
    timestamp: str(r.timestamp),
    actor: str(r.actor),
    entity: str(r.entity),
    entityId: str(r.entity_id),
    entityLabel: str(r.entity_label),
    field: str(r.field),
    oldValue: str(r.old_value),
    newValue: str(r.new_value),
    customerId: strOrNull(r.customer_id),
    jobId: strOrNull(r.job_id),
  };
}

function auditToRow(a: AuditEntry): Row {
  return {
    id: a.id,
    company_id: supabaseConfig.companyId,
    timestamp: a.timestamp,
    actor: a.actor,
    entity: a.entity,
    entity_id: a.entityId,
    entity_label: a.entityLabel,
    field: a.field,
    old_value: a.oldValue,
    new_value: a.newValue,
    customer_id: a.customerId,
    job_id: a.jobId ?? null,
  };
}

function automationFromRow(r: Row): AutomationRule {
  return {
    id: str(r.id),
    kind: r.kind as AutomationRule["kind"],
    label: str(r.label),
    description: str(r.description),
    enabled: r.enabled === true,
    timingDays: num(r.timing_days),
    template: str(r.template),
  };
}

/**
 * The saved rules plus any rule added in a later update (for example
 * "Auto-send invoices"), shown with its default (off) until the office
 * changes it. No saved rules at all = the defaults.
 */
export function withNewRules(saved: AutomationRule[]): AutomationRule[] {
  if (saved.length === 0) return defaultAutomations();
  const kinds = new Set(saved.map((r) => r.kind));
  const ids = new Set(saved.map((r) => r.id));
  const added = defaultAutomations().filter((d) => !kinds.has(d.kind) && !ids.has(d.id));
  return [...added, ...saved];
}

function automationToRow(a: AutomationRule): Row {
  return {
    id: a.id,
    company_id: supabaseConfig.companyId,
    kind: a.kind,
    label: a.label,
    description: a.description,
    enabled: a.enabled,
    timing_days: a.timingDays,
    template: a.template,
  };
}

function treeFromRow(r: Row): Tree {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    lat: num(r.lat),
    lng: num(r.lng),
    label: str(r.label),
    species: str(r.species),
    dbh: str(r.dbh),
    height: str(r.height),
    condition: r.condition as Tree["condition"],
    status: str(r.status),
    notes: str(r.notes),
    dbhHistory: (r.dbh_history as Tree["dbhHistory"]) ?? [],
    conditionHistory: (r.condition_history as Tree["conditionHistory"]) ?? [],
    riskRating: (r.risk_rating as Tree["riskRating"]) ?? "",
    riskNotes: str(r.risk_notes),
    photos: (r.photos as string[]) ?? [],
    nextInspectionDate: strOrNull(r.next_inspection_date),
    source: (r.source as Tree["source"]) ?? "manual",
    siteId: strOrNull(r.site_id),
  };
}

function treeToRow(t: Tree): Row {
  return {
    id: t.id,
    company_id: supabaseConfig.companyId,
    customer_id: t.customerId,
    lat: t.lat,
    lng: t.lng,
    label: t.label,
    species: t.species,
    dbh: t.dbh,
    height: t.height,
    condition: t.condition,
    status: t.status,
    notes: t.notes,
    // dbh_history, condition_history, risk_rating, risk_notes,
    // photos and source are NOT NULL, so they are always sent
    // (see customerToRow); next_inspection_date and site_id are
    // nullable and stay guarded.
    dbh_history: t.dbhHistory ?? [],
    condition_history: t.conditionHistory ?? [],
    risk_rating: t.riskRating ?? "",
    risk_notes: t.riskNotes ?? "",
    photos: t.photos ?? [],
    ...(t.nextInspectionDate
      ? { next_inspection_date: t.nextInspectionDate }
      : {}),
    source: t.source ?? "manual",
    ...(t.siteId ? { site_id: t.siteId } : {}),
  };
}

function equipmentFromRow(r: Row): Equipment {
  return {
    id: str(r.id),
    name: str(r.name),
    kind: r.kind as Equipment["kind"],
    details: str(r.details),
    status: r.status as Equipment["status"],
    // Pre-023 rows have no `down` column — undefined reads as null,
    // which means operational (see isEquipmentDown).
    down: (r.down as boolean | null) ?? null,
    tows: (r.tows as string[] | null) ?? null,
    seats: numOrNull(r.seats),
    weightLbs: numOrNull(r.weight_lbs),
    weeklyDriverLimit: numOrNull(r.weekly_driver_limit),
    homeSite: (r.home_site as string | null) ?? null,
  };
}

function equipmentToRow(e: Equipment): Row {
  return {
    id: e.id,
    company_id: supabaseConfig.companyId,
    name: e.name,
    kind: e.kind,
    details: e.details,
    status: e.status,
    // Only sent when set, so saves keep working before 023 runs; a
    // false value IS sent (it is a real state, not "unset").
    ...(e.down != null ? { down: e.down } : {}),
    // Fleet details for the scheduler: always sent, null when not set,
    // so clearing one saves.
    tows: e.tows ?? null,
    seats: e.seats ?? null,
    weight_lbs: e.weightLbs ?? null,
    weekly_driver_limit: e.weeklyDriverLimit ?? null,
    home_site: e.homeSite ?? null,
  };
}

function maintenanceTaskFromRow(r: Row): MaintenanceTask {
  return {
    id: str(r.id),
    equipmentId: str(r.equipment_id),
    name: str(r.name),
    intervalDays: Number(r.interval_days ?? 90) || 90,
  };
}

function maintenanceTaskToRow(t: MaintenanceTask): Row {
  return {
    id: t.id,
    company_id: supabaseConfig.companyId,
    equipment_id: t.equipmentId,
    name: t.name,
    interval_days: t.intervalDays,
  };
}

function maintenanceRecordFromRow(r: Row): MaintenanceRecord {
  return {
    id: str(r.id),
    taskId: str(r.task_id),
    date: str(r.date),
    hours: numOrNull(r.hours),
    notes: str(r.notes),
    doneBy: strOrNull(r.done_by),
  };
}

function maintenanceRecordToRow(r: MaintenanceRecord): Row {
  return {
    id: r.id,
    company_id: supabaseConfig.companyId,
    task_id: r.taskId,
    date: r.date,
    hours: r.hours ?? null,
    notes: r.notes,
    done_by: r.doneBy,
  };
}

function companyDocumentFromRow(r: Row): CompanyDocument {
  return {
    id: str(r.id),
    kind: isDocumentKind(r.kind) ? r.kind : "other",
    name: str(r.name),
    crewId: strOrNull(r.crew_id),
    issuer: str(r.issuer),
    startDate: strOrNull(r.start_date),
    expiryDate: strOrNull(r.expiry_date),
    notes: str(r.notes),
    fileId: strOrNull(r.file_id),
    fileName: str(r.file_name),
    createdAt: str(r.created_at),
  };
}

function companyDocumentToRow(d: CompanyDocument): Row {
  return {
    id: d.id,
    company_id: supabaseConfig.companyId,
    kind: d.kind,
    name: d.name,
    crew_id: d.crewId || null,
    issuer: d.issuer,
    start_date: d.startDate || null,
    expiry_date: d.expiryDate || null,
    notes: d.notes,
    file_id: d.fileId || null,
    file_name: d.fileName,
  };
}

function equipmentNoteFromRow(r: Row): EquipmentNote {
  return {
    id: str(r.id),
    equipmentId: str(r.equipment_id),
    authorId: str(r.author_id),
    authorName: str(r.author_name),
    text: str(r.text),
    createdAt: str(r.created_at),
  };
}

function equipmentNoteToRow(n: EquipmentNote): Row {
  return {
    id: n.id,
    company_id: supabaseConfig.companyId,
    equipment_id: n.equipmentId,
    author_id: n.authorId,
    author_name: n.authorName,
    text: n.text,
    created_at: n.createdAt,
  };
}

function phcProgramFromRow(r: Row): PhcProgram {
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    treeId: strOrNull(r.tree_id),
    name: str(r.name),
    type: r.type as PhcProgram["type"],
    status: r.status as PhcProgram["status"],
    startDate: str(r.start_date),
    renewalDate: str(r.renewal_date),
    visitIntervalMonths: num(r.visit_interval_months),
    notes: str(r.notes),
  };
}

function phcProgramToRow(p: PhcProgram): Row {
  return {
    id: p.id,
    company_id: supabaseConfig.companyId,
    customer_id: p.customerId,
    tree_id: p.treeId,
    name: p.name,
    type: p.type,
    status: p.status,
    start_date: p.startDate,
    renewal_date: p.renewalDate,
    visit_interval_months: p.visitIntervalMonths,
    notes: p.notes,
  };
}

function phcVisitFromRow(r: Row): PhcVisit {
  return {
    id: str(r.id),
    programId: str(r.program_id),
    date: str(r.date),
    status: r.status as PhcVisit["status"],
    notes: str(r.notes),
  };
}

function phcVisitToRow(v: PhcVisit): Row {
  return {
    id: v.id,
    company_id: supabaseConfig.companyId,
    program_id: v.programId,
    date: v.date,
    status: v.status,
    notes: v.notes,
  };
}

function chemicalRecordFromRow(r: Row): ChemicalRecord {
  return {
    id: str(r.id),
    programId: str(r.program_id),
    date: str(r.date),
    product: str(r.product),
    rate: str(r.rate),
    applicator: str(r.applicator),
    notes: str(r.notes),
  };
}

function chemicalRecordToRow(c: ChemicalRecord): Row {
  return {
    id: c.id,
    company_id: supabaseConfig.companyId,
    program_id: c.programId,
    date: c.date,
    product: c.product,
    rate: c.rate,
    applicator: c.applicator,
    notes: c.notes,
  };
}

function timeOffFromRow(r: Row): TimeOffRequest {
  return {
    id: str(r.id),
    crewId: str(r.crew_id),
    startDate: str(r.start_date),
    endDate: str(r.end_date),
    reason: str(r.reason),
    status: (r.status as TimeOffRequest["status"]) ?? "pending",
    requestedAt: str(r.requested_at),
    decidedBy: r.decided_by == null ? null : str(r.decided_by),
    decidedAt: r.decided_at == null ? null : str(r.decided_at),
  };
}

function timeOffToRow(t: TimeOffRequest): Row {
  return {
    id: t.id,
    company_id: supabaseConfig.companyId,
    crew_id: t.crewId,
    start_date: t.startDate,
    end_date: t.endDate,
    reason: t.reason,
    status: t.status,
    requested_at: t.requestedAt,
    decided_by: t.decidedBy,
    decided_at: t.decidedAt,
  };
}

function closedDayFromRow(r: Row): ClosedDay {
  return {
    date: str(r.id),
    reason: r.reason == null ? null : str(r.reason),
    createdBy: r.created_by == null ? null : str(r.created_by),
  };
}
function closedDayToRow(d: ClosedDay): Row {
  return {
    id: d.date,
    company_id: supabaseConfig.companyId,
    reason: d.reason,
    created_by: d.createdBy,
  };
}
function dayCrewFromRow(r: Row): DayCrew {
  return {
    id: str(r.id),
    date: str(r.date),
    name: str(r.name ?? "Crew 1"),
    memberIds: Array.isArray(r.member_ids)
      ? (r.member_ids as unknown[]).map((x) => String(x))
      : [],
  };
}
function dayCrewToRow(d: DayCrew): Row {
  return {
    id: d.id,
    company_id: supabaseConfig.companyId,
    date: d.date,
    name: d.name,
    member_ids: d.memberIds,
  };
}
function locationRequestFromRow(r: Row): LocationRequest {
  return {
    id: str(r.id),
    requestedBy: str(r.requested_by),
    requestedAt: str(r.requested_at),
    targetCrewId: r.target_crew_id == null ? null : str(r.target_crew_id),
  };
}
/** Suggested customer change (the "customer edit requests" rules); read-only in the app. */
function textMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}
export function customerEditRequestFromRow(r: Row): CustomerEditRequest {
  const changes = textMap(r.changes);
  const status = str(r.status);
  return {
    id: str(r.id),
    customerId: str(r.customer_id),
    requestedBy: r.requested_by == null ? null : str(r.requested_by),
    requestedName: str(r.requested_name),
    createdAt: str(r.created_at),
    changes,
    note: str(r.note),
    status: status === "approved" || status === "declined" ? status : "pending",
    decidedBy: r.decided_by == null ? null : str(r.decided_by),
    decidedAt: r.decided_at == null ? null : str(r.decided_at),
    declineReason: r.decline_reason == null ? "" : str(r.decline_reason),
    appliedChanges: r.applied_changes && typeof r.applied_changes === "object" ? textMap(r.applied_changes) : null,
  };
}

/**
 * Send a suggested customer change (Sales login). The database fills
 * in who and when, and refuses fields outside its allow-list.
 * Returns an error message, or null.
 */
export async function insertCustomerEditRequest(input: {
  customerId: string;
  changes: Record<string, string>;
  note: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client()
    .from("customer_edit_requests")
    .insert({
      company_id: supabaseConfig.companyId,
      customer_id: input.customerId,
      changes: input.changes,
      note: input.note,
    })
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: data?.id == null ? null : String(data.id), error: null };
}

/**
 * Office: approve (apply) or decline a suggestion. `changes` (approve)
 * are the office's edited values, sent only when they differ from the
 * suggestion; `reason` (decline) is optional. Returns an error message,
 * or null.
 */
export async function decideCustomerEditRequest(
  id: string,
  decision: "approve" | "decline",
  opts: { changes?: Record<string, string> | null; reason?: string } = {},
): Promise<string | null> {
  const args: Record<string, unknown> = { p_request_id: id };
  if (decision === "approve" && opts.changes) args.p_changes = opts.changes;
  if (decision === "decline" && opts.reason && opts.reason.trim() !== "") args.p_reason = opts.reason.trim();
  const { error } = await client().rpc(
    decision === "approve" ? "approve_customer_edit" : "decline_customer_edit",
    args,
  );
  return error ? error.message : null;
}

/** One equipment problem report (the "equipment problems" rules); read-only in the app. */
export function equipmentProblemFromRow(r: Row): EquipmentProblem {
  const status = str(r.status);
  return {
    id: str(r.id),
    equipmentId: str(r.equipment_id),
    note: str(r.note),
    status: status === "in_shop" || status === "fixed" ? status : "open",
    hasPhoto: r.has_photo === true,
    reportedBy: strOrNull(r.reported_by),
    reportedName: str(r.reported_name),
    createdAt: str(r.created_at),
    statusByName: strOrNull(r.status_by_name),
    statusAt: strOrNull(r.status_at),
  };
}

/**
 * Report a problem on a piece of equipment (anyone on the team). The
 * database fills in who and when. Returns the new report's id, or an
 * error message.
 */
export async function insertEquipmentProblem(input: {
  equipmentId: string;
  note: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await client()
    .from("equipment_problems")
    .insert({
      company_id: supabaseConfig.companyId,
      equipment_id: input.equipmentId,
      note: input.note,
    })
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: data?.id == null ? null : String(data.id), error: null };
}

/** Office: mark a report fixed, or send the machine to the shop. Returns an error message, or null. */
export async function resolveEquipmentProblemRpc(id: string, action: "fixed" | "shop"): Promise<string | null> {
  const { error } = await client().rpc("resolve_equipment_problem", { p_problem_id: id, p_action: action });
  return error ? error.message : null;
}

/** One logged job price change (the "climber price change notes" rules); read-only in the app. */
export function jobPriceChangeFromRow(r: Row): JobPriceChange {
  return {
    id: str(r.id),
    jobId: str(r.job_id),
    changedBy: strOrNull(r.changed_by),
    changedByName: str(r.changed_by_name),
    byOffice: r.by_office === true,
    changedAt: str(r.changed_at),
    oldValue: numOrNull(r.old_value),
    newValue: numOrNull(r.new_value),
    oldHourlyRate: numOrNull(r.old_hourly_rate),
    newHourlyRate: numOrNull(r.new_hourly_rate),
    oldBillingType: strOrNull(r.old_billing_type),
    newBillingType: strOrNull(r.new_billing_type),
    reason: str(r.reason),
    seenBy: strOrNull(r.seen_by),
    seenAt: strOrNull(r.seen_at),
  };
}

/**
 * Change a job's price with a reason (change_job_price): the database
 * checks who may, applies it, and logs it with the change history.
 * Returns an error message, or null.
 */
export async function changeJobPriceRpc(input: {
  jobId: string;
  value: number | null;
  hourlyRate: number | null;
  billingType: "flat" | "hourly" | null;
  reason: string;
}): Promise<string | null> {
  const { error } = await client().rpc("change_job_price", {
    p_job_id: input.jobId,
    p_value: input.value,
    p_hourly_rate: input.hourlyRate,
    p_billing_type: input.billingType,
    p_reason: input.reason,
  });
  return error ? error.message : null;
}

/**
 * Office: the job's estimate prices it again after a Climber replaced
 * its price (clear_replaced_price, the "money fixes" rules). Only the
 * office may; the database refuses anyone else, writes the change
 * history, and says so when there was nothing to clear. Returns an
 * error message, or null.
 */
export async function clearReplacedPriceRpc(jobId: string): Promise<string | null> {
  const { error } = await client().rpc("clear_replaced_price", { p_job_id: jobId });
  return error ? error.message : null;
}

/** Office: mark a crew price change seen. Returns an error message, or null. */
export async function markJobPriceChangeSeenRpc(id: string): Promise<string | null> {
  const { error } = await client().rpc("mark_job_price_change_seen", { p_id: id });
  return error ? error.message : null;
}

function locationRequestToRow(r: LocationRequest): Row {
  return {
    id: r.id,
    company_id: supabaseConfig.companyId,
    requested_by: r.requestedBy,
    requested_at: r.requestedAt,
    target_crew_id: r.targetCrewId,
  };
}
function crewLocationFromRow(r: Row): CrewLocation {
  return {
    id: str(r.id),
    crewId: str(r.crew_id),
    lat: Number(r.lat),
    lng: Number(r.lng),
    recordedAt: str(r.recorded_at),
    requestId: r.request_id == null ? null : str(r.request_id),
    jobId: r.job_id == null ? null : str(r.job_id),
  };
}
function crewLocationToRow(l: CrewLocation): Row {
  return {
    id: l.id,
    company_id: supabaseConfig.companyId,
    crew_id: l.crewId,
    lat: l.lat,
    lng: l.lng,
    recorded_at: l.recordedAt,
    request_id: l.requestId,
    job_id: l.jobId,
  };
}
function unavailabilityFromRow(r: Row): UnavailabilitySpan {
  return {
    id: str(r.id),
    crewId: str(r.crew_id),
    startDate: str(r.start_date),
    endDate: str(r.end_date),
  };
}
function unavailabilityToRow(s: UnavailabilitySpan): Row {
  return {
    id: s.id,
    company_id: supabaseConfig.companyId,
    crew_id: s.crewId,
    start_date: s.startDate,
    end_date: s.endDate,
  };
}
function bookingRequestFromRow(r: Row): BookingRequest {
  return {
    id: str(r.id),
    date: str(r.date),
    name: str(r.name),
    phone: str(r.phone),
    email: r.email == null ? null : str(r.email),
    address: str(r.address),
    details: str(r.details ?? ""),
    status: r.status as BookingRequest["status"],
    requestedAt: str(r.requested_at),
    estimateId: r.estimate_id == null ? null : str(r.estimate_id),
  };
}
function bookingRequestToRow(b: BookingRequest): Row {
  return {
    id: b.id,
    company_id: supabaseConfig.companyId,
    date: b.date,
    name: b.name,
    phone: b.phone,
    email: b.email,
    address: b.address,
    details: b.details,
    status: b.status,
    requested_at: b.requestedAt,
    estimate_id: b.estimateId,
  };
}

/** Tables synced by saveState, in dependency-safe order (parents first). */
const TABLES = [
  "customers",
  // Same pre-migration safety as time_off_requests: this table does
  // not exist until migration 018 runs.
  "customer_addresses",
  "crew",
  "jobs",
  "estimates",
  "invoices",
  "timesheets",
  "private_notes",
  "email_threads",
  "messages",
  "audit_log",
  "automations",
  "settings",
  "trees",
  "equipment",
  "phc_programs",
  "phc_visits",
  "chemical_records",
  // Last on purpose: until migration 008 runs, writes to this table
  // fail, and a failure here must not block the tables above it.
  "time_off_requests",
  // Same pre-migration safety as time_off_requests: these tables do
  // not exist until migration 012 runs.
  "maintenance_tasks",
  "maintenance_records",
  // Same pre-migration safety: these tables do not exist until
  // migration 013 runs.
  "closed_days",
  "booking_requests",
  // Same pre-migration safety: this table does not exist until
  // migration 014 runs.
  "equipment_notes",
  // Same pre-migration safety: this table does not exist until
  // migration 021 runs.
  "day_crews",
  // Same pre-migration safety: these tables do not exist until
  // migration 022 runs.
  "location_requests",
  "crew_locations",
  // Same pre-migration safety: this table does not exist until
  // migration 026 runs.
  "crew_unavailability",
  // Licences & insurance (the "company documents" rules); staff only.
  "company_documents",
] as const;

type TableName = (typeof TABLES)[number];

/**
 * Tables that do not exist until a later migration runs, and the file
 * that adds them. Writes to one of these are skipped (and retried on
 * a later save) instead of failing the whole save.
 */
const MISSING_TABLE_MIGRATION: Record<string, string> = {
  time_off_requests: "20260101000000_baseline.sql",
  maintenance_tasks: "20260101000000_baseline.sql",
  maintenance_records: "20260101000000_baseline.sql",
  closed_days: "20260101000000_baseline.sql",
  booking_requests: "20260101000000_baseline.sql",
  equipment_notes: "20260101000000_baseline.sql",
  customer_addresses: "20260101000000_baseline.sql",
  day_crews: "20260101000000_baseline.sql",
  location_requests: "20260101000000_baseline.sql",
  crew_locations: "20260101000000_baseline.sql",
  crew_unavailability: "20260101000000_baseline.sql",
  company_documents: "20260101000000_baseline.sql",
};

/** The key a row is upserted and deleted by: its id, or company_id for settings. */
function rowKey(row: Row): string {
  return String(row.id ?? row.company_id ?? "");
}

/**
 * A stable fingerprint of a row for the delta save: two rows with the
 * same fingerprint are the same row. toRow builds its object in a
 * fixed key order, so JSON.stringify is stable here, and undefined
 * values are dropped on both sides of the comparison.
 */
function rowFingerprint(row: Row): string {
  return JSON.stringify(row);
}

function rowsFor(state: AppState, table: TableName): Row[] {
  switch (table) {
    case "customers":
      return state.customers.map(customerToRow);
    case "customer_addresses":
      return state.customers.flatMap((c) =>
        (c.addresses ?? []).map((a) => customerAddressToRow(c.id, a)),
      );
    case "crew":
      return state.crew.map(crewToRow);
    case "jobs":
      return state.jobs.map(jobToRow);
    case "estimates":
      return state.estimates.map(estimateToRow);
    case "invoices":
      return state.invoices.map(invoiceToRow);
    case "timesheets":
      return state.timesheets.map(timesheetToRow);
    case "private_notes":
      return state.notes.map(noteToRow);
    case "email_threads":
      return state.threads.map(threadToRow);
    case "messages":
      return state.messages.map(messageToRow);
    case "audit_log":
      return state.auditLog.map(auditToRow);
    case "automations":
      return state.automations.map(automationToRow);
    case "settings":
      return [
        {
          company_id: supabaseConfig.companyId,
          auto_clock: state.settings.autoClock,
          daily_target: state.settings.dailyTarget ?? 0,
          suggest_days: state.settings.suggestDays ?? true,
          suggest_max_minutes: state.settings.suggestMaxMinutes ?? 30,
          suggest_max_miles: state.settings.suggestMaxMiles ?? 5,
          suggest_max_over: state.settings.suggestMaxOver ?? 0,
          suggest_skip_weekends:
            state.settings.suggestSkipWeekends ?? true,
          suggest_skip_holidays:
            state.settings.suggestSkipHolidays ?? true,
          hover_route: state.settings.hoverRoute ?? true,
          show_day_totals: state.settings.showDayTotals ?? true,
          commercial_terms_days: state.settings.commercialTermsDays ?? 30,
          residential_terms_days: state.settings.residentialTermsDays ?? 0,
          ...(state.settings.crewRules != null
            ? { crew_rules: state.settings.crewRules }
            : {}),
          planner: state.settings.planner ?? null,
          // auto_emails_since is set by the database, never sent.
          auto_emails: state.settings.autoEmails === true,
          ...(state.settings.company != null
            ? { company_profile: state.settings.company }
            : {}),
        },
      ];
    case "trees":
      return state.trees.map(treeToRow);
    case "equipment":
      return state.equipment.map(equipmentToRow);
    case "phc_programs":
      return state.phcPrograms.map(phcProgramToRow);
    case "phc_visits":
      return state.phcVisits.map(phcVisitToRow);
    case "chemical_records":
      return state.chemicalRecords.map(chemicalRecordToRow);
    case "time_off_requests":
      return state.timeOff.map(timeOffToRow);
    case "maintenance_tasks":
      return state.maintenanceTasks.map(maintenanceTaskToRow);
    case "maintenance_records":
      return state.maintenanceRecords.map(maintenanceRecordToRow);
    case "equipment_notes":
      return (state.equipmentNotes ?? []).map(equipmentNoteToRow);
    case "day_crews":
      return (state.dayCrews ?? []).map(dayCrewToRow);
    case "location_requests":
      return (state.locationRequests ?? []).map(locationRequestToRow);
    case "crew_locations":
      return (state.crewLocations ?? []).map(crewLocationToRow);
    case "crew_unavailability":
      return (state.unavailability ?? []).map(unavailabilityToRow);
    case "company_documents":
      return (state.companyDocuments ?? []).map(companyDocumentToRow);
    case "closed_days":
      return state.closedDays.map(closedDayToRow);
    case "booking_requests":
      return state.bookingRequests.map(bookingRequestToRow);
  }
}

async function fetchRows(table: string, orderColumn?: string): Promise<Row[]> {
  // Supabase only returns 1,000 rows per request, so page through the
  // whole table in 1,000-row chunks. The id tiebreak keeps the order
  // stable across pages so no row is skipped or repeated at a boundary.
  const pageSize = 1000;
  const all: Row[] = [];
  for (let start = 0; ; start += pageSize) {
    const base = client()
      .from(table)
      .select("*")
      .eq("company_id", supabaseConfig.companyId);
    const { data, error } = orderColumn
      ? await base
          .order(orderColumn, { ascending: true })
          .order("id", { ascending: true })
          .range(start, start + pageSize - 1)
      : await base.range(start, start + pageSize - 1);
    if (error) {
      throw new Error(`Supabase ${table} read failed: ${error.message}`);
    }
    const rows = (data ?? []) as Row[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/**
 * Jobs, through app_jobs() (the "crew privacy notes prices and dates" rules): app_jobs blanks
 * office notes and dollar columns for crew who may not see them (and a
 * later migration closes reading them straight from the table). Paged like
 * fetchRows, in id order. Falls back to the plain table read on a
 * database that does not have app_jobs yet.
 */
export async function fetchJobRows(): Promise<Row[]> {
  const pageSize = 1000;
  const all: Row[] = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await client()
      .rpc("app_jobs", { p_company_id: supabaseConfig.companyId })
      .order("id", { ascending: true })
      .range(start, start + pageSize - 1);
    if (error) {
      if (start === 0 && isMissingFunction(error)) return fetchRows("jobs");
      throw new Error(`Supabase jobs read failed: ${error.message}`);
    }
    const rows = (data ?? []) as Row[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/** PostgREST / Postgres "no such function" (a migration not applied yet). */
export function isMissingFunction(error: { code?: string | null }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

/** Every booked job, calendar details only (calendar_jobs); [] if unavailable. */
async function fetchCalendarJobs(): Promise<CalendarJob[]> {
  const { data, error } = await client().rpc("calendar_jobs", {
    p_company_id: supabaseConfig.companyId,
  });
  if (error || !Array.isArray(data)) return [];
  return (data as Row[]).map((r) => ({
    id: str(r.id),
    date: str(r.date),
    endDate: (r.end_date as string | null) ?? null,
    startTime: str(r.start_time),
    title: str(r.title),
    serviceType: str(r.service_type),
    status: (r.status as CalendarJob["status"]) ?? "scheduled",
    crewIds: (r.crew_ids as string[] | null) ?? [],
    estimatedHours: numOrNull(r.estimated_hours),
    area: (r.area as string | null) ?? null,
  }));
}

/** Pay-free roster of active crew (Phase 3 migration); [] if unavailable. */
async function fetchCrewDirectory(): Promise<Row[]> {
  const { data, error } = await client().rpc("crew_directory", {
    p_company_id: supabaseConfig.companyId,
  });
  if (error || !Array.isArray(data)) return [];
  return data as Row[];
}

/**
 * A write the database answered with an error. `code` is the Postgres
 * error code: 42501 means this login is not allowed to make the change
 * (row-level security, or a permission trigger such as
 * limit_crew_job_edits). `reason` is the database's own message.
 */
class WriteError extends Error {
  readonly code: string | undefined;
  readonly reason: string;
  constructor(table: string, code: string | undefined, reason: string, verb = "write") {
    super(`Supabase ${table} ${verb} failed: ${reason}`);
    this.name = "WriteError";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * A refusal code: 42501 (this login may not make the change), or
 * CT001 (a clock tap too old to save, the "manager pay and live clock-in" rules; the
 * app keeps that tap on the phone for the office, src/fieldQueue.ts).
 */
export function isRefusalCode(code: string | undefined | null): boolean {
  return code === "42501" || code === TAP_TOO_OLD_CODE;
}

/** True when the database refused a write because this login may not make it. */
function isRefusal(e: unknown): e is WriteError {
  return e instanceof WriteError && isRefusalCode(e.code);
}

/**
 * Thrown when a write was refused and the session turns out to have no
 * company access at all (expired sign-in sent with only the public key,
 * or a password-only session of a login with two-step login on). The
 * same 42501 then means "not now", not "never": the change must stay
 * queued, not be counted as refused.
 */
class NoAccessError extends Error {
  constructor() {
    super(
      "Your sign-in needs refreshing, so nothing was saved yet. The change is kept and is saved by itself once you're signed in again (if it isn't, sign out and back in).",
    );
    this.name = "NoAccessError";
  }
}

/**
 * Does this session still count as a member of the company? false on
 * any error: a request without a valid sign-in gets "permission denied".
 */
async function sessionHasAccess(): Promise<boolean> {
  try {
    const { data, error } = await client().rpc("is_company_member", {
      p_company_id: supabaseConfig.companyId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** The access token requests are sent with right now, or null. */
async function currentAccessToken(): Promise<string | null> {
  try {
    const { data } = await client().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Rows the database refused while saving one table, and its reasons. */
interface Refused {
  count: number;
  reasons: string[];
}

function noteRefused(refused: Refused, reason: string, rows = 1): void {
  refused.count += rows;
  if (reason && !refused.reasons.includes(reason)) refused.reasons.push(reason);
}

async function upsertRows(
  table: string,
  rows: Row[],
  onConflict = "id",
): Promise<void> {
  // The audit log is append-only in the database (no UPDATE policy).
  // Use plain inserts: an upsert (even ON CONFLICT DO NOTHING) needs
  // the row to be readable by the writer, and crew cannot read audit
  // entries that are not about one of their jobs. A retried entry that
  // already landed fails with 23505 (duplicate) and counts as saved.
  if (table === "audit_log") {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await client().from(table).insert(chunk);
      if (!error) continue;
      if (error.code !== "23505") {
        throw new WriteError(table, error.code, error.message);
      }
      for (const row of chunk) {
        const { error: rowError } = await client().from(table).insert(row);
        if (rowError && rowError.code !== "23505") {
          throw new WriteError(table, rowError.code, rowError.message);
        }
      }
    }
    return;
  }
  // Jobs: an upsert copies every column from EXCLUDED, which needs the
  // right to read it, and reading office notes and prices straight from
  // the table is being closed (after the "crew privacy notes prices and dates" rules, once
  // every phone runs a build that loads jobs through app_jobs). So
  // insert, and update the rows that already exist.
  if (table === "jobs") {
    await insertOrUpdateRows(table, rows, onConflict);
    return;
  }
  // One POST per 500 rows: the whole-company upsert of 2,148
  // customers is a large body, and keeping requests modest avoids
  // gateway body limits.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await client()
      .from(table)
      .upsert(chunk, { onConflict });
    if (error) {
      throw new WriteError(table, error.code, error.message);
    }
  }
}

/**
 * Upsert without ON CONFLICT: insert in batches; when a batch hits rows
 * that already exist (23505), insert row by row and update each one
 * that exists instead. Same end result as an upsert.
 */
export async function insertOrUpdateRows(
  table: string,
  rows: Row[],
  keyCol: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await client().from(table).insert(chunk);
    if (!error) continue;
    if (error.code !== "23505") {
      throw new WriteError(table, error.code, error.message);
    }
    for (const row of chunk) {
      const { error: rowError } = await client().from(table).insert(row);
      if (!rowError) continue;
      if (rowError.code !== "23505") {
        throw new WriteError(table, rowError.code, rowError.message);
      }
      const { [keyCol]: key, ...patch } = row;
      const { data: updated, error: updateError } = await client()
        .from(table)
        .update(patch)
        .eq(keyCol, key as string)
        .eq("company_id", supabaseConfig.companyId)
        .select(keyCol);
      if (updateError) {
        throw new WriteError(table, updateError.code, updateError.message);
      }
      // The row exists but this login may not change it (an upsert
      // would have been refused the same way).
      if (!updated || updated.length === 0) {
        throw new WriteError(table, "42501", "");
      }
    }
  }
}

/**
 * Upsert rows; when the database refuses the batch because this login
 * may not write one of them, write them one at a time so every allowed
 * row still saves, and count the refused ones. (Postgres refuses a
 * whole statement for one bad row.) A large refused batch is a real
 * failure, not one stray row, so it is not split.
 */
async function upsertRowsAllowed(
  table: string,
  rows: Row[],
  onConflict: string,
  refused: Refused,
): Promise<void> {
  try {
    await upsertRows(table, rows, onConflict);
  } catch (e) {
    if (!isRefusal(e) || rows.length > 100) throw e;
    if (rows.length === 1) {
      noteRefused(refused, e.reason);
      return;
    }
    for (const row of rows) {
      try {
        await upsertRows(table, [row], onConflict);
      } catch (rowError) {
        if (!isRefusal(rowError)) throw rowError;
        noteRefused(refused, rowError.reason);
      }
    }
  }
}

/** Ids currently in the table, for prune (id-only, so the fetch stays small). */
async function fetchIds(table: string): Promise<string[]> {
  const pageSize = 1000;
  const all: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client()
      .from(table)
      .select("id")
      .eq("company_id", supabaseConfig.companyId)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`Supabase ${table} id read failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{ id: unknown }>;
    all.push(...rows.map((r) => String(r.id)));
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/**
 * Delete rows by id, in batches of 200, with the same pre-migration
 * tolerance as the upsert: a table that does not exist yet is
 * skipped, not failed. Returns false when skipped, so the caller
 * knows not to record the deletions as saved.
 *
 * Row-level security refuses a delete silently (no error, nothing
 * removed), so each batch asks which rows it removed. A row it did not
 * remove that this login can still read was refused and is counted in
 * `refused`; a row it cannot read is already gone (or was never
 * visible to this login), which is fine.
 */
async function deleteTableRows(
  table: string,
  ids: string[],
  refused: Refused = { count: 0, reasons: [] },
): Promise<boolean> {
  if (ids.length === 0) return true;
  const migration = MISSING_TABLE_MIGRATION[table];
  const run = async () => {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await client()
        .from(table)
        .delete()
        .eq("company_id", supabaseConfig.companyId)
        .in("id", chunk)
        .select("id");
      if (error) {
        if (error.code === "42501") {
          noteRefused(refused, error.message, chunk.length);
          continue;
        }
        throw new WriteError(table, error.code, error.message, "prune");
      }
      const removed = new Set((data ?? []).map((r) => String((r as Row).id)));
      const left = chunk.filter((id) => !removed.has(id));
      if (left.length === 0) continue;
      const { data: still, error: readError } = await client()
        .from(table)
        .select("id")
        .eq("company_id", supabaseConfig.companyId)
        .in("id", left);
      if (readError) {
        throw new WriteError(table, readError.code, readError.message, "prune");
      }
      if (still && still.length > 0) noteRefused(refused, "", still.length);
    }
  };
  if (migration) {
    try {
      await run();
      return true;
    } catch (e) {
      console.warn(`Could not prune ${table} — run migration ${migration}:`, e);
      return false;
    }
  }
  await run();
  return true;
}

async function pruneRows(table: string, keepIds: string[]): Promise<void> {
  // Delete-by-exclusion ("delete everything NOT IN this huge list")
  // builds a URL with one entry per kept row — with 2,148 customers
  // that URL is ~36 KB and the API gateway rejects it, which used to
  // abort the whole save before it ever reached the jobs table: a
  // dragged job showed moved until refresh, then snapped back to its
  // old day. Instead: read the ids that exist, delete exactly the
  // ones that are gone, in small batches. Most saves delete nothing,
  // so most saves make no prune request at all.
  const keep = new Set(keepIds.map(String));
  const existing = await fetchIds(table);
  const toDelete = existing.filter((id) => !keep.has(id));
  await deleteTableRows(table, toDelete);
}

function readCache(): AppState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppState) : null;
  } catch {
    return null;
  }
}

function writeCache(state: AppState): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // Cache loss is acceptable; the server copy is authoritative.
  }
}

function readDrafts(): DraftMap {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as DraftMap;
  } catch {
    return {};
  }
}

function emptyState(): AppState {
  return {
    customers: [],
    crew: [],
    jobs: [],
    estimates: [],
    invoices: [],
    timesheets: [],
    notes: [],
    threads: [],
    messages: [],
    auditLog: [],
    automations: defaultAutomations(),
    settings: {
      autoClock: false,
      dailyTarget: 0,
      suggestDays: true,
      suggestMaxMinutes: 30,
      suggestMaxMiles: 5,
      suggestMaxOver: 0,
      suggestSkipWeekends: true,
      suggestSkipHolidays: true,
      hoverRoute: true,
      showDayTotals: true,
      commercialTermsDays: 30,
      residentialTermsDays: 0,
      crewRules: null,
      company: null,
    },
    trees: [],
    equipment: [],
    maintenanceTasks: [],
    maintenanceRecords: [],
    equipmentNotes: [],
    phcPrograms: [],
    phcVisits: [],
    chemicalRecords: [],
    timeOff: [],
    closedDays: [],
    bookingRequests: [],
    dayCrews: [],
    unavailability: [],
    locationRequests: [],
    crewLocations: [],
    companyDocuments: [],
  };
}


/**
 * Upsert one table's rows, with the same pre-migration tolerance
 * saveOneTable has always had: settings retries with only the
 * original column, and tables that do not exist until a later
 * migration skip (and retry on a later save) instead of failing the
 * whole save. Returns false when the table was skipped (missing) or
 * the settings write failed outright, so the caller knows not to
 * record the rows as saved.
 */
async function upsertTableRows(
  table: string,
  rows: Row[],
  refused: Refused,
): Promise<boolean> {
  if (rows.length === 0) return true;
  if (table === "settings") {
    try {
      await upsertRows(table, rows, "company_id");
      return true;
    } catch (e) {
      if (isRefusal(e)) {
        noteRefused(refused, e.reason, rows.length);
        return true;
      }
      const legacy = rows.map((r) => ({
        company_id: r.company_id,
        auto_clock: r.auto_clock,
      }));
      try {
        await upsertRows(table, legacy, "company_id");
        return true;
      } catch (e) {
        console.warn(
          "Could not save settings — run migration 005_calendar_settings.sql:",
          e,
        );
        return false;
      }
    }
  }
  const migration = MISSING_TABLE_MIGRATION[table];
  if (migration) {
    try {
      await upsertRowsAllowed(table, rows, "id", refused);
      return true;
    } catch (e) {
      console.warn(`Could not save ${table} — run migration ${migration}:`, e);
      return false;
    }
  }
  await upsertRowsAllowed(table, rows, "id", refused);
  return true;
}

/** The column a table's rows are keyed by (settings: one row per company). */
function keyColumn(table: string): string {
  return table === "settings" ? "company_id" : "id";
}

/**
 * The columns of `next` that differ from `prev` — what an UPDATE of
 * an existing row needs to send. Sending only these (not the whole
 * row) means a status tap never rewrites fields another phone just
 * changed, and it lets row-level security allow field-limited edits
 * (crew may change only some columns of a job).
 */
function changedColumns(prev: Row, next: Row): Row {
  const patch: Row = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(v) !== JSON.stringify(prev[k])) patch[k] = v;
  }
  return patch;
}

/**
 * Update existing rows with only their changed columns. A row the
 * update could not reach (deleted on the server, or no longer visible
 * to this login) falls back to a full upsert, which either restores
 * it or fails with the database's reason. Returns false when the table
 * does not exist yet (pre-migration), like upsertTableRows.
 */
async function updateTableRows(
  table: string,
  changes: Array<{ key: string; patch: Row; row: Row }>,
  refused: Refused,
): Promise<boolean> {
  if (changes.length === 0) return true;
  const keyCol = keyColumn(table);
  const run = async () => {
    const missing: Row[] = [];
    for (let i = 0; i < changes.length; i += 10) {
      const chunk = changes.slice(i, i + 10);
      await Promise.all(
        chunk.map(async ({ key, patch, row }) => {
          const { data, error } = await client()
            .from(table)
            .update(patch)
            .eq(keyCol, key)
            .eq("company_id", supabaseConfig.companyId)
            .select(keyCol);
          if (error) {
            // A permission trigger (e.g. "Crew can only change the
            // status of a job.") refuses just this row.
            if (isRefusalCode(error.code)) {
              noteRefused(refused, error.message);
              return;
            }
            throw new WriteError(table, error.code, error.message);
          }
          if (!data || data.length === 0) missing.push(row);
        }),
      );
    }
    if (missing.length > 0) {
      await upsertRowsAllowed(table, missing, keyCol, refused);
    }
  };
  const migration = MISSING_TABLE_MIGRATION[table];
  if (migration) {
    try {
      await run();
      return true;
    } catch (e) {
      console.warn(`Could not save ${table} — run migration ${migration}:`, e);
      return false;
    }
  }
  await run();
  return true;
}

/**
 * Save one table whole: upsert its rows (no deletes). Throws on a core-table failure (the caller records which
 * table). This is the fallback for a table with no delta baseline
 * (first save after the adapter was created); the normal path is
 * saveTableDelta, which only sends what changed.
 */
async function saveOneTable(
  table: TableName,
  state: AppState,
  refused: Refused,
): Promise<void> {
  // This runs only when a table has no delta baseline, which the
  // load always sets — so it is a safety net, not the normal path.
  // It never deletes: a phone that lacks rows (a crew login sees only
  // some of them) must never prune the rest of the company's data.
  const rows = rowsFor(state, table);
  await upsertTableRows(table, rows, refused);
}


export class SupabaseAdapter implements DataAdapter {
  /**
   * Delta saves: for each table, the rows it held the last time it
   * was written (or loaded), as row key -> JSON fingerprint. A save
   * only sends the rows whose fingerprint changed, plus the rows that
   * disappeared (as deletes) — a job move is one request instead of
   * ~70, so it feels instant. The store never mutates state in place,
   * so a fingerprint taken at save/load time stays valid; a failed
   * table leaves its baseline untouched, so the next save retries it.
   */
  private lastSaved = new Map<TableName, Map<string, string>>();

  private noteSaved(table: TableName, state: AppState): void {
    const map = new Map<string, string>();
    for (const row of rowsFor(state, table)) {
      map.set(rowKey(row), rowFingerprint(row));
    }
    this.lastSaved.set(table, map);
  }

  private noteAllSaved(state: AppState): void {
    for (const table of TABLES) this.noteSaved(table, state);
  }

  /**
   * Save one table by delta: upsert only the rows that are new or
   * changed since the baseline, delete only the rows that are gone.
   * A table with no baseline yet (first save after the adapter was
   * created) falls back to the whole-table save, then records it.
   * Returns the rows the database refused (this login may not change
   * them); everything else in the table was written.
   */
  private async saveTableDelta(
    table: TableName,
    state: AppState,
    confirmAccess: () => Promise<boolean>,
  ): Promise<Refused> {
    const refused: Refused = { count: 0, reasons: [] };
    const baseline = this.lastSaved.get(table);
    if (!baseline) {
      await saveOneTable(table, state, refused);
      if (refused.count > 0 && !(await confirmAccess())) throw new NoAccessError();
      this.noteSaved(table, state);
      return refused;
    }
    const rows = rowsFor(state, table);
    const next = new Map<string, string>();
    const toInsert: Row[] = [];
    const toUpdate: Array<{ key: string; patch: Row; row: Row }> = [];
    for (const row of rows) {
      const key = rowKey(row);
      const fp = rowFingerprint(row);
      next.set(key, fp);
      const before = baseline.get(key);
      if (before === fp) continue;
      if (before === undefined) {
        toInsert.push(row);
      } else if (table !== "audit_log") {
        // An existing row changed: send only the changed columns.
        // (Audit entries never change once written.)
        const patch = changedColumns(JSON.parse(before) as Row, row);
        if (Object.keys(patch).length > 0) toUpdate.push({ key, patch, row });
      }
    }
    const toDelete: string[] = [];
    for (const key of baseline.keys()) {
      if (!next.has(key)) toDelete.push(key);
    }
    const wrote =
      (await upsertTableRows(table, toInsert, refused)) &&
      (await updateTableRows(table, toUpdate, refused));
    let pruned = true;
    // Never prune the audit log (append-only) or settings (one row).
    if (toDelete.length > 0 && table !== "audit_log" && table !== "settings") {
      pruned = await deleteTableRows(table, toDelete, refused);
    }
    // Only record the new baseline once the table saved fully; if it
    // was skipped (missing migration) the next save retries it. Rows
    // the database refused count as done: retrying cannot help, and
    // the app reloads the real data instead (see SaveResult.refused).
    // A refusal only counts once the session is known to have access;
    // otherwise nothing is recorded and the save is retried later.
    if (refused.count > 0 && !(await confirmAccess())) throw new NoAccessError();
    if (wrote && pruned) this.lastSaved.set(table, next);
    return refused;
  }

  async loadState(opts?: LoadOptions): Promise<AppState | null> {
    try {
      const [
        customers,
        crew,
        jobs,
        estimates,
        invoices,
        timesheets,
        notes,
        threads,
        messages,
        auditLog,
        automations,
        settings,
        trees,
        equipment,
        phcPrograms,
        phcVisits,
        chemicalRecords,
        // Pre-migration safety: this table does not exist until
        // migration 008 runs. A missing table reads as empty instead
        // of failing the whole load.
        timeOff,
        // Same pre-migration safety: these tables do not exist until
        // migration 012 runs.
        maintenanceTasks,
        maintenanceRecords,
        // Same pre-migration safety: these tables do not exist until
        // migration 013 runs.
        closedDays,
        bookingRequests,
        // Same pre-migration safety: this table does not exist until
        // migration 014 runs.
        equipmentNotes,
        // Same pre-migration safety: this table does not exist until
        // migration 018 runs.
        customerAddresses,
        // Same pre-migration safety: this table does not exist until
        // migration 021 runs.
        dayCrews,
        // Same pre-migration safety: these tables do not exist until
        // migration 022 runs.
        locationRequests,
        crewLocations,
        // Same pre-migration safety: this table does not exist until
        // migration 026 runs.
        unavailability,
        // Same pre-migration safety: this table does not exist until
        // the "customer edit requests" rules runs.
        customerEditRequests,
        // Staff only; crew read no rows. Missing before migration
        // the "company documents" rules runs.
        companyDocuments,
        // Staff: all; a Climber: his jobs'. Missing before migration
        // the "climber price change notes" rules runs.
        jobPriceChanges,
        // Staff: all; crew: their own. Missing before migration
        // the "equipment problems" rules runs.
        equipmentProblems,
      ] = await Promise.all([
        fetchRows("customers", "first_name"),
        fetchRows("crew"),
        fetchJobRows(),
        fetchRows("estimates"),
        fetchRows("invoices"),
        fetchRows("timesheets"),
        fetchRows("private_notes"),
        fetchRows("email_threads"),
        fetchRows("messages"),
        fetchRows("audit_log"),
        fetchRows("automations"),
        fetchRows("settings"),
        fetchRows("trees"),
        fetchRows("equipment"),
        fetchRows("phc_programs"),
        fetchRows("phc_visits"),
        fetchRows("chemical_records"),
        fetchRows("time_off_requests").catch(() => []),
        fetchRows("maintenance_tasks").catch(() => []),
        fetchRows("maintenance_records").catch(() => []),
        fetchRows("closed_days").catch(() => []),
        fetchRows("booking_requests").catch(() => []),
        fetchRows("equipment_notes").catch(() => []),
        fetchRows("customer_addresses").catch(() => []),
        fetchRows("day_crews").catch(() => []),
        fetchRows("location_requests").catch(() => []),
        fetchRows("crew_locations").catch(() => []),
        fetchRows("crew_unavailability").catch(() => []),
        fetchRows("customer_edit_requests", "created_at").catch(() => []),
        fetchRows("company_documents").catch(() => []),
        fetchRows("job_price_changes", "changed_at").catch(() => []),
        fetchRows("equipment_problems", "created_at").catch(() => []),
      ]);
      // Every read above returns no rows (not an error) to a session
      // without company access. Never take that for an empty company:
      // it would replace the screen and the offline copy.
      if (!(await sessionHasAccess())) {
        throw new NoAccessError();
      }
      // A crew login reads only its own full roster row (no one
      // else's pay, email or permissions). Everyone else comes from
      // crew_directory(): name, job role, colour, phone. Staff already
      // have every full row, so the directory adds nothing for them.
      const directory = await fetchCrewDirectory();
      // The whole calendar (calendar details only); [] when unavailable.
      const calendar = await fetchCalendarJobs();
      const crewIds = new Set(crew.map((r) => String(r.id)));
      for (const r of directory) {
        if (!crewIds.has(String(r.id))) crew.push(r);
      }
      // Group the address rows by customer before assembling state.
      const addressesByCustomer = new Map<string, CustomerAddress[]>();
      for (const r of customerAddresses) {
        const a = customerAddressFromRow(r);
        const list = addressesByCustomer.get(str(r.customer_id)) ?? [];
        list.push(a);
        addressesByCustomer.set(str(r.customer_id), list);
      }
      const state: AppState = {
        customers: customers.map((r) => ({
          ...customerFromRow(r),
          addresses: addressesByCustomer.get(str(r.id)) ?? [],
        })),
        crew: crew.map(crewFromRow),
        jobs: jobs.map(jobFromRow),
        estimates: estimates.map(estimateFromRow),
        invoices: invoices.map(invoiceFromRow),
        timesheets: timesheets.map(timesheetFromRow),
        notes: notes.map(noteFromRow),
        threads: threads.map(threadFromRow),
        messages: messages.map(messageFromRow),
        auditLog: auditLog.map(auditFromRow),
        automations: withNewRules(automations.map(automationFromRow)),
        settings:
          settings.length > 0
            ? {
                autoClock: settings[0].auto_clock === true,
                dailyTarget: Number(settings[0].daily_target ?? 0) || 0,
                suggestDays: settings[0].suggest_days !== false,
                suggestMaxMinutes:
                  settings[0].suggest_max_minutes == null
                    ? 30
                    : Number(settings[0].suggest_max_minutes),
                suggestMaxMiles:
                  settings[0].suggest_max_miles == null
                    ? 5
                    : Number(settings[0].suggest_max_miles),
                suggestMaxOver:
                  settings[0].suggest_max_over == null
                    ? 0
                    : Number(settings[0].suggest_max_over),
                suggestSkipWeekends:
                  settings[0].suggest_skip_weekends !== false,
                suggestSkipHolidays:
                  settings[0].suggest_skip_holidays !== false,
                hoverRoute: settings[0].hover_route !== false,
                showDayTotals: settings[0].show_day_totals !== false,
                commercialTermsDays:
                  settings[0].commercial_terms_days == null
                    ? 30
                    : Number(settings[0].commercial_terms_days),
                residentialTermsDays:
                  settings[0].residential_terms_days == null
                    ? 0
                    : Number(settings[0].residential_terms_days),
                crewRules:
                  (settings[0].crew_rules as AppSettings["crewRules"]) ?? null,
                planner:
                  (settings[0].planner as AppSettings["planner"]) ?? null,
                company:
                  (settings[0].company_profile as AppSettings["company"]) ??
                  null,
                autoEmails: settings[0].auto_emails === true,
                autoEmailsSince:
                  typeof settings[0].auto_emails_since === "string"
                    ? settings[0].auto_emails_since
                    : null,
              }
            : {
                autoClock: false,
                dailyTarget: 0,
                suggestDays: true,
                hoverRoute: true,
                showDayTotals: true,
                commercialTermsDays: 30,
                residentialTermsDays: 0,
                crewRules: null,
                company: null,
              },
        trees: trees.map(treeFromRow),
        equipment: equipment.map(equipmentFromRow),
        maintenanceTasks: maintenanceTasks.map(maintenanceTaskFromRow),
        maintenanceRecords: maintenanceRecords.map(maintenanceRecordFromRow),
        phcPrograms: phcPrograms.map(phcProgramFromRow),
        phcVisits: phcVisits.map(phcVisitFromRow),
        chemicalRecords: chemicalRecords.map(chemicalRecordFromRow),
        timeOff: timeOff.map(timeOffFromRow),
        closedDays: closedDays.map(closedDayFromRow),
        equipmentNotes: equipmentNotes.map(equipmentNoteFromRow),
        bookingRequests: bookingRequests.map(bookingRequestFromRow),
        dayCrews: dayCrews.map(dayCrewFromRow),
        locationRequests: locationRequests.map(locationRequestFromRow),
        crewLocations: crewLocations.map(crewLocationFromRow),
        unavailability: unavailability.map(unavailabilityFromRow),
        customerEditRequests: customerEditRequests.map(customerEditRequestFromRow),
        companyDocuments: companyDocuments.map(companyDocumentFromRow),
        jobPriceChanges: jobPriceChanges.map(jobPriceChangeFromRow),
        equipmentProblems: equipmentProblems.map(equipmentProblemFromRow),
        // Calendar-only entries for jobs not readable in full.
        calendarJobs: calendar.filter((c) => !jobs.some((j) => String(j.id) === c.id)),
      };
      writeCache(state);
      // The loaded state is the baseline the next save diffs against,
      // unless the app throws this copy away (one of its own changes is
      // still queued and was built on the older copy).
      if (!opts?.discard?.()) this.noteAllSaved(state);
      return state;
    } catch (e) {
      // Offline or unreachable, or no access right now: fall back to the
      // last good server state rather than showing an empty company.
      // Only when there is no cache at all does the error propagate (the
      // app shows it instead of risking a wipe on the next save).
      const cached = readCache();
      if (cached) {
        if (!opts?.discard?.()) this.noteAllSaved(cached);
        return cached;
      }
      if (e instanceof NoAccessError) throw e;
      throw new Error(
        "Supabase is unreachable and no cached state exists. Check the connection and reload.",
      );
    }
  }

  async saveState(state: AppState): Promise<SaveResult> {
    // Each table's delta save runs in parallel, 5 at a time. A
    // typical change (move a job, assign crew) touches one or two
    // rows, so the whole save is one or two requests instead of the
    // old ~70 (one per table, whole-company) — that is what makes it
    // feel instant. Tables are independent (the only cross-table rule
    // is customer_addresses rows referencing customers, which the FK
    // handles with ON DELETE CASCADE), so parallel is safe. A failure
    // in one table no longer blocks the others, and the result names
    // the first table that failed so the app can show it.
    const queue: TableName[] = [...TABLES];
    const results: SaveResult[] = [];
    const refusals: SaveRefusal[] = [];
    // Asked at most once per save, and only when something was refused.
    // The sign-in must also be the same one the writes went out with: a
    // refresh in between (writes sent without a valid sign-in, check
    // sent with the new one) means "try again", not "refused".
    const tokenAtStart = await currentAccessToken();
    let access: Promise<boolean> | null = null;
    const confirmAccess = () =>
      (access ??= (async () =>
        tokenAtStart !== null &&
        (await sessionHasAccess()) &&
        (await currentAccessToken()) === tokenAtStart)());
    let noAccess = false;
    const workers = Array.from({ length: 5 }, async () => {
      for (;;) {
        const table = queue.shift();
        if (!table) return;
        try {
          const refused = await this.saveTableDelta(table, state, confirmAccess);
          if (refused.count > 0) {
            refusals.push({ table, count: refused.count, reasons: refused.reasons });
          }
          results.push({ ok: true });
        } catch (e) {
          if (e instanceof NoAccessError) noAccess = true;
          const raw = e instanceof Error ? e.message : String(e);
          results.push({
            ok: false,
            failedTable: table,
            message: /abort/i.test(raw)
              ? "Request timed out after 15s — the database didn't answer. Retry usually works."
              : raw,
          });
        }
      }
    });
    await Promise.all(workers);
    if (noAccess) {
      console.warn("Save waiting: this session has no company access right now.");
      return { ok: false, noAccess: true, message: new NoAccessError().message };
    }
    const refused = refusals.length > 0 ? refusals : undefined;
    if (refused) console.warn("The database refused some changes:", refused);
    const failed = results.find((r) => !r.ok);
    if (failed) {
      console.warn("Could not save state:", failed);
      return { ...failed, refused };
    }
    // The cache is the last good server state. A save the database
    // partly refused is not that; the app reloads the real data.
    if (!refused) writeCache(state);
    return { ok: true, refused };
  }

  async loadDraft(key: string): Promise<unknown | undefined> {
    return readDrafts()[key];
  }

  async saveDraft(key: string, value: unknown): Promise<void> {
    try {
      const drafts = readDrafts();
      drafts[key] = value;
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Draft loss is acceptable; the saved record is unaffected.
    }
  }

  async clearDraft(key: string): Promise<void> {
    try {
      const drafts = readDrafts();
      delete drafts[key];
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Ignore.
    }
  }

  async listDrafts(): Promise<DraftMap> {
    return readDrafts();
  }

  /**
   * Deliberate deviation from the mock adapter: reset() clears this
   * company's rows and returns an EMPTY state, never the fictional seed.
   * Seed data must be removed, not migrated, into the real backend —
   * the Breezeworks import is what fills a real company.
   */
  async reset(): Promise<AppState> {
    for (const table of TABLES) {
      await pruneRows(table, []);
    }
    // The company is empty now; drop the delta baselines so the next
    // save falls back to a whole-table write.
    this.lastSaved.clear();
    const state = emptyState();
    writeCache(state);
    try {
      localStorage.removeItem(DRAFTS_KEY);
    } catch {
      // Ignore.
    }
    return state;
  }
}
