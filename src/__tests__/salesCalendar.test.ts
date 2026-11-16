import { describe, expect, it } from "vitest";
import {
  customerSuggestions,
  movedVisit,
  newCustomerFrom,
  openDraftFor,
  planCreateEstimate,
  shortTime,
  visitChipLabel,
  visitsByDay,
  visitsOnDay,
} from "../salesCalendar";
import { fieldGroupsFor } from "../navGroups";
import { canSellRecords, isSalesTitle } from "../permissions";
import type { Customer, Estimate } from "../types";

const blank = { name: "", phone: "", email: "", address: "", city: "", zip: "" };

function cust(id: string, first: string, last: string, phone = ""): Customer {
  return { ...newCustomerFrom(id, { ...blank, name: `${first} ${last}`, phone }) };
}

function est(id: string, over: Partial<Estimate> = {}): Estimate {
  return {
    id,
    customerId: "c1",
    jobId: null,
    title: "Oak removal",
    lines: [],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "draft",
    createdDate: "2026-11-10",
    notes: "",
    emailQueuedAt: null,
    options: null,
    acceptedOptionId: null,
    acceptedBy: null,
    acceptedAt: null,
    ...over,
  };
}

const ids = { customerId: "new-c", estimateId: "new-e", lineId: "new-l" };

describe("visits per day", () => {
  const estimates = [
    est("late", { visitDate: "2026-11-17", visitTime: "14:00" }),
    est("early", { visitDate: "2026-11-17", visitTime: "09:30" }),
    est("noTime", { visitDate: "2026-11-17", visitTime: null }),
    est("sent", { visitDate: "2026-11-17", visitTime: "11:00", status: "sent" }),
    est("lost", { visitDate: "2026-11-17", visitTime: "12:00", status: "closed" }),
    est("other", { visitDate: "2026-11-18", visitTime: "08:00" }),
  ];

  it("lists a day's visits in time order, sent and closed ones included (kept for good), untimed ones not", () => {
    expect(visitsOnDay(estimates, "2026-11-17").map((e) => e.id)).toEqual([
      "early", "sent", "lost", "late",
    ]);
  });

  it("groups the month in one pass, each day in time order", () => {
    const m = visitsByDay(estimates, ["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(m.get("2026-11-16")).toEqual([]);
    expect(m.get("2026-11-17")!.map((e) => e.id)).toEqual(["early", "sent", "lost", "late"]);
    expect(m.get("2026-11-18")!.map((e) => e.id)).toEqual(["other"]);
  });

  it("labels chips like 9:30 · Smith — oak removal", () => {
    expect(shortTime("13:00")).toBe("1:00");
    expect(visitChipLabel(estimates[1], cust("c1", "Jane", "Smith"))).toBe(
      "9:30 · Smith — Oak removal",
    );
  });
});

describe("moving a visit", () => {
  const e = est("e", { visitDate: "2026-11-17", visitTime: "09:30" });
  it("keeps the time when none is picked", () => {
    expect(movedVisit(e, "2026-11-19")).toEqual({ visitDate: "2026-11-19", visitTime: "09:30" });
  });
  it("takes a new time when one is picked", () => {
    expect(movedVisit(e, "2026-11-19", "13:00")).toEqual({ visitDate: "2026-11-19", visitTime: "13:00" });
  });
});

describe("Create estimate", () => {
  const customers = [cust("c1", "Jane", "Smith", "555-555-0199"), cust("c2", "Bob", "Jones")];

  it("suggests existing customers by name or phone digits", () => {
    expect(customerSuggestions(customers, "smi").map((c) => c.id)).toEqual(["c1"]);
    expect(customerSuggestions(customers, "5555550").map((c) => c.id)).toEqual(["c1"]);
    expect(customerSuggestions(customers, "j")).toEqual([]);
  });

  it("reuses the customer's open draft (no visit yet) and books the visit on it", () => {
    const draft = est("d1", { title: "", notes: "Big oak" });
    const plan = planCreateEstimate(
      { customers, estimates: [draft, est("old", { createdDate: "2026-10-01" })] },
      { customerId: "c1", newCustomer: null, title: "Oak removal", notes: "Gate code 12", visitDate: "2026-11-17", visitTime: "09:30" },
      ids,
      "2026-11-16",
    )!;
    expect(plan.customerIsNew).toBe(false);
    expect(plan.previous?.id).toBe("d1");
    expect(plan.estimate).toMatchObject({
      id: "d1",
      title: "Oak removal",
      notes: "Big oak\nGate code 12",
      visitDate: "2026-11-17",
      visitTime: "09:30",
    });
  });

  it("starts a new draft when the open drafts already have a visit or a job", () => {
    const estimates = [
      est("booked", { visitDate: "2026-11-18", visitTime: "10:00" }),
      est("withJob", { jobId: "j1" }),
      est("sent", { status: "sent" }),
    ];
    expect(openDraftFor(estimates, "c1")).toBeNull();
    const plan = planCreateEstimate(
      { customers, estimates },
      { customerId: "c1", newCustomer: null, title: "", notes: "", visitDate: "2026-11-17", visitTime: "13:00" },
      ids,
      "2026-11-16",
    )!;
    expect(plan.previous).toBeNull();
    expect(plan.estimate).toMatchObject({
      id: "new-e",
      customerId: "c1",
      status: "draft",
      title: "Estimate visit",
      createdDate: "2026-11-16",
      visitDate: "2026-11-17",
      visitTime: "13:00",
    });
  });

  it("adds a new customer with the typed details and a new draft", () => {
    const plan = planCreateEstimate(
      { customers, estimates: [] },
      {
        customerId: null,
        newCustomer: { name: " Ana  de Souza ", phone: "444-555-1111", email: "", address: "1 Elm St", city: "Anytown", zip: "12302" },
        title: "Prune maple",
        notes: "",
        visitDate: null,
        visitTime: "09:00",
      },
      ids,
      "2026-11-16",
    )!;
    expect(plan.customerIsNew).toBe(true);
    expect(plan.customer).toMatchObject({
      id: "new-c", firstName: "Ana", lastName: "de Souza", phone: "444-555-1111", address: "1 Elm St", city: "Anytown",
    });
    // No day: no visit (the time alone is dropped).
    expect(plan.estimate).toMatchObject({ customerId: "new-c", visitDate: null, visitTime: null, title: "Prune maple" });
  });

  it("needs a customer", () => {
    expect(
      planCreateEstimate(
        { customers, estimates: [] },
        { customerId: null, newCustomer: { ...blank }, title: "", notes: "", visitDate: null, visitTime: null },
        ids,
        "2026-11-16",
      ),
    ).toBeNull();
  });
});

describe("who sees and books on the Sales calendar", () => {
  it("knows a Sales person by job title, any letter case", () => {
    expect(isSalesTitle(" sales ")).toBe(true);
    expect(isSalesTitle("SALES")).toBe(true);
    expect(isSalesTitle("Groundsman")).toBe(false);
    expect(canSellRecords("crew", "Sales")).toBe(true);
    expect(canSellRecords("crew", "Climber")).toBe(false);
    expect(canSellRecords("office", "Groundsman")).toBe(true);
    expect(canSellRecords("owner", null)).toBe(true);
  });

  it("puts the Sales tab right after Today for a crew-login Sales person only", () => {
    expect(fieldGroupsFor(true).map((g) => g.id)).toEqual(["crew", "sales", "schedule", "equipment", "me"]);
    expect(fieldGroupsFor(false).map((g) => g.id)).toEqual(["crew", "schedule", "equipment", "me"]);
  });
});
