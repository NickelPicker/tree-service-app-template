import { autoSendText } from "./autoInvoice";
import { estimateActiveLines, estimateTotals } from "./email";
import { invoiceForJob, priceReplaced } from "./jobValue";
import { entryMinutes } from "./overtime";
import type { AppState, DiscountType, Estimate, Invoice, Job, ServiceType } from "./types";

/**
 * Making invoices by hand (the "Make invoice" / "Create invoice"
 * buttons): what the invoice is priced from, when the buttons show, the
 * one invoice number format, the service type a job gets from its
 * estimate, and the one status line on an automatic invoice.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The one number format for new invoices: INV-<highest number in use + 1>, from INV-1001. */
export function nextInvoiceNumber(invoices: Array<Pick<Invoice, "number">>): string {
  const nums = invoices
    .map((i) => parseInt(String(i.number ?? "").replace(/\D/g, ""), 10))
    .filter((n) => !Number.isNaN(n) && n < 1e15);
  const next = (nums.length ? Math.max(...nums) : 1000) + 1;
  return `INV-${next}`;
}

export interface InvoicePricing {
  lines: Array<{ description: string; quantity: number; unitPrice: number; treeId?: string | null }>;
  taxRate: number;
  discountType: DiscountType;
  discountValue: number;
  total: number;
  /** Where the price came from, in plain words. */
  source: "hourly" | "estimate" | "job value" | "none";
}

/** Hours clocked on a job, all people, all days. */
export function clockedJobHours(state: Pick<AppState, "timesheets">, jobId: string): number {
  const mins = state.timesheets
    .filter((t) => t.jobId === jobId)
    .reduce((s, t) => s + entryMinutes(t), 0);
  return round2(mins / 60);
}

function priced(
  lines: InvoicePricing["lines"],
  source: InvoicePricing["source"],
  taxRate = 0,
  discountType: DiscountType = "none",
  discountValue = 0,
): InvoicePricing {
  const total = round2(estimateTotals(lines, taxRate, discountType, discountValue).total);
  return { lines, taxRate, discountType, discountValue, total, source };
}

/**
 * What an invoice made from a job is priced from, in the same order as
 * the job's value (jobValue): hourly billing (rate × hours clocked on
 * the job, or the estimated hours when nobody clocked any), then the
 * job's estimate (the accepted option's lines), then the job's own
 * value. Total 0 means there is no price anywhere: the office is warned
 * before such an invoice is made.
 */
export function jobInvoicePricing(state: Pick<AppState, "estimates" | "timesheets">, job: Job): InvoicePricing {
  const what = `${job.serviceType} — ${job.title}`;
  if (job.billingType === "hourly" && typeof job.hourlyRate === "number" && job.hourlyRate > 0) {
    const clocked = clockedJobHours(state, job.id);
    const hours = clocked > 0 ? clocked : (job.estimatedHours ?? 0);
    if (hours > 0) {
      return priced([{ description: `${what} (${hours} hours)`, quantity: hours, unitPrice: job.hourlyRate }], "hourly");
    }
  }
  // A Climber's price replaces the estimate's (business rule): the
  // invoice is then priced from the job's own value.
  const est =
    job.estimateId && !priceReplaced(job) ? state.estimates.find((e) => e.id === job.estimateId) : undefined;
  if (est) {
    const lines = estimateActiveLines(est).map((l) => ({ ...l }));
    const p = priced(lines, "estimate", est.taxRate, est.discountType ?? "none", est.discountValue ?? 0);
    if (p.total > 0) return p;
  }
  if (typeof job.value === "number" && job.value > 0) {
    return priced([{ description: what, quantity: 1, unitPrice: job.value }], "job value");
  }
  return priced([{ description: what, quantity: 1, unitPrice: 0 }], "none");
}

/**
 * "Create invoice" shows only for a job that is Done and has no invoice
 * yet (invoices are made automatically when a job is marked done; the
 * button is for the ones that were not).
 */
export function canMakeInvoiceForJob(state: Pick<AppState, "invoices">, job: Job | null | undefined): boolean {
  if (!job || job.status !== "done") return false;
  if (job.invoiceId && state.invoices.some((i) => i.id === job.invoiceId)) return false;
  if (state.invoices.some((i) => i.jobId === job.id)) return false;
  return invoiceForJob(state as AppState, job) === null;
}

/** The job made from an estimate, if any. */
export function jobOfEstimate(state: Pick<AppState, "jobs">, est: Estimate): Job | null {
  return (
    (est.jobId ? state.jobs.find((j) => j.id === est.jobId) : undefined) ??
    state.jobs.find((j) => j.estimateId === est.id) ??
    null
  );
}

/**
 * What "Create invoice from this estimate" bills: the estimate's lines,
 * tax and discount, except when a Climber replaced the price of the
 * estimate's job (business rule): then the job's own price, as an
 * invoice made from the job.
 */
export function estimateInvoicePricing(
  state: Pick<AppState, "jobs" | "estimates" | "timesheets">,
  est: Estimate,
): InvoicePricing {
  const job = jobOfEstimate(state, est);
  if (job && priceReplaced(job)) return jobInvoicePricing(state, job);
  return priced(
    estimateActiveLines(est).map((l) => ({ ...l })),
    "estimate",
    est.taxRate,
    est.discountType ?? "none",
    est.discountValue ?? 0,
  );
}

/**
 * True when this invoice bills the job's own price after a Climber
 * replaced it (its total is what an invoice made from the job now
 * bills). False for an invoice that still bills the old price.
 */
export function invoiceBillsReplacedPrice(
  state: Pick<AppState, "estimates" | "timesheets">,
  job: Job,
  inv: Pick<Invoice, "lines" | "taxRate" | "discountType" | "discountValue">,
): boolean {
  if (!priceReplaced(job)) return false;
  const billed = round2(
    estimateTotals(inv.lines, inv.taxRate, inv.discountType ?? "none", inv.discountValue ?? 0).total,
  );
  return Math.abs(billed - jobInvoicePricing(state, job).total) < 0.005;
}

/**
 * "Create invoice from this estimate": nothing has invoiced it yet, and
 * when the estimate has a job, only once that job is Done. An estimate
 * that never became a job (a deposit, work not scheduled in the app) can
 * be invoiced straight away, as before.
 */
export function canMakeInvoiceForEstimate(state: Pick<AppState, "jobs" | "invoices">, est: Estimate): boolean {
  if (state.invoices.some((i) => i.estimateId === est.id)) return false;
  const job = jobOfEstimate(state, est);
  if (!job) return true;
  return canMakeInvoiceForJob(state, job);
}

/** Time entries on this job that are still clocked in (no clock-out yet). */
export function openClockEntriesOnJob(state: Pick<AppState, "timesheets">, jobId: string): number {
  return state.timesheets.filter((t) => t.jobId === jobId && !!t.clockIn && !t.clockOut).length;
}

/**
 * Asks before an hourly job is invoiced while someone is still clocked in
 * on it: their time is not on the invoice yet. True = go ahead.
 */
export function okToInvoiceWithOpenClock(
  state: Pick<AppState, "timesheets">,
  job: Pick<Job, "id" | "billingType">,
  confirm: (msg: string) => boolean = (m) => window.confirm(m),
): boolean {
  if (job.billingType !== "hourly") return true;
  const n = openClockEntriesOnJob(state, job.id);
  if (n === 0) return true;
  return confirm(
    `${n} ${n === 1 ? "person is" : "people are"} still clocked in on this job. Their time is not on the invoice yet.\n\nMake the invoice anyway?`,
  );
}

/** Asks before a $0 invoice is made or sent. True = go ahead. */
export function okToMakeZeroInvoice(total: number, confirm: (msg: string) => boolean = (m) => window.confirm(m)): boolean {
  if (total > 0) return true;
  return confirm(
    "This invoice would be $0: the job has no price (no estimate, no hourly rate and no job value).\n\nMake it anyway? You can type the price on the invoice before you send it.",
  );
}

export function okToSendZeroInvoice(total: number, confirm: (msg: string) => boolean = (m) => window.confirm(m)): boolean {
  if (total > 0) return true;
  return confirm("This invoice is $0. Email it to the customer anyway?");
}

const SERVICE_WORDS: Array<[RegExp, ServiceType]> = [
  [/\bstumps?\b|\bgrind/i, "Stump Grinding"],
  [/\bemergenc|\bstorm\b/i, "Emergency"],
  [/\bfertili[sz]/i, "Fertilization"],
  [/\bplant health\b|\bphc\b|\btreatments?\b|\beab\b|\binject|\bspray/i, "Plant Health Care"],
  [/\bremov|\btake down\b|\btake-down\b|\btree down\b/i, "Removal"],
  [/\btrim|\bprun|\bthin(ning)?\b|\bcrown\b|\bdeadwood/i, "Trimming"],
];

function firstService(text: string): ServiceType | null {
  let best: { at: number; type: ServiceType } | null = null;
  for (const [re, type] of SERVICE_WORDS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, type };
  }
  return best?.type ?? null;
}

/**
 * The service type a job gets from its estimate: the first kind of work
 * the estimate's title names ("Stump grinding (2 stumps)" = Stump
 * Grinding, "Remove oak and grind stump" = Removal), else what its lines
 * name, else Trimming.
 */
export function serviceTypeForEstimate(est: Pick<Estimate, "title" | "lines" | "options" | "acceptedOptionId">): ServiceType {
  const fromTitle = firstService(est.title ?? "");
  if (fromTitle) return fromTitle;
  const lines = estimateActiveLines(est as Estimate);
  return firstService(lines.map((l) => l.description).join(" \n ")) ?? "Trimming";
}

/**
 * The one status line on an invoice about its email: for an invoice the
 * app made by itself when the job was marked done, always a line (sent,
 * when it sends, or why it will not); for others, the automatic email's
 * line when there is one.
 */
/** True when the invoice was really emailed (database-set emailedAt, or its automatic email went). */
export function invoiceWasEmailed(i: Pick<Invoice, "emailedAt" | "autoSendStatus">): boolean {
  return (i.emailedAt ?? "") !== "" || i.autoSendStatus === "sent";
}

export function invoiceEmailStatus(i: Invoice, emailsOn: boolean, now = new Date()): string | null {
  if ((i.emailedAt ?? "") !== "" && i.autoSendStatus !== "sent" && i.autoSendStatus !== "sending") {
    return i.autoCreated ? "Emailed from the app by the office." : null;
  }
  if (i.autoSendStatus) return autoSendText(i, emailsOn, now);
  if (!i.autoCreated) return null;
  return emailsOn
    ? "Not sent yet: press Email invoice."
    : "Not sent: automatic emails are off — press Email invoice.";
}
