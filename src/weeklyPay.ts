import {
  entryMinutes,
  fixedHoursOvertime,
  OVERTIME_RULE_TEXT,
  type OvertimeRule,
  weekOvertime,
} from "./overtime";
import { percentPay, type PercentPay } from "./percentPay";
import type { CrewMember, Invoice, Job, TimesheetEntry } from "./types";
import { addDaysISO, isOpenEntry, todayStr } from "./utils";

/**
 * The owner's weekly pay view on Timesheets: hours and pay per person
 * for one week (Monday to Sunday), with Colorado overtime, and a CSV
 * for payroll.
 *
 * Straight pay: hourly people get rate × hours, day-rate people get
 * rate × days worked, percent people get their % of each job whose
 * invoice was paid this week (src/percentPay.ts).
 *
 * Overtime (src/overtime.ts, COMPS Order #40): hours over 40 in the
 * week, over 12 in a day or over 12 in a row, whichever is more. The
 * regular rate is all straight pay for the week ÷ hours worked; the
 * overtime premium is half the regular rate for each overtime hour (the
 * straight time for those hours is already in the straight pay).
 *
 * People paid fixed weekly hours (e.g. Sam, 32) get overtime too
 * (business rule): their fixed hours are the week's hours, so only
 * hours over 40 are overtime (src/overtime.ts fixedHoursOvertime); at 32
 * there is none. No overtime for 1099 contractors (overtime law covers
 * employees).
 */
export const OVERTIME_AFTER_HOURS = 40;

export type NoOvertimeReason = "contractor";

export interface PayRow {
  crewId: string;
  name: string;
  role: string;
  hours: number;
  days: number;
  /** Hours at the regular rate only (hours − overtime hours). */
  regularHours: number;
  overtimeHours: number;
  /** Which overtime rule applied (empty = none). */
  overtimeRules: OvertimeRule[];
  /** Why this person gets no overtime, or null. */
  noOvertime: NoOvertimeReason | null;
  /** Hours are the person's fixed weekly hours, not clocked time. */
  fixedHours: boolean;
  /** Entries still clocked in (no clock-out yet): their hours count as 0. */
  openEntries: number;
  payType: CrewMember["payType"];
  rate: number | null;
  /** Straight pay, or null when it cannot be worked out here. */
  pay: number | null;
  /** Straight pay ÷ hours (the overtime regular rate), or null. */
  regularRate: number | null;
  /** Extra half-time for overtime hours, or null when pay is unknown. */
  overtimePremium: number | null;
  /** Straight pay + overtime premium, or null when pay is unknown. */
  total: number | null;
  /** Percent-of-job pay detail (percent people only). */
  percent: PercentPay | null;
  /**
   * Overtime hours but no pay this week (a percent-paid employee whose
   * jobs' invoices were not paid this week): the overtime premium shows
   * $0, so the office must check this row by hand. How overtime works
   * for percent pay is an open owner question.
   */
  overtimeUnpaid: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The fixed weekly hours that count for this person in this week, or
 * null. Only for people on the team now (not pending or removed), and
 * only for a week that has started: a future week reached with "Next"
 * pays nobody yet. (The app keeps no start date, so a week before the
 * person joined is not detected; their status is the guard.)
 */
export function fixedHoursFor(c: CrewMember, week: string[], today: string = todayStr()): number | null {
  if (typeof c.fixedWeeklyHours !== "number" || !(c.fixedWeeklyHours >= 0)) return null;
  if (c.status === "revoked" || c.status === "pending") return null;
  const first = [...week].sort()[0];
  if (!first || first > today) return null;
  return c.fixedWeeklyHours;
}

/** Jobs and invoices, for percent-of-job pay. Without them percent pay shows no amount. */
export interface PayWork {
  jobs: Job[];
  invoices: Invoice[];
}

export function weeklyPayRows(
  crew: CrewMember[],
  timesheets: TimesheetEntry[],
  week: string[],
  today: string = todayStr(),
  work?: PayWork,
): PayRow[] {
  const days = new Set(week);
  // The day before the week: a Sunday night shift running into Monday
  // counts toward Monday's 12-hour day (paid in its own week).
  const first = [...week].sort()[0];
  const dayBefore = first ? addDaysISO(first, -1) : null;
  const rows: PayRow[] = [];
  for (const c of crew) {
    const mine = timesheets.filter((t) => t.crewId === c.id && days.has(t.date));
    // Paid a fixed number of hours a week (e.g. Sam: 32): that is the pay
    // basis whatever was clocked, while they are on the team. Someone
    // removed still shows the hours they really clocked that week.
    const fixed = fixedHoursFor(c, week, today);
    const payType = c.payType ?? null;
    const pct =
      payType === "percent" && work ? percentPay(c, timesheets, work.jobs, work.invoices, week) : null;
    if (mine.length === 0 && fixed === null && !(pct && pct.paid.length > 0)) continue;
    const prior = timesheets.filter((t) => t.crewId === c.id && t.date === dayBefore);
    // Fixed-hours people: the fixed hours are the week's hours, for pay
    // and for overtime (over 40 in the week).
    const ot = fixed !== null ? fixedHoursOvertime(fixed) : weekOvertime(mine, week, prior);
    const contractor = c.employmentType === "1099";
    const noOvertime: NoOvertimeReason | null = contractor ? "contractor" : null;
    const hours = fixed ?? ot.hours;
    const overtimeHours = noOvertime ? 0 : ot.overtimeHours;
    const worked = new Set(mine.filter((t) => entryMinutes(t) > 0).map((t) => t.date)).size;
    const rate = typeof c.payAmount === "number" && c.payAmount > 0 ? c.payAmount : null;
    let pay: number | null = null;
    if (rate !== null && payType === "hourly") pay = round2(rate * hours);
    if (rate !== null && payType === "day") pay = round2(rate * worked);
    if (rate !== null && payType === "percent" && pct) pay = pct.total;
    const regularRate = pay !== null && hours > 0 ? pay / hours : null;
    const overtimePremium =
      pay === null ? null : regularRate === null ? 0 : round2(0.5 * regularRate * overtimeHours);
    rows.push({
      crewId: c.id,
      name: c.name,
      role: c.role,
      hours,
      days: worked,
      regularHours: round2(hours - overtimeHours),
      overtimeHours,
      overtimeRules: noOvertime ? [] : ot.rules,
      noOvertime,
      fixedHours: fixed !== null,
      openEntries: mine.filter(isOpenEntry).length,
      payType,
      rate,
      pay,
      regularRate: regularRate === null ? null : round2(regularRate),
      overtimePremium,
      total: pay === null ? null : round2(pay + (overtimePremium ?? 0)),
      percent: pct,
      overtimeUnpaid: overtimeHours > 0 && pay !== null && pay <= 0,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface WeekTotals {
  hours: number;
  overtimeHours: number;
  /** Straight pay. */
  pay: number;
  overtimePremium: number;
  total: number;
}

export function weekTotals(rows: PayRow[]): WeekTotals {
  const sum = (f: (r: PayRow) => number) => round2(rows.reduce((s, r) => s + f(r), 0));
  return {
    hours: sum((r) => r.hours),
    overtimeHours: sum((r) => r.overtimeHours),
    pay: sum((r) => r.pay ?? 0),
    overtimePremium: sum((r) => r.overtimePremium ?? 0),
    total: sum((r) => r.total ?? 0),
  };
}

export function payTypeWord(t: PayRow["payType"]): string {
  return t === "hourly" ? "Hourly" : t === "day" ? "Day rate" : t === "percent" ? "Percent of job" : "Not set";
}

/** Plain words for the overtime rule(s), or why there is none. */
export function overtimeRuleText(r: Pick<PayRow, "overtimeRules" | "noOvertime">): string {
  if (r.noOvertime === "contractor") return "No overtime: 1099 contractor";
  return r.overtimeRules.map((k) => OVERTIME_RULE_TEXT[k]).join(" and ");
}

function csvCell(v: string | number): string {
  const s = String(v);
  // Quote anything with a comma, quote or newline; stop spreadsheet
  // formulas in names (=, +, -, @ at the start, or after a tab).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const n2 = (n: number | null) => (n === null ? "" : n.toFixed(2));

/** Payroll CSV: names, roles, hours and pay only (no contact details). */
export function payrollCsv(rows: PayRow[], weekStart: string, weekEnd: string): string {
  const head = [
    "Week start",
    "Week end",
    "Name",
    "Job role",
    "Days worked",
    "Total hours",
    "Regular hours",
    "Overtime hours",
    "Overtime rule",
    "Pay type",
    "Rate",
    "Regular rate",
    "Straight pay",
    "Overtime premium (half time)",
    "Total pay",
    "Percent jobs paid this week",
    "Still clocked in",
  ];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        weekStart,
        weekEnd,
        r.name,
        r.role,
        r.days,
        r.hours.toFixed(2),
        r.regularHours.toFixed(2),
        r.overtimeHours.toFixed(2),
        overtimeRuleText(r),
        payTypeWord(r.payType),
        n2(r.rate),
        n2(r.regularRate),
        n2(r.pay),
        n2(r.overtimePremium),
        n2(r.total),
        (r.percent?.paid ?? []).map((j) => `${j.title} (${n2(j.amount)})`).join("; "),
        r.openEntries > 0 ? "yes" : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const t = weekTotals(rows);
  lines.push(
    [
      "", "", "Total", "", "",
      t.hours.toFixed(2), round2(t.hours - t.overtimeHours).toFixed(2), t.overtimeHours.toFixed(2),
      "", "", "", "",
      t.pay.toFixed(2), t.overtimePremium.toFixed(2), t.total.toFixed(2), "", "",
    ]
      .map(csvCell)
      .join(","),
  );
  return lines.join("\r\n") + "\r\n";
}

/** Has anything changed since the week was approved? */
export function changedSinceApproval(approvedHours: number, nowHours: number): boolean {
  return Math.abs(approvedHours - nowHours) >= 0.01;
}
