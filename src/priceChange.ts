/**
 * A job's price as a Climber changes it (the "invoice email by hand" rules;
 * business rule: "Climbers can see the job's current price and
 * what it will change to if they change it ... If they change a price
 * they need to leave a note on the same page of why it was changed").
 *
 * The price is the job's own billing (flat or hourly), job value and
 * hourly rate. The costs (labor rate, materials, other costs) are not
 * part of it. A Climber changes it through change_job_price, which
 * needs a reason; these helpers are the text the price box shows.
 */
import type { Job, JobPriceChange } from "./types";
import { money } from "./utils";
import { priceReplaced } from "./jobValue";

export interface JobPrice {
  /** null = never set (shown and billed as flat). */
  billingType: "flat" | "hourly" | null;
  value: number | null;
  hourlyRate: number | null;
}

/** Shortest and longest reason the database accepts. */
export const REASON_MIN = 3;
export const REASON_MAX = 1000;

/** Billing as it is shown and billed: unset is flat. */
function billing(p: JobPrice): "flat" | "hourly" {
  return p.billingType === "hourly" ? "hourly" : "flat";
}

/** The job's price fields. */
export function priceOf(job: Pick<Job, "billingType" | "value" | "hourlyRate">): JobPrice {
  return {
    billingType: job.billingType === "hourly" ? "hourly" : job.billingType === "flat" ? "flat" : null,
    value: job.value ?? null,
    hourlyRate: job.hourlyRate ?? null,
  };
}

/** True when the two prices differ in billing, value or hourly rate. */
export function priceChanged(a: JobPrice, b: JobPrice): boolean {
  return billing(a) !== billing(b) || a.value !== b.value || a.hourlyRate !== b.hourlyRate;
}

/** Is this reason long enough to send (trimmed, 3 to 1000 characters)? */
export function reasonOk(reason: string): boolean {
  const n = reason.trim().length;
  return n >= REASON_MIN && n <= REASON_MAX;
}

/**
 * The job total a price stands for: the value of a flat job; rate ×
 * hours for an hourly one (null without both).
 */
export function priceTotal(p: JobPrice, hours: number | null | undefined): number | null {
  if (billing(p) === "hourly") {
    return p.hourlyRate != null && hours != null && hours > 0 ? p.hourlyRate * hours : null;
  }
  return p.value;
}

/** "$900", "$90/hr (≈ $720 for 8h)", "$90/hr", or "not set". */
export function priceText(p: JobPrice, hours: number | null | undefined): string {
  if (billing(p) === "hourly") {
    if (p.hourlyRate == null) return "not set";
    const total = priceTotal(p, hours);
    return total != null
      ? `${money(p.hourlyRate)}/hr (≈ ${money(total)} for ${hours}h)`
      : `${money(p.hourlyRate)}/hr`;
  }
  return p.value != null ? money(p.value) : "not set";
}

/** "+$200", "−$50.50" (a real minus sign), or "no change". */
export function diffText(delta: number): string {
  if (Math.abs(delta) < 0.005) return "no change";
  return `${delta > 0 ? "+" : "−"}${money(Math.abs(delta))}`;
}

/**
 * How much the price moves: by the job total when both have one, else
 * by the hourly rate when both are hourly ("/hr"), else null (e.g. from
 * flat to hourly without hours).
 */
export function priceDelta(
  from: JobPrice,
  to: JobPrice,
  hours: number | null | undefined,
): string | null {
  const a = priceTotal(from, hours);
  const b = priceTotal(to, hours);
  if (a != null && b != null) return diffText(b - a);
  if (billing(from) === "hourly" && billing(to) === "hourly" && from.hourlyRate != null && to.hourlyRate != null) {
    const d = diffText(to.hourlyRate - from.hourlyRate);
    return d === "no change" ? d : `${d}/hr`;
  }
  return null;
}

/** The lines the price box shows: current, and (once changed) new with the difference. */
export function priceBoxLines(
  current: JobPrice,
  draft: JobPrice,
  hours: number | null | undefined,
  /**
   * The job's price as it is shown when it does not come from the job's
   * own fields (a flat job priced by its estimate), else null.
   */
  shown: number | null = null,
): { current: string; next: string | null } {
  const fromEstimate = shown !== null && billing(current) === "flat";
  const cur = `Current price: ${fromEstimate ? money(shown) : priceText(current, hours)}`;
  if (!priceChanged(current, draft)) return { current: cur, next: null };
  const base: JobPrice = fromEstimate ? { ...current, value: shown } : current;
  const delta = priceDelta(base, draft, hours);
  return {
    current: cur,
    next: `New price: ${priceText(draft, hours)}${delta ? ` (${delta})` : ""}`,
  };
}

/** "$900 → $1,100" for a logged change. */
export function changeSummary(c: JobPriceChange, hours: number | null | undefined): string {
  const from: JobPrice = {
    billingType: c.oldBillingType === "hourly" ? "hourly" : null,
    value: c.oldValue,
    hourlyRate: c.oldHourlyRate,
  };
  const to: JobPrice = {
    billingType: c.newBillingType === "hourly" ? "hourly" : null,
    value: c.newValue,
    hourlyRate: c.newHourlyRate,
  };
  return `${priceText(from, hours)} → ${priceText(to, hours)}`;
}

/** A job's logged price changes, newest first. */
export function changesFor(list: JobPriceChange[] | undefined, jobId: string): JobPriceChange[] {
  return (list ?? []).filter((c) => c.jobId === jobId).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

/**
 * A job's price changes made by Climbers (not the office's own edits:
 * business rule), newest first: the job's "Price changes" list.
 */
export function crewChangesFor(list: JobPriceChange[] | undefined, jobId: string): JobPriceChange[] {
  return changesFor(list, jobId).filter((c) => !c.byOffice);
}

/** Crew price changes the office has not marked seen yet, newest first. */
export function unseenCrewChanges(list: JobPriceChange[] | undefined): JobPriceChange[] {
  return (list ?? []).filter((c) => !c.byOffice && !c.seenAt).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

/**
 * The new price text for a Climber's price list when a Climber changed
 * the job's price (the estimate's prices are then struck through), else
 * null.
 */
export function climberNewPrice(job: Job): string | null {
  return priceReplaced(job) ? priceText(priceOf(job), job.estimatedHours) : null;
}
