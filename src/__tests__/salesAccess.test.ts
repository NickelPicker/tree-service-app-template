import { describe, expect, it } from "vitest";
import { showsMoney } from "../permissions";
import { writtenBy } from "../estimateGroups";
import { buildNav, fieldGroupsFor } from "../navGroups";
import type { Estimate } from "../types";

// The "sales access refine" rules (business rule: "Pat can see the money …
// he needs to see the jobs the teams are doing … estimates he's written").

describe("money on screen", () => {
  it("follows the see-money switch for everyone", () => {
    expect(showsMoney(true, "crew", "Groundsman")).toBe(true);
    expect(showsMoney(false, "crew", "Groundsman")).toBe(false);
    expect(showsMoney(false, "crew", "Climber")).toBe(false);
  });
  it("is always on for a Sales person, any letter case", () => {
    expect(showsMoney(false, "crew", "Sales")).toBe(true);
    expect(showsMoney(false, "crew", " sales ")).toBe(true);
  });
  it("needs a login (no app role = no money)", () => {
    expect(showsMoney(false, null, "Sales")).toBe(false);
  });
});

const est = (id: string, createdByCrewId: string | null | undefined): Estimate => ({
  id,
  customerId: "c1",
  jobId: null,
  title: id,
  lines: [],
  taxRate: 0,
  discountType: "none",
  discountValue: 0,
  status: "sent",
  createdDate: "2026-11-17",
  notes: "",
  emailQueuedAt: null,
  createdByCrewId,
});

describe("Mine", () => {
  const list = [est("a", "pat"), est("b", "sam"), est("c", null), est("d", undefined), est("e", "pat")];
  it("keeps only the estimates this person wrote", () => {
    expect(writtenBy(list, "pat").map((e) => e.id)).toEqual(["a", "e"]);
  });
  it("never counts old estimates with no author, nor a viewer with no card", () => {
    expect(writtenBy(list, "")).toEqual([]);
    expect(writtenBy(list, null)).toEqual([]);
  });
});

describe("Sales tabs for a crew login", () => {
  it("has the Sales calendar and estimates, and the team's Schedule, but no Invoices", () => {
    const nav = buildNav(
      ["crew", "schedule", "equipment", "guide", "me", "timesheets", "customers", "sales", "estimates"],
      fieldGroupsFor(true),
    );
    expect(nav.main.map((g) => g.id)).toEqual(["crew", "sales", "schedule", "equipment", "me"]);
    expect(nav.main.find((g) => g.id === "sales")?.views).toEqual(["sales", "estimates"]);
    expect([...nav.main.flatMap((g) => g.views), ...nav.more]).not.toContain("invoices");
  });
});
