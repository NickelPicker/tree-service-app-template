import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditEntry } from "../types";
import { ESTIMATE_STATUS_LABELS, estimateStatusLabel } from "../estimateStatus";
import { auditLine } from "../auditText";
import { StatusBadge } from "../components/ui";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

// Business rule: "Rename it declined." The stored status stays
// "closed"; people see "Declined".
describe('estimate status "closed" reads "Declined"', () => {
  it("labels every estimate status, closed as Declined", () => {
    expect(ESTIMATE_STATUS_LABELS).toEqual({
      draft: "Draft",
      sent: "Sent",
      accepted: "Accepted",
      closed: "Declined",
    });
    expect(estimateStatusLabel("closed")).toBe("Declined");
    expect(estimateStatusLabel("sent")).toBe("Sent");
    expect(estimateStatusLabel("something-else")).toBe("something-else");
  });

  it("the status badge says Declined, never Closed", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status: "closed" }));
    expect(html).toContain("Declined");
    expect(html).not.toContain("Closed");
  });

  it("the change history says Declined", () => {
    const e: AuditEntry = {
      id: "a",
      timestamp: "2026-11-16T10:00:00Z",
      actor: "Alex",
      entity: "Estimate",
      entityId: "e1",
      entityLabel: "Big oak",
      field: "status",
      oldValue: "sent",
      newValue: "closed",
      customerId: "c1",
      jobId: null,
    };
    const line = auditLine(e);
    expect(line).toContain("Declined");
    expect(line).not.toMatch(/closed/i);
  });
});
