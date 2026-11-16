import { describe, expect, it } from "vitest";
import {
  composeSuggestionEmail,
  fieldChanges,
  FIELDS,
  notifyRefusal,
  RECENT_MS,
} from "../../supabase/functions/notify-suggestion/compose.ts";
import { FIELD_LABELS, SUGGESTABLE_FIELDS } from "../customerEdits";

const ann = {
  id: "c1",
  first_name: "Ann",
  last_name: "Smith",
  company: "",
  phone: "555-555-0001",
  email: "ann@example.com",
  address: "1 Elm St",
  city: "Anytown",
  zip: "12301",
  gate_code: "1234",
  property_notes: "Big dog",
  notes: "",
};

describe("notify-suggestion email", () => {
  it("uses the same fields, in the same order, as the app", () => {
    expect(FIELDS.map(([k]) => k)).toEqual([...SUGGESTABLE_FIELDS]);
    for (const [k, label] of FIELDS) {
      expect(label.toLowerCase()).toBe(FIELD_LABELS[k as keyof typeof FIELD_LABELS].toLowerCase());
    }
  });

  it("lists before → after from the primary address and the customer row", () => {
    const lines = fieldChanges(
      { zip: "12302", phone: "555-555-0100", gate_code: "", company_id: "x", city: 5 },
      ann,
      { street: "1 Elm St", city: "Anytown", state: "CO", zip: "12301" },
    );
    expect(lines).toEqual([
      { key: "phone", label: "Phone", before: "555-555-0001", after: "555-555-0100" },
      { key: "zip", label: "ZIP", before: "12301", after: "12302" },
      { key: "gate_code", label: "Gate code", before: "1234", after: "" },
    ]);
    expect(fieldChanges(null, ann, null)).toEqual([]);
    expect(fieldChanges({ state: "WY" }, ann, null)[0].before).toBe("CO");
  });

  it("says who, which customer, the changes, the note and how to approve", () => {
    const m = composeSuggestionEmail({
      suggestion: { requested_name: "Pat", changes: { phone: "555-555-0100", property_notes: "Big dog\nSide gate" }, note: "Got it on site" },
      customer: ann,
      address: null,
      appUrl: "https://example.netlify.app",
    });
    expect(m.subject).toBe("Suggested change: Ann Smith (from Pat)");
    expect(m.text).toContain("Pat suggested a change to Ann Smith.");
    expect(m.text).toContain("Phone: 555-555-0001 → 555-555-0100");
    expect(m.text).toContain("Property notes: Big dog → Big dog\nSide gate");
    expect(m.text).toContain("Note from Pat: Got it on site");
    expect(m.text).toContain("Open the app (https://example.netlify.app)");
    expect(m.text).toContain("approve");
    expect(m.html).toContain('<a href="https://example.netlify.app">');
    expect(m.html).toContain("Big dog<br>Side gate");
  });

  it("escapes everything in the HTML and keeps the subject on one line", () => {
    const m = composeSuggestionEmail({
      suggestion: {
        requested_name: "<b>Pat</b>\nBcc: x@y.z",
        changes: { notes: `<script>alert("x")</script>`, company: "A & B's" },
        note: "<img src=x onerror=alert(1)>",
      },
      customer: { ...ann, first_name: "<i>Ann</i>" },
      address: null,
      appUrl: 'javascript:alert(1)"',
    });
    expect(m.html).not.toMatch(/<script|<img|<i>|<b>|javascript:/);
    expect(m.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(m.html).toContain("A &amp; B&#39;s");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).not.toContain("javascript:");
  });

  it("holds nothing but that customer's name and the suggested fields", () => {
    const m = composeSuggestionEmail({
      suggestion: { requested_name: "Pat", changes: { phone: "555-555-0100" }, note: "" },
      // Extra columns (other people on a commercial account, map data)
      // are never read into the email.
      customer: {
        ...ann,
        contacts: [{ name: "Other Person", email: "other@example.com" }],
        boundary: [[1, 2]],
      } as unknown as typeof ann,
      address: { street: "1 Elm St", city: "Anytown", state: "CO", zip: "12301" },
    });
    const all = m.subject + m.text + m.html;
    expect(all).not.toContain("Other Person");
    expect(all).not.toContain("other@example.com");
    expect(all).not.toContain("ann@example.com");
    expect(all).not.toContain("1 Elm St");
    expect(all).not.toContain("1234");
    expect(all).not.toContain("Big dog");
    expect(m.text).not.toContain("Note from");
  });

  it("only the author of a fresh, pending suggestion may ask for the email", () => {
    const now = Date.parse("2026-11-16T10:05:00Z");
    const row = { requested_user: "u-pat", status: "pending", created_at: "2026-11-16T10:00:00Z" };
    expect(notifyRefusal(row, "u-pat", now)).toBe("");
    expect(notifyRefusal(row, "u-sam", now)).toBe("not-allowed");
    expect(notifyRefusal(null, "u-pat", now)).toBe("not-allowed");
    expect(notifyRefusal({ ...row, requested_user: null }, "", now)).toBe("not-allowed");
    expect(notifyRefusal({ ...row, status: "approved" }, "u-pat", now)).toBe("decided");
    expect(notifyRefusal(row, "u-pat", Date.parse("2026-11-16T10:00:00Z") + RECENT_MS + 1)).toBe("too-old");
    expect(notifyRefusal({ ...row, created_at: "garbage" }, "u-pat", now)).toBe("too-old");
  });
});
