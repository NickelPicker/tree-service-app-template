/**
 * Dashboard "Accepted online — call to schedule": estimates a customer
 * accepted on their private link that have no job yet. The customer
 * gets no email when they accept (business rule: "we will reach out
 * manually to schedule them"), so the office sees them here (and in
 * Schedule → "To schedule") and calls. An item leaves the list once the
 * estimate has a job. No React here, so it is unit tested on its own.
 */
import type { Customer, Estimate, Job } from "./types";

/** Older acceptances are left to Schedule → "To schedule". */
export const ACCEPTED_ONLINE_DAYS = 30;

export interface AcceptedOnlineItem {
  estimateId: string;
  customerId: string;
  customerName: string;
  phone: string;
  /** "Oak removal — Best" */
  what: string;
  /** ISO time the customer accepted. */
  acceptedAt: string;
}

/**
 * Accepted on the link: status accepted, a typed name and a time (an
 * estimate marked accepted by hand in the office has no typed name).
 */
export function acceptedOnline(
  estimates: readonly Estimate[],
  jobs: readonly Job[],
  customers: readonly Customer[],
  now: Date = new Date(),
): AcceptedOnlineItem[] {
  const since = now.getTime() - ACCEPTED_ONLINE_DAYS * 86_400_000;
  const withJob = new Set(jobs.map((j) => j.estimateId).filter((x): x is string => !!x));
  const out: AcceptedOnlineItem[] = [];
  for (const e of estimates) {
    if (e.status !== "accepted" || withJob.has(e.id) || e.jobId) continue;
    if (!(e.acceptedBy ?? "").trim() || !e.acceptedAt) continue;
    const t = new Date(e.acceptedAt).getTime();
    if (!Number.isFinite(t) || t < since) continue;
    const c = customers.find((x) => x.id === e.customerId);
    const option = e.acceptedOptionId ? (e.options ?? []).find((o) => o.id === e.acceptedOptionId) : undefined;
    out.push({
      estimateId: e.id,
      customerId: e.customerId,
      customerName: c ? `${c.firstName} ${c.lastName}`.trim() || c.companyName || "Customer" : "Customer",
      phone: (c?.phone ?? "").trim(),
      what: option?.label ? `${e.title} — ${option.label}` : e.title,
      acceptedAt: e.acceptedAt,
    });
  }
  return out.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}
