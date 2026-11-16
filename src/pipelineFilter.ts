/**
 * New-year-only filter for the Sales pipeline (see Pipeline.tsx).
 *
 * The pipeline restarts from the new year: it shows only work that
 * was created in the app, or is dated on/after NEW_YEAR_START.
 * Imported Breezeworks records (ids starting with "bw-") only count
 * when their own date is on/after the start — a record dated before
 * that never shows, and it can never drag its customer or job into a
 * column via a link, because every column is derived from the
 * filtered sets. Nothing is deleted: the board has no data of its
 * own; this is only a filter on what it shows.
 *
 * Dates are YYYY-MM-DD strings, so a plain string comparison is a
 * date comparison. Customers carry no added date, so only
 * app-created customers can be Leads.
 */
export const NEW_YEAR_START = "2027-01-01";

/** Whether one record counts as new-year work. */
export function isNewYearRecord(
  id: string,
  date?: string | null,
): boolean {
  if (!id.startsWith("bw-")) return true;
  return !!date && date >= NEW_YEAR_START;
}
