/**
 * Settings that depend on where the business is. Change them here (and
 * read the README section "Your location: time zone and overtime").
 */
export { BUSINESS_TIME_ZONE } from "../supabase/functions/_shared/businessSettings.ts";

/**
 * Which overtime rule Weekly pay uses.
 *
 * - "colorado": Colorado's rule (COMPS Order #40), the EXAMPLE this
 *   template ships with: 1.5x for hours over 40 in the week, over 12 in
 *   a workday, or over 12 in a row, whichever pays more (src/overtime.ts).
 * - "weekly40": the federal (FLSA) rule only: 1.5x for hours over 40 in
 *   the week. Many states use just this; some (e.g. California, Alaska,
 *   Nevada) have daily rules too: check your state's labor department
 *   before you rely on Weekly pay.
 *
 * Weekly pay is a helper, not payroll advice.
 */
export type OvertimeRules = "colorado" | "weekly40";
export const OVERTIME_RULES: OvertimeRules = "colorado";
