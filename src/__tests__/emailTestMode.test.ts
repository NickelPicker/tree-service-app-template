import { describe, expect, it } from "vitest";
import { parseRecipients, recipientAllowed } from "../../supabase/functions/_shared/testMode";

const BIZ = "business@example.com";

describe("email test mode", () => {
  it("is on by default: only the business Gmail and the test list get emails", () => {
    expect(recipientAllowed("business@example.com", undefined, BIZ, "")).toBe(true);
    expect(recipientAllowed("Owner@Example.com", "", BIZ, "owner@example.com")).toBe(true);
    expect(recipientAllowed("customer@example.com", undefined, BIZ, "owner@example.com")).toBe(false);
    expect(recipientAllowed("customer@example.com", "on", BIZ, "")).toBe(false);
  });
  it("every address in a multi-address To must be allowed", () => {
    expect(recipientAllowed("owner@example.com, customer@example.com", "on", BIZ, "owner@example.com")).toBe(false);
    expect(recipientAllowed("", "on", BIZ, "")).toBe(false);
  });
  it("only exactly 'off' turns it off", () => {
    expect(recipientAllowed("customer@example.com", "off", BIZ, "")).toBe(true);
    expect(recipientAllowed("customer@example.com", " OFF ", BIZ, "")).toBe(true);
    expect(recipientAllowed("customer@example.com", "false", BIZ, "")).toBe(false);
  });
  it("parses the list", () => {
    expect(parseRecipients(" a@b.co, ,C@D.co ")).toEqual(["a@b.co", "c@d.co"]);
    expect(parseRecipients(null)).toEqual([]);
  });
});
