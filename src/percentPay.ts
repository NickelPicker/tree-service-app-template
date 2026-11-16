import { estimateTotals } from "./email";
import type { CrewMember, Invoice, Job, TimesheetEntry } from "./types";

/**
 * Percent-of-job pay (the owner's rule): a person paid a percent earns
 * that percent of the job's value before tax, for each job they worked
 * (they have a timesheet entry on it). It is paid in the week the
 * customer's invoice for that job is marked paid (the invoice's paid
 * date). A job that ran several days pays once. Jobs worked whose
 * invoice is not paid yet are listed as "waiting for payment".
 */
export interface PercentJob {
  jobId: string;
  title: string;
  /** Invoice number, or null when the job has no invoice yet. */
  invoiceNumber: string | null;
  /** Job value before tax (the invoice's, after any discount). */
  base: number | null;
  /** The person's share, or null while it is not known. */
  amount: number | null;
  paidDate: string | null;
}

export interface PercentPay {
  /** Jobs whose invoice was paid in this week: these are paid now. */
  paid: PercentJob[];
  /** Jobs worked (up to the end of this week) still waiting for the customer to pay. */
  waiting: PercentJob[];
  /** Total of `paid`. */
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Invoice total before tax: lines minus discount. */
export function invoicePreTax(inv: Invoice): number {
  const t = estimateTotals(inv.lines, inv.taxRate, inv.discountType ?? "none", inv.discountValue ?? 0);
  return round2(t.subtotal - t.discount);
}

/** The invoice billing a job (same rule as jobValue's invoiceForJob). */
export function invoiceOfJob(job: Job, invoices: Invoice[]): Invoice | null {
  if (job.invoiceId) {
    const direct = invoices.find((i) => i.id === job.invoiceId);
    if (direct) return direct;
  }
  const byJob = invoices.find((i) => i.jobId === job.id);
  if (byJob) return byJob;
  if (job.estimateId) return invoices.find((i) => i.estimateId === job.estimateId) ?? null;
  return null;
}

export function isPaidInvoice(inv: Invoice | null): inv is Invoice & { paidDate: string } {
  return !!inv && inv.status === "paid" && typeof inv.paidDate === "string" && inv.paidDate !== "";
}

export function percentPay(
  person: Pick<CrewMember, "id" | "payType" | "payAmount">,
  timesheets: TimesheetEntry[],
  jobs: Job[],
  invoices: Invoice[],
  week: string[],
): PercentPay {
  const out: PercentPay = { paid: [], waiting: [], total: 0 };
  if (person.payType !== "percent") return out;
  const pct = typeof person.payAmount === "number" && person.payAmount > 0 ? person.payAmount : null;
  const sorted = [...week].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return out;
  // Each job once, however many days or entries.
  const jobIds = new Set<string>();
  const firstDay = new Map<string, string>();
  for (const t of timesheets) {
    if (t.crewId !== person.id || !t.jobId) continue;
    jobIds.add(t.jobId);
    const prev = firstDay.get(t.jobId);
    if (!prev || t.date < prev) firstDay.set(t.jobId, t.date);
  }
  for (const jobId of jobIds) {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) continue;
    const inv = invoiceOfJob(job, invoices);
    const base = inv ? invoicePreTax(inv) : null;
    const row: PercentJob = {
      jobId,
      title: job.title || "Job",
      invoiceNumber: inv?.number ?? null,
      base,
      amount: base !== null && pct !== null ? round2((base * pct) / 100) : null,
      paidDate: isPaidInvoice(inv) ? inv.paidDate : null,
    };
    if (row.paidDate) {
      if (row.paidDate >= first && row.paidDate <= last) out.paid.push(row);
    } else if ((firstDay.get(jobId) ?? "") <= last) {
      out.waiting.push(row);
    }
  }
  const byTitle = (a: PercentJob, b: PercentJob) => a.title.localeCompare(b.title);
  out.paid.sort(byTitle);
  out.waiting.sort(byTitle);
  out.total = round2(out.paid.reduce((s, r) => s + (r.amount ?? 0), 0));
  return out;
}
