import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  approvalChanges,
  changeLines,
  changesText,
  decisionText,
  recentDecided,
  currentValues,
  diffSuggestion,
  pendingAll,
  pendingFor,
  sanitizeChanges,
  suggestionSummary,
} from "../customerEdits";
import { newCustomerFrom } from "../salesCalendar";
import { customerEditRequestFromRow } from "../data/supabaseAdapter";
import type { Customer, CustomerEditRequest } from "../types";

function ann(): Customer {
  const c = newCustomerFrom("c1", {
    name: "Ann Smith",
    phone: "555-555-0001",
    email: "ann@example.com",
    address: "1 Elm St",
    city: "Anytown",
    zip: "12301",
  });
  return { ...c, gateCode: "1234" };
}

function req(over: Partial<CustomerEditRequest> = {}): CustomerEditRequest {
  return {
    id: "r1",
    customerId: "c1",
    requestedBy: "e-pat",
    requestedName: "Pat",
    createdAt: "2026-11-16T10:00:00Z",
    changes: { phone: "555-555-0100" },
    note: "",
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    declineReason: "",
    appliedChanges: null,
    ...over,
  };
}

describe("suggested customer changes", () => {
  it("prefills the form from the customer and its primary address", () => {
    const v = currentValues(ann());
    expect(v.first_name).toBe("Ann");
    expect(v.phone).toBe("555-555-0001");
    expect(v.street).toBe("1 Elm St");
    expect(v.state).toBe("CO");
  });

  it("sends only the fields that changed", () => {
    const c = ann();
    const form = { ...currentValues(c), phone: " 555-555-0100 ", zip: "12302" };
    expect(diffSuggestion(c, form)).toEqual({ phone: "555-555-0100", zip: "12302" });
    expect(diffSuggestion(c, currentValues(c))).toEqual({});
  });

  it("drops fields outside the allow-list and non-text values", () => {
    expect(
      sanitizeChanges({ phone: "1", customer_type: "commercial", company_id: "x", email: 5, notes: "ok" }),
    ).toEqual({ phone: "1", notes: "ok" });
    expect(sanitizeChanges(null)).toEqual({});
    expect(sanitizeChanges(["phone"])).toEqual({});
    expect(diffSuggestion(ann(), { customer_type: "commercial" } as Record<string, string>)).toEqual({});
  });

  it("cuts values to the database's length", () => {
    expect(sanitizeChanges({ phone: "9".repeat(300) }).phone).toHaveLength(200);
    expect(sanitizeChanges({ notes: "n".repeat(5000) }).notes).toHaveLength(4000);
  });

  it("reads before → after and a one-line summary", () => {
    const c = ann();
    const r = req({ changes: { zip: "12302", phone: "555-555-0100", email: "" } });
    expect(changeLines(c, r.changes)).toEqual([
      { field: "phone", label: "phone", before: "555-555-0001", after: "555-555-0100" },
      { field: "email", label: "email", before: "ann@example.com", after: "" },
      { field: "zip", label: "ZIP", before: "12301", after: "12302" },
    ]);
    expect(suggestionSummary(r)).toBe("Pat suggested: phone → 555-555-0100, email → (blank), ZIP → 12302");
  });

  it("applies only allow-listed fields, address to the primary address", () => {
    const c = ann();
    const next = applySuggestion(c, {
      phone: "555-555-0100",
      street: "9 Oak Ave",
      customer_type: "commercial",
    } as Record<string, string>);
    expect(next.phone).toBe("555-555-0100");
    expect(next.type).toBe(c.type);
    expect(next.address).toBe("9 Oak Ave");
    expect(next.city).toBe("Anytown");
    expect(next.addresses?.[0]).toMatchObject({ street: "9 Oak Ave", city: "Anytown", isPrimary: true });
    expect(next.addresses).toHaveLength(c.addresses?.length || 1);
    // The original is untouched.
    expect(c.phone).toBe("555-555-0001");
  });

  it("adds a primary address when the customer has none", () => {
    const c: Customer = { ...ann(), addresses: [], address: "", city: "", zip: "" };
    const next = applySuggestion(c, { street: "5 Pine Rd", zip: "12303" });
    expect(next.addresses).toHaveLength(1);
    expect(next.addresses?.[0]).toMatchObject({ street: "5 Pine Rd", zip: "12303", state: "CO", isPrimary: true });
    expect(next.zip).toBe("12303");
  });

  it("lists pending suggestions only, oldest first", () => {
    const list = [
      req({ id: "b", createdAt: "2026-11-16T12:00:00Z" }),
      req({ id: "a", createdAt: "2026-11-16T09:00:00Z" }),
      req({ id: "done", status: "approved" }),
      req({ id: "other", customerId: "c2" }),
    ];
    expect(pendingFor(list, "c1").map((r) => r.id)).toEqual(["a", "b"]);
    expect(pendingAll(list).map((r) => r.id)).toEqual(["a", "other", "b"]);
    expect(pendingFor(undefined, "c1")).toEqual([]);
  });

  it("reads database rows", () => {
    const r = customerEditRequestFromRow({
      id: "u1",
      customer_id: "c1",
      requested_by: "e-pat",
      requested_name: "Pat",
      created_at: "2026-11-16T10:00:00+00:00",
      changes: { phone: "1", bad: 3 },
      note: null,
      status: "declined",
      decided_by: "Sam",
      decided_at: "2026-11-16T11:00:00+00:00",
    });
    expect(r).toMatchObject({ customerId: "c1", changes: { phone: "1" }, note: "", status: "declined", decidedBy: "Sam" });
  });
});

describe("suggestion follow-ups", () => {
  it("takes every kind of note: gate code, property notes, general notes", () => {
    const c = { ...ann(), propertyNotes: "Big dog", notes: "" };
    const v = currentValues(c);
    expect(v.gate_code).toBe("1234");
    expect(v.property_notes).toBe("Big dog");
    const form = { ...v, gate_code: "#4321", property_notes: "Big dog. Side gate sticks.", notes: "Prefers texts" };
    expect(diffSuggestion(c, form)).toEqual({
      gate_code: "#4321",
      property_notes: "Big dog. Side gate sticks.",
      notes: "Prefers texts",
    });
    const next = applySuggestion(c, diffSuggestion(c, form));
    expect(next.gateCode).toBe("#4321");
    expect(next.propertyNotes).toBe("Big dog. Side gate sticks.");
    expect(next.notes).toBe("Prefers texts");
    expect(sanitizeChanges({ property_notes: "p".repeat(5000) }).property_notes).toHaveLength(4000);
    expect(sanitizeChanges({ gate_code: "9".repeat(300) }).gate_code).toHaveLength(200);
  });

  it("sends the office's changes only when they differ from the suggestion", () => {
    const suggested = { phone: "555-555-0100", zip: "12302" };
    expect(approvalChanges(suggested, { phone: "555-555-0100", zip: "12302" })).toBeNull();
    expect(approvalChanges(suggested, { phone: " 555-555-0100 ", zip: "12302" })).toBeNull();
    expect(approvalChanges(suggested, { phone: "555-555-0199", zip: "12302" })).toEqual({
      phone: "555-555-0199",
      zip: "12302",
    });
    // A field the office unticks is not applied; extra keys are ignored.
    expect(approvalChanges(suggested, { phone: "555-555-0100", zip: "12302", email: "x@y.z" }, new Set(["phone"]))).toEqual({
      phone: "555-555-0100",
    });
    expect(approvalChanges(suggested, {}, new Set())).toEqual({});
  });

  it("reads approved-with-changes and declined-with-reason for the Sales person", () => {
    expect(decisionText(req({ status: "approved", appliedChanges: { phone: "555-555-0100" } }))).toBe("Approved");
    expect(decisionText(req({ status: "approved", appliedChanges: null }))).toBe("Approved");
    expect(decisionText(req({ status: "approved", appliedChanges: { phone: "555-555-0199" } }))).toBe(
      "Approved with changes: phone → 555-555-0199",
    );
    expect(decisionText(req({ status: "declined", declineReason: "We have a newer number" }))).toBe(
      "Declined: We have a newer number",
    );
    expect(decisionText(req({ status: "declined" }))).toBe("Declined (no reason given)");
    expect(changesText({ zip: "", gate_code: "1" })).toBe("ZIP → (blank), gate code → 1");
  });

  it("keeps decided suggestions 30 days, newest first", () => {
    const now = new Date("2026-12-20T12:00:00Z");
    const list = [
      req({ id: "old", status: "declined", decidedAt: "2026-11-10T12:00:00Z" }),
      req({ id: "a", status: "approved", decidedAt: "2026-12-01T12:00:00Z" }),
      req({ id: "b", status: "declined", decidedAt: "2026-12-19T12:00:00Z" }),
      req({ id: "wait" }),
      req({ id: "other", customerId: "c2", status: "approved", decidedAt: "2026-12-18T12:00:00Z" }),
    ];
    expect(recentDecided(list, now).map((r) => r.id)).toEqual(["b", "other", "a"]);
    expect(recentDecided(list, now, "c1").map((r) => r.id)).toEqual(["b", "a"]);
    expect(recentDecided(undefined, now)).toEqual([]);
  });

  it("reads the decline reason and applied values from database rows", () => {
    const r = customerEditRequestFromRow({
      id: "u2",
      customer_id: "c1",
      requested_name: "Pat",
      created_at: "2026-11-16T10:00:00+00:00",
      changes: { phone: "1" },
      status: "approved",
      decided_at: "2026-11-16T11:00:00+00:00",
      decline_reason: "",
      applied_changes: { phone: "2", bad: 3 },
    });
    expect(r.appliedChanges).toEqual({ phone: "2" });
    expect(r.declineReason).toBe("");
    expect(customerEditRequestFromRow({ id: "u3", status: "pending" }).appliedChanges).toBeNull();
  });
});
