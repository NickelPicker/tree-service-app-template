// businessSettings.ts — settings that depend on where the business is.
// Shared by the app (src/businessSettings.ts re-exports it) and the edge
// functions, so both use exactly the same values.
//
// Pure code: no Deno or browser globals.

/**
 * The business's time zone (an IANA name such as "America/Chicago" or
 * "America/Los_Angeles"). Used for clock-in times, "today" for
 * overdue invoices, and the hours automatic emails may go out.
 *
 * The template ships with America/Denver (Colorado) as an EXAMPLE.
 * To change it:
 *   1. change the value below, and
 *   2. add a new database migration that changes
 *      public.business_time_zone() to the same value (see the header of
 *      supabase/migrations/20260101000000_baseline.sql).
 * The test src/__tests__/businessSettings.test.ts checks they match.
 */
export const BUSINESS_TIME_ZONE = "America/Denver";
