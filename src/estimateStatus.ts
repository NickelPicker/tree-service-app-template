import type { EstimateStatus } from "./types";

/**
 * What people see for an estimate's status. The stored value stays
 * "closed" (database, saved rows, filters); people see "Declined"
 * (business rule: "Rename it declined").
 */
export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  closed: "Declined",
};

/** The label for a stored estimate status ("closed" → "Declined"). */
export function estimateStatusLabel(status: string): string {
  return ESTIMATE_STATUS_LABELS[status as EstimateStatus] ?? status;
}
