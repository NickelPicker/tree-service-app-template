/**
 * When the office calls an unpaid invoice "overdue" (business rule: "overdue = anything unpaid 10 business days past its due
 * date"). Business days are Monday to Friday; there is no holiday list.
 * Dates are calendar dates in the business's time zone (BUSINESS_TIME_ZONE) ('YYYY-MM-DD').
 *
 * The rule itself lives in supabase/functions/_shared/businessDays.ts so
 * the automatic past-due email (run-automations) waits for exactly the
 * same day (business rule: the email also waits 10 business days).
 */
import { clockNow } from "./clockTime";

export {
  OVERDUE_BUSINESS_DAYS,
  addBusinessDays,
  businessDaysAfter,
  firstOverdueDay,
  isPastDueForOffice,
} from "../supabase/functions/_shared/businessDays.ts";

/** Today's date in the business's time zone (the company's calendar day). */
export function businessToday(now: Date = new Date()): string {
  return clockNow(now).date;
}
