import type { AppState, CrewMember, Estimate, Invoice, Job } from "./types";
import { estimateActiveTotals, estimateTotals } from "./email";
import { entryMinutes } from "./overtime";
import { daysBetweenISO, money, nextBusinessDay } from "./utils";

/**
 * Job costing: estimated cost vs actual, and profit.
 * Estimated = the job's value by the shared rule (invoice → estimate →
 * manual value). Actual = labor + materials + other direct costs.
 * Labor is priced per person, by how that person is paid:
 * - hourly: timesheet hours × their $/hr rate (clock-in to clock-out
 *   for live-clocked time, as pay and invoices count it);
 * - day: distinct days worked on the job × their $/day rate;
 * - percent: their % of the job's value before tax, as payroll pays it
 *   (only on jobs where they logged time — no time logged, no cut).
 * Anyone without a pay setup falls back to the job's labor rate
 * (default $75/hr). laborRate is the blended rate actually paid across
 * the crew on this job (the job's rate while nobody has logged hours
 * yet); laborByPerson breaks it down person by person.
 * Profit = the value before tax − actual (sales tax is not income).
 * Nulls when there is no estimated value.
 */
export function jobCosting(
  state: AppState,
  job: Job,
): {
  estimated: number | null;
  /** The value before sales tax (what profit is worked out from). */
  beforeTax: number | null;
  laborHours: number;
  laborRate: number;
  laborCost: number;
  laborByPerson: Array<{
    crewId: string;
    name: string;
    hours: number;
    basis: "hourly" | "day" | "percent";
    cost: number;
    detail: string;
  }>;
  materials: number;
  other: number;
  actual: number;
  profit: number | null;
} {
  const estimated = jobValue(state, job);
  const preTax = jobValueBeforeTax(state, job);
  const fallbackRate = job.laborRate ?? 75;
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const byPerson = new Map<string, { hours: number; days: Set<string> }>();
  for (const t of state.timesheets) {
    if (t.jobId !== job.id) continue;
    const entry = byPerson.get(t.crewId) ?? { hours: 0, days: new Set<string>() };
    // Live clock-in/out saves no hours: count the clocked time.
    entry.hours += entryMinutes(t) / 60;
    entry.days.add(t.date);
    byPerson.set(t.crewId, entry);
  }
  const laborByPerson = [...byPerson.entries()]
    .map(([crewId, { hours: rawHours, days }]) => {
      const hours = Math.round(rawHours * 100) / 100;
      const member = state.crew.find((c) => c.id === crewId);
      const name = member?.name ?? "Former crew";
      const amount = member?.payAmount ?? null;
      if (member?.payType === "day") {
        const rate = amount ?? fallbackRate;
        const dayCount = days.size;
        const cost = Math.round(dayCount * rate * 100) / 100;
        return {
          crewId,
          name,
          hours,
          basis: "day" as const,
          cost,
          detail: `${name}: ${dayCount} day${dayCount === 1 ? "" : "s"} × ${money(rate)}/day = ${money(cost)}`,
        };
      }
      if (member?.payType === "percent") {
        const pct = amount ?? 0;
        const base = preTax ?? 0;
        const cost = Math.round(((base * pct) / 100) * 100) / 100;
        return {
          crewId,
          name,
          hours,
          basis: "percent" as const,
          cost,
          detail:
            preTax === null
              ? `${name}: ${pct}% of job (no job value set yet)`
              : `${name}: ${pct}% of ${money(base)} = ${money(cost)}`,
        };
      }
      const rate = amount ?? fallbackRate;
      const cost = Math.round(hours * rate * 100) / 100;
      return {
        crewId,
        name,
        hours,
        basis: "hourly" as const,
        cost,
        detail: `${name}: ${hours} hrs × ${money(rate)}/hr = ${money(cost)}`,
      };
    })
    .filter((p) => p.cost > 0 || p.hours > 0)
    .sort((a, b) => b.cost - a.cost);
  const laborHours = laborByPerson.reduce((s, p) => s + p.hours, 0);
  const laborCost =
    Math.round(laborByPerson.reduce((s, p) => s + p.cost, 0) * 100) / 100;
  const laborRate =
    laborHours > 0
      ? Math.round((laborCost / laborHours) * 100) / 100
      : fallbackRate;
  const materials = job.materialsCost ?? 0;
  const other = job.otherCost ?? 0;
  const actual = Math.round((laborCost + materials + other) * 100) / 100;
  return {
    estimated,
    beforeTax: preTax,
    laborHours,
    laborRate,
    laborCost,
    laborByPerson,
    materials,
    other,
    actual,
    // Sales tax is not income: profit is the value before tax less costs.
    profit: estimated === null ? null : Math.round(((preTax ?? estimated) - actual) * 100) / 100,
  };
}
/**
 * One shared job-value rule (invoice → hourly → estimate → manual
 * value): the linked invoice total (discount-aware) if the job is
 * invoiced, else the hourly billing (rate × estimated hours) when the
 * job is billed hourly, else the linked estimate total
 * (discount-aware) if the job has an estimate, else the job's own
 * value field. Null when none exists — never an invented number.
 * "Invoiced" also covers an invoice linked to the job's estimate:
 * invoices created in the app link to the estimate without always
 * setting the job link, and that invoice still bills the job.
 * Keep this as the single source of truth: every place that shows a
 * job's value must call this, so values travel to every surface
 * instead of living only on schedule chips. Estimates stay flat —
 * hourly billing is a job-level setting, not an estimate line.
 */
export function jobValue(state: AppState, job: Job): number | null {
  const inv = invoiceForJob(state, job);
  // A $0 invoice (made before the job had a price) never wipes the
  // job's value: the next source in the rule is used instead.
  if (inv && invoiceTotal(inv) > 0) return invoiceTotal(inv);
  if (
    job.billingType === "hourly" &&
    job.hourlyRate != null &&
    (job.estimatedHours ?? 0) > 0
  ) {
    return Math.round(job.hourlyRate * (job.estimatedHours as number) * 100) / 100;
  }
  // A Climber's price replaces the estimate's (business rule).
  if (job.estimateId && !priceReplaced(job)) {
    const est = state.estimates.find((e) => e.id === job.estimateId);
    if (est) {
      // Accepted proposal option's total when one was accepted.
      return estimateActiveTotals(est).total;
    }
  }
  return job.value ?? (inv ? 0 : null);
}

/** True when a Climber changed this job's price (its estimate's price no longer counts). */
export function priceReplaced(job: Pick<Job, "replacedPrice">): boolean {
  return job.replacedPrice !== null && job.replacedPrice !== undefined;
}

/**
 * The price a Climber's change replaced, to show struck through next
 * to the job's price (business rule: "The replaced price should be
 * visible but have a strikethrough"). Null when the price was never
 * replaced, or the job's price is the same as before.
 */
export function replacedJobPrice(state: AppState, job: Job): number | null {
  if (!priceReplaced(job)) return null;
  const now = jobValue(state, job);
  const old = job.replacedPrice as number;
  if (now !== null && Math.abs(now - old) < 0.005) return null;
  return old;
}

/**
 * The price a Climber's change replaces: the job's price as shown
 * before it, leaving out any invoice (hourly rate × estimated hours,
 * else its estimate's total, else its own value). The database works
 * it out the same way in change_job_price (job_price_before_change,
 * the "money fixes" rules).
 */
export function jobPriceBeforeChange(state: Pick<AppState, "estimates">, job: Job): number | null {
  if (job.billingType === "hourly" && job.hourlyRate != null && (job.estimatedHours ?? 0) > 0) {
    return Math.round(job.hourlyRate * (job.estimatedHours as number) * 100) / 100;
  }
  const est = priceReplaced(job) ? null : jobEstimate(state, job);
  if (est) return Math.round(estimateActiveTotals(est).total * 100) / 100;
  return job.value ?? null;
}

/**
 * The job's estimate as the database finds it for the automatic
 * "Done" invoice and a Climber's price change (invoice_for_done_job,
 * job_price_before_change): the one the job links to, else the one
 * accepted estimate that points at the job (lowest id first).
 */
export function jobEstimate(state: Pick<AppState, "estimates">, job: Pick<Job, "id" | "estimateId">): Estimate | null {
  if (job.estimateId) {
    const linked = state.estimates.find((e) => e.id === job.estimateId);
    if (linked) return linked;
  }
  const pointing = state.estimates
    .filter((e) => e.jobId === job.id && e.status === "accepted")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return pointing[0] ?? null;
}

/**
 * The job's value before tax, by the same rule as jobValue: what
 * percent pay is worked out from (src/percentPay.ts pays a percent of
 * the invoice before tax). Invoice and estimate: lines minus discount;
 * hourly and the job's own value have no tax.
 */
export function jobValueBeforeTax(state: AppState, job: Job): number | null {
  const inv = invoiceForJob(state, job);
  const preTax = (t: { subtotal: number; discount: number }) =>
    Math.round((t.subtotal - t.discount) * 100) / 100;
  if (inv && invoiceTotal(inv) > 0) {
    return preTax(estimateTotals(inv.lines, inv.taxRate, inv.discountType ?? "none", inv.discountValue ?? 0));
  }
  const est = job.estimateId && !priceReplaced(job) ? state.estimates.find((e) => e.id === job.estimateId) : undefined;
  if (
    !est ||
    (job.billingType === "hourly" && job.hourlyRate != null && (job.estimatedHours ?? 0) > 0)
  ) {
    return jobValue(state, job);
  }
  return preTax(estimateActiveTotals(est));
}

/** Discount-aware total for one invoice. */
function invoiceTotal(inv: Invoice): number {
  return estimateTotals(
    inv.lines,
    inv.taxRate,
    inv.discountType ?? "none",
    inv.discountValue ?? 0,
  ).total;
}

/**
 * The invoice billing a job, if any: the job's own invoiceId first,
 * else an invoice whose estimateId points at the job's linked
 * estimate. Imported invoices all have estimate_id NULL, so this
 * only changes in-app invoices — but without it a job billed through
 * its estimate would still read as uninvoiced.
 */
export function invoiceForJob(
  state: AppState,
  job: Job,
): Invoice | null {
  if (job.invoiceId) {
    const direct = state.invoices.find((i) => i.id === job.invoiceId);
    if (direct) return direct;
  }
  if (job.estimateId) {
    const viaEstimate = state.invoices.find(
      (i) => i.estimateId === job.estimateId,
    );
    if (viaEstimate) return viaEstimate;
  }
  return null;
}

/** Human reference for an estimate: the Breezeworks number when the id carries one ("#731"), else its title. */
export function estimateRef(e: Estimate): string {
  const m = /^bw-est-(\d+)$/.exec(e.id);
  return m ? `#${m[1]}` : `"${e.title}"`;
}

/**
 * Which source actually supplies the job's value under the shared
 * rule (invoice → hourly → estimate → manual value) — the same
 * order jobValue uses, so the label can never disagree with the
 * number. The value is shown FROM the source, never copied into
 * the job's manual value field, so if the estimate or invoice
 * changes the job follows automatically.
 */
export type JobValueSource =
  | { kind: "invoice"; label: string }
  | { kind: "hourly"; label: string }
  | { kind: "estimate"; label: string }
  | { kind: "manual"; label: string };

export function jobValueSource(state: AppState, job: Job): JobValueSource {
  const inv = invoiceForJob(state, job);
  if (inv && invoiceTotal(inv) > 0) {
    return { kind: "invoice", label: `from invoice #${inv.number}` };
  }
  if (
    job.billingType === "hourly" &&
    job.hourlyRate != null &&
    (job.estimatedHours ?? 0) > 0
  ) {
    return {
      kind: "hourly",
      label: `hourly — ${money(job.hourlyRate)} × ${job.estimatedHours}h`,
    };
  }
  if (job.estimateId && !priceReplaced(job)) {
    const est = state.estimates.find((e) => e.id === job.estimateId);
    if (est) {
      return { kind: "estimate", label: `from estimate ${estimateRef(est)}` };
    }
  }
  if (priceReplaced(job)) return { kind: "manual", label: "price set by a Climber" };
  if (inv && job.value == null) return { kind: "invoice", label: `from invoice #${inv.number}` };
  return { kind: "manual", label: "manual value" };
}

/**
 * Jobs done and not yet billed: status "done", date before today,
 * and no invoice linked — neither the job's invoiceId, nor any
 * invoice row pointing at the job, nor any invoice pointing at the
 * job's linked estimate (in-app invoices can bill through the
 * estimate without setting the job link). Oldest first. A job is
 * overdue when today has reached the next business day after its
 * date — a Friday job is overdue on Monday, a Saturday job on
 * Monday too. (The Dashboard renders the list and highlights the
 * overdue rows.)
 */
export function stillToInvoiceJobs(
  state: AppState,
  today: string,
): Array<{ job: Job; daysSince: number; overdue: boolean }> {
  const invoiced = new Set<string>();
  const invoicedEstimates = new Set<string>();
  for (const inv of state.invoices) {
    if (inv.jobId) invoiced.add(inv.jobId);
    if (inv.estimateId) invoicedEstimates.add(inv.estimateId);
  }
  const out: Array<{ job: Job; daysSince: number; overdue: boolean }> = [];
  for (const job of state.jobs) {
    if (job.status !== "done") continue;
    if (job.date >= today) continue;
    if (job.invoiceId) continue;
    if (invoiced.has(job.id)) continue;
    if (job.estimateId && invoicedEstimates.has(job.estimateId)) continue;
    const daysSince = daysBetweenISO(job.date, today);
    out.push({
      job,
      daysSince,
      overdue: today >= nextBusinessDay(job.date),
    });
  }
  out.sort((a, b) => a.job.date.localeCompare(b.job.date));
  return out;
}

/**
 * Planned labor cost per hour for a job: what the crew on it costs
 * per hour, from how each person is paid — not the timesheet actuals
 * (jobCosting covers those). Per person:
 * - hourly: their $/hr;
 * - day: their $/day ÷ 8 (an 8-hour day — a working assumption, not a
 *   payroll rule);
 * - percent: their % of the job's value ÷ estimated hours (needs both
 *   a value and hours; without either the person costs $0 here and
 *   the line says why — never divide by zero, never invent hours);
 * - no pay set: the job's labor rate, else the $75/hr default (the
 *   old default is now the fallback only).
 * Everyone ticked "Count on every job's labor cost" on their card
 * (office overhead, e.g. Sam) is added too, by the same rules; if
 * they are already on the crew they are counted once.
 * Returns the total plus one line per person, so the UI can show the
 * breakdown.
 */
export function hourlyLaborCost(
  state: AppState,
  job: Job,
  crewIds: string[],
): {
  perHour: number;
  lines: Array<{ crewId: string; name: string; rate: number; note?: string }>;
  /** Names of people ticked "Count on every job's labor cost". */
  alwaysCounted: string[];
} {
  const fallback = job.laborRate ?? 75;
  // Percent pay is a percent of the value before tax (as payroll pays it).
  const value = jobValueBeforeTax(state, job);
  const hours = job.estimatedHours ?? 0;
  const fmt = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rateFor = (
    m: CrewMember,
  ): { rate: number; note?: string } => {
    if (m.payType === "hourly" && m.payAmount != null) {
      return { rate: m.payAmount };
    }
    if (m.payType === "day" && m.payAmount != null) {
      return {
        rate: Math.round((m.payAmount / 8) * 100) / 100,
        note: `${fmt(m.payAmount)}/day ÷ 8h`,
      };
    }
    if (m.payType === "percent" && m.payAmount != null) {
      if (value == null || hours <= 0) {
        return {
          rate: 0,
          note: `${m.payAmount}% of the job — needs a job value and estimated hours`,
        };
      }
      return {
        rate: Math.round(((value * m.payAmount) / 100 / hours) * 100) / 100,
        note: `${m.payAmount}% of ${fmt(value)} ÷ ${hours}h`,
      };
    }
    return { rate: fallback, note: `no pay set — ${fmt(fallback)}/hr default` };
  };
  const lines: Array<{
    crewId: string;
    name: string;
    rate: number;
    note?: string;
  }> = [];
  const seen = new Set<string>();
  for (const id of crewIds) {
    const m = state.crew.find((c) => c.id === id);
    if (!m || seen.has(id)) continue;
    seen.add(id);
    const { rate, note } = rateFor(m);
    lines.push({ crewId: id, name: m.name, rate, note });
  }
  // People ticked "Count on every job's labor cost" (office overhead).
  const always = state.crew.filter((c) => c.countedOnEveryJob === true && c.status !== "revoked");
  for (const m of always) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const { rate, note } = rateFor(m);
    lines.push({
      crewId: m.id,
      name: m.name,
      rate,
      note: `${note ? `${note} · ` : ""}counted on every job`,
    });
  }
  const perHour =
    Math.round(lines.reduce((s, l) => s + l.rate, 0) * 100) / 100;
  return { perHour, lines, alwaysCounted: always.map((m) => m.name) };
}
