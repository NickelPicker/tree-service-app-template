// businessDays.ts — when an unpaid invoice counts as "overdue", shared by
// the app (src/overdueInvoice.ts: To-do, Invoices page) and the hourly
// run-automations function (the automatic past-due email), so both use
// exactly the same rule.
//
// Business rule: "overdue = anything unpaid 10 business days past
// its due date", and the automatic past-due email also waits for that.
// Business days are Monday to Friday; there is no holiday list. Dates
// are calendar dates in the business's time zone (BUSINESS_TIME_ZONE) ('YYYY-MM-DD').
//
// Pure code: no Deno or browser globals.

export const OVERDUE_BUSINESS_DAYS = 10;

const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const parse = (iso: string) => (DAY_RE.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : NaN);
const isWeekday = (t: number) => {
  const w = new Date(t).getUTCDay();
  return w !== 0 && w !== 6;
};

/**
 * Business days (Mon–Fri) after `from`, up to and including `to`.
 * 0 when `to` is on or before `from`, or a date is not valid.
 */
export function businessDaysAfter(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  let n = 0;
  for (let t = a + DAY_MS; t <= b; t += DAY_MS) if (isWeekday(t)) n++;
  return n;
}

/**
 * The date that is `n` business days after `from` ("" when `from` is
 * not a valid date). n <= 0 gives `from` itself.
 */
export function addBusinessDays(from: string, n: number): string {
  let t = parse(from);
  if (Number.isNaN(t)) return "";
  for (let left = Math.floor(n); left > 0; ) {
    t += DAY_MS;
    if (isWeekday(t)) left--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** The first day an invoice due on `dueDate` counts as overdue. */
export function firstOverdueDay(dueDate: string): string {
  return addBusinessDays(dueDate, OVERDUE_BUSINESS_DAYS);
}

/**
 * True when `today` is at least 10 business days after the due date.
 * Due Monday 2 Nov: not yet on Friday 13 Nov (9), overdue on Monday
 * 16 Nov (10). No due date = never overdue by date.
 */
export function isPastDueForOffice(dueDate: string | null | undefined, today: string): boolean {
  if (!dueDate) return false;
  return businessDaysAfter(dueDate, today) >= OVERDUE_BUSINESS_DAYS;
}
