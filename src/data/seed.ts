import type { AppState, AutomationRule } from "../types";

/**
 * Seed data for a FRESH copy of the app — deliberately EMPTY.
 *
 * This template ships with no business information at all: no crew,
 * no customers, no jobs, no estimates, no invoices, no equipment.
 * The first time the app opens it shows the setup wizard instead of
 * a dashboard, and the wizard asks for the business name, contact
 * details, shop/yard addresses, and the owner login before anything
 * can be used. Crew and equipment are then added inside the app.
 *
 * The automation templates below are the only pre-filled content:
 * generic reminder wordings with no business name in them.
 */

export function defaultAutomations(): AutomationRule[] {
  return [
    {
      id: "auto-invoice-send",
      kind: "invoice_send",
      label: "Auto-send invoices",
      description: "When a job is marked Done, its invoice is made from the accepted estimate and emailed 2 hours later (time to undo a mistaken Done). Jobs that need a look go to \u201cNeeds invoice review\u201d on the Dashboard instead.",
      enabled: false,
      timingDays: 0,
      template: "Hi {customer}, thank you for choosing us! Your invoice {title} for {amount} is below. It is due {date}.",
    },
    {
      id: "auto-invoice-reminder",
      kind: "invoice_reminder",
      label: "Invoice reminders",
      description: "Remind customers with unpaid invoices, starting this many days after the invoice is issued.",
      enabled: true,
      timingDays: 7,
      template: "Hi {customer}, a friendly reminder that invoice {title} for {amount} is still open. Reply to this email if you have any questions — it stays in our same conversation.",
    },
    {
      id: "auto-review-request",
      kind: "review_request",
      label: "Please review us",
      description: "Not automatic: reviews are asked from the invoice email, when the sender ticks \u201cAsk for a review in this email\u201d.",
      enabled: false,
      timingDays: 3,
      template: "Hi {customer}, thanks for having us out! If you were happy with the work, would you leave us a quick review? It helps more than you know.",
    },
    {
      id: "auto-estimate-reminder",
      kind: "estimate_reminder",
      label: "Estimate reminders (not approved)",
      description: "Follow up on estimates that were sent but not yet approved, this many days after sending.",
      enabled: true,
      timingDays: 5,
      template: "Hi {customer}, just checking in on your estimate for {title} ({amount}). Happy to answer questions or adjust anything — reply here and it stays in our same conversation.",
    },
    {
      id: "auto-thank-you",
      kind: "thank_you",
      label: "Thank-you after payment",
      description: "Send a thank-you note this many days after an invoice is paid.",
      enabled: false,
      timingDays: 1,
      template: "Hi {customer}, thank you for your payment of {amount}. We appreciate your business!",
    },
    {
      id: "auto-job-reminder",
      kind: "job_reminder",
      label: "Day-before job reminder",
      description: "Remind the customer the day before a scheduled job. Timing is days before the job date.",
      enabled: false,
      timingDays: 1,
      template: "Hi {customer}, a quick heads-up: our crew is scheduled for {title} on {date}. Please keep the gate accessible and pets inside. Reply here with any questions.",
    },
    {
      id: "auto-overdue-escalation",
      kind: "overdue_escalation",
      label: "Overdue escalation",
      description: "A firmer follow-up for invoices still unpaid once overdue (10 business days past their due date) and at least this many days past it.",
      enabled: false,
      timingDays: 14,
      template: "Hi {customer}, invoice {title} for {amount} is now past due. Please arrange payment or reply here so we can sort it out.",
    },
    {
      id: "auto-phc-renewal",
      kind: "phc_renewal",
      label: "PHC program renewals",
      description: "Remind customers whose plant health care program renews within this many days — the renewal estimate goes out before the season starts.",
      enabled: true,
      timingDays: 30,
      template: "Hi {customer}, your plant health care program ({title}) renews on {date}. Reply here and we'll schedule the first visit of the new season.",
    },
  ];
}

/**
 * The starting state for a fresh copy: every collection empty, the
 * company profile unset (which is what makes the setup wizard
 * appear on first open).
 */
export function seedState(): AppState {
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
