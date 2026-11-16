import { describe, expect, it, vi } from "vitest";
import {
  TOKEN_RE,
  acceptUrl,
  cleanName,
  composeEstimateEmail,
  composeOfficeHeadsUp,
  headsUpRecipients,
  estimateChoices,
  isToken,
  parseAcceptRequest,
  siteOrigin,
  tokenFromBytes,
  type CustomerEstimate,
} from "../../supabase/functions/_shared/estimateEmail.ts";
import { acceptTokenFromPath, estimateSendText, parseEstimateSendReply } from "../estimateSend";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const multi: CustomerEstimate = {
  title: "Big maple",
  notes: "Haul away included",
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
  lines: [{ description: "Prune", quantity: 1, unitPrice: 800 }],
  options: [
    { id: "good", label: "Good", description: "Prune only", lines: [{ description: "Prune", quantity: 1, unitPrice: 800 }] },
    { id: "best", label: "Best", description: "Prune and cable", lines: [{ description: "Prune + cable", quantity: 2, unitPrice: 600 }] },
  ],
};
const single: CustomerEstimate = {
  title: "Stump",
  tax_rate: 10,
  discount_type: "fixed",
  discount_value: 50,
  lines: [{ description: "Grind", quantity: 1, unitPrice: 300 }],
  options: [],
};
const company = { name: "Your Tree Company", phone: "555-0100", email: "office@example.com" };
const token = tokenFromBytes(new Uint8Array(32).fill(250));
const link = acceptUrl("https://example.netlify.app", token);

describe("tokens and addresses", () => {
  it("makes 43-character url-safe tokens", () => {
    expect(token).toHaveLength(43);
    expect(TOKEN_RE.test(token)).toBe(true);
    expect(isToken(token)).toBe(true);
    expect(isToken("short")).toBe(false);
    expect(isToken(`${token.slice(0, 42)}/`)).toBe(false);
  });
  it("finds the /accept/<token> path", () => {
    expect(acceptTokenFromPath(`/accept/${token}`)).toBe(token);
    expect(acceptTokenFromPath(`/accept/${token}/`)).toBe(token);
    expect(acceptTokenFromPath("/accept/nope")).toBeNull();
    expect(acceptTokenFromPath("/")).toBeNull();
  });
  it("uses the live site address, else the office's own https address", () => {
    expect(siteOrigin("https://live.netlify.app", "https://evil.example")).toBe("https://live.netlify.app");
    expect(siteOrigin("*", "https://office.example")).toBe("https://office.example");
    expect(siteOrigin("*", "http://localhost:5173")).toBe("http://localhost:5173");
    expect(siteOrigin("*", "javascript:alert(1)")).toBe("");
    expect(siteOrigin("*", null)).toBe("");
  });
});

describe("the accept request", () => {
  it("tidies the name like the database", () => {
    expect(cleanName("  Ann\n  Acorn ")).toBe("Ann Acorn");
    expect(cleanName(42)).toBe("");
  });
  it("checks every field", () => {
    const ok = { token, optionId: "best", name: "Ann Acorn", agree: true, turnstileToken: "t" };
    expect(parseAcceptRequest(ok)).toEqual({ token, optionId: "best", name: "Ann Acorn", turnstileToken: "t" });
    expect(typeof parseAcceptRequest({ ...ok, token: "x" })).toBe("string");
    expect(typeof parseAcceptRequest({ ...ok, name: "A" })).toBe("string");
    expect(typeof parseAcceptRequest({ ...ok, name: "x".repeat(101) })).toBe("string");
    expect(typeof parseAcceptRequest({ ...ok, agree: "yes" })).toBe("string");
    expect(typeof parseAcceptRequest({ ...ok, optionId: "x".repeat(101) })).toBe("string");
  });
});

describe("estimate emails", () => {
  it("lists each option with its total, or the estimate itself", () => {
    expect(estimateChoices(multi).map((c) => [c.id, c.total])).toEqual([
      ["good", 800],
      ["best", 1200],
    ]);
    // $300 - $50 discount = $250, + 10% tax = $275
    expect(estimateChoices(single)).toMatchObject([{ id: "", total: 275 }]);
  });
  it("has the private link in the email but never in the thread copy", () => {
    const m = composeEstimateEmail({ estimate: multi, greeting: "Ann", company, link, expiresAt: "2027-01-14T00:00:00Z" });
    expect(m.subject).toBe("Your estimate: Big maple — from $800");
    expect(m.text).toContain(link);
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain("Review and accept");
    expect(m.text).toContain("Best — Prune and cable: $1,200");
    expect(m.text).toContain("Haul away included");
    expect(m.text).toContain("January 14");
    expect(m.recordText).not.toContain(token);
    // The thread copy: no link and no prices (crew can read the thread).
    expect(m.recordText).toBe("Estimate emailed: Big maple (2 options). The customer got a private link to accept it.");
  });
  it("escapes HTML from the estimate", () => {
    const m = composeEstimateEmail({
      estimate: { ...single, title: "<script>x</script>" },
      greeting: "Ann",
      company,
      link,
      expiresAt: "2027-01-14T00:00:00Z",
    });
    expect(m.html).not.toContain("<script>");
  });
  it("tells only the office, to call and schedule", () => {
    const office = composeOfficeHeadsUp({
      estimate: { ...multi, accepted_option_id: "best" },
      customerName: "Ann Acorn",
      optionLabel: "Best",
      signedBy: "Ann Acorn",
    });
    expect(office.subject).toBe("Ann Acorn accepted Big maple — Best — call to schedule");
    expect(office.text).toContain("To schedule");
    expect(office.text).toContain("Accepted online — call to schedule");
    expect(office.text).toContain("The customer was not emailed.");
  });
});

describe("the app's send result", () => {
  it("reads the reply and says what happened in plain English", () => {
    expect(parseEstimateSendReply({ sent: 1, emailedAt: "2026-11-15T15:00:00Z" })).toEqual({
      sent: 1,
      emailedAt: "2026-11-15T15:00:00Z",
    });
    expect(parseEstimateSendReply(null)).toEqual({ sent: 0, reason: "error" });
    expect(parseEstimateSendReply({ sent: 5 })).toEqual({ sent: 0, reason: "error" });
    expect(estimateSendText({ sent: 1 })).toMatch(/private link/);
    expect(estimateSendText({ sent: 0, reason: "gmail-not-set-up" })).toMatch(/Gmail/);
    expect(estimateSendText({ sent: 0, reason: "no-email" })).toMatch(/no email address/);
  });
});

describe("who hears that a customer accepted", () => {
  it("the business Gmail first, then each manager login once", () => {
    expect(
      headsUpRecipients("business@example.com", [
        "sam@example.com",
        "Sam@Example.com",
        "Business@Example.com",
        "not an email",
        42,
      ]),
    ).toEqual(["business@example.com", "sam@example.com"]);
    expect(headsUpRecipients("business@example.com", null)).toEqual(["business@example.com"]);
  });
});
