import { describe, expect, it, vi } from "vitest";
import {
  composeDayPlanEmails,
  jobAddress,
  mapsLink,
  niceTime,
  weekdayDate,
  type DayPlanInput,
  type JobRow,
} from "../../supabase/functions/send-day-plan/compose.ts";
import { dayPlanEmailMessage, emailCrewOnSave, emailDayPlan, parseDayPlanReply } from "../dayPlanEmail";

// Demo mode: no Supabase client.
vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const DATE = "2026-11-16"; // a Monday

function job(id: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id,
    title: `Job ${id}`,
    date: DATE,
    start_time: "08:00",
    customer_id: "c1",
    crew_ids: [],
    ...over,
  };
}

function input(over: Partial<DayPlanInput> = {}): DayPlanInput {
  return {
    date: DATE,
    jobs: [],
    crew: [
      { id: "a", name: "Alex Smith", email: "alex@example.com" },
      { id: "b", name: "Bo Lee", email: "bo@example.com" },
      { id: "c", name: "Cy", email: null },
    ],
    equipment: [
      { id: "t1", name: "Big truck" },
      { id: "ch", name: "Chipper" },
    ],
    customers: [{ id: "c1", address: "1 Old Rd", city: "Anytown", zip: "12319" }],
    addresses: [],
    ...over,
  };
}

describe("day plan email text", () => {
  it("formats the date and times in plain English", () => {
    expect(weekdayDate(DATE)).toBe("Monday, November 16");
    expect(niceTime("07:30")).toBe("7:30 AM");
    expect(niceTime("13:05")).toBe("1:05 PM");
    expect(niceTime("00:15")).toBe("12:15 AM");
    expect(niceTime(null)).toBe("");
  });

  it("sends one email per person on a job, skipping people with no email", () => {
    const r = composeDayPlanEmails(
      input({
        jobs: [
          job("j1", { crew_ids: ["a", "b"] }),
          job("j2", { crew_ids: ["a", "c"], start_time: "13:00" }),
          job("other-day", { date: "2026-11-17", crew_ids: ["b"] }),
        ],
      }),
    );
    expect(r.emails.map((e) => e.to)).toEqual(["alex@example.com", "bo@example.com"]);
    expect(r.skippedNoEmail).toBe(1);
    expect(r.emails[0].subject).toBe("Your day — Monday, November 16");
  });

  it("lists stops in arrival order using each person's own arrival time", () => {
    const r = composeDayPlanEmails(
      input({
        jobs: [
          job("late", { crew_ids: ["a"], start_time: "07:00", crew_arrivals: { a: "12:30" }, title: "Oak removal" }),
          job("early", { crew_ids: ["a", "b"], start_time: "09:00", title: "Maple trim" }),
        ],
      }),
    );
    const text = r.emails.find((e) => e.crewId === "a")!.text;
    expect(text.indexOf("9:00 AM — Maple trim")).toBeGreaterThan(-1);
    expect(text.indexOf("12:30 PM — Oak removal")).toBeGreaterThan(text.indexOf("Maple trim"));
    expect(text).toContain("Hi Alex,");
    expect(text).toContain("With: Bo Lee");
    expect(text).toContain("With: Just you");
    expect(text.trim().endsWith("Open the app for details.")).toBe(true);
  });

  it("shows what the person drives, team notes, the address and a directions link", () => {
    const r = composeDayPlanEmails(
      input({
        jobs: [
          job("j1", {
            crew_ids: ["a", "b"],
            equipment_drivers: { t1: "a", ch: "a" },
            team_notes: "Gate on the left",
          }),
        ],
      }),
    );
    const a = r.emails.find((e) => e.crewId === "a")!;
    const b = r.emails.find((e) => e.crewId === "b")!;
    expect(a.text).toContain("You drive: Big truck, Chipper");
    expect(b.text).not.toContain("You drive");
    expect(a.text).toContain("Team notes: Gate on the left");
    expect(a.text).toContain("Where: 1 Old Rd, Anytown, 12319");
    expect(a.text).toContain(
      "https://www.google.com/maps/dir/?api=1&destination=1%20Old%20Rd%2C%20Anytown%2C%2012319",
    );
    expect(a.html).toContain("Directions in Google Maps");
  });

  it("includes a multi-day job on its middle days", () => {
    const r = composeDayPlanEmails(
      input({ jobs: [job("big", { date: "2026-11-15", end_date: "2026-11-17", crew_ids: ["a"] })] }),
    );
    expect(r.emails).toHaveLength(1);
  });

  it("uses the job's chosen address, else the primary one, else the pin", () => {
    const addresses = [
      { id: "home", customer_id: "c1", street: "5 Elm St", city: "Anytown", state: "CO", zip: "12320", is_primary: true },
      { id: "rental", customer_id: "c1", street: "9 Pine Ave", city: "Springfield", state: "CO", zip: "12400", is_primary: false },
    ];
    expect(jobAddress(job("j", { address_id: "rental" }), [], addresses)).toBe("9 Pine Ave, Springfield, CO, 12400");
    expect(jobAddress(job("j"), [], addresses)).toBe("5 Elm St, Anytown, CO, 12320");
    const pinned = job("j", { customer_id: null, lat: 39.7, lng: -104.9 });
    expect(mapsLink(jobAddress(pinned, [], []), pinned)).toContain("destination=39.7%2C-104.9");
    expect(mapsLink("", job("j"))).toBe("");
  });

  it("escapes HTML in the html version", () => {
    const r = composeDayPlanEmails(
      input({ jobs: [job("j1", { crew_ids: ["a"], title: "<b>Oops</b>", team_notes: "a & b" })] }),
    );
    expect(r.emails[0].html).toContain("&lt;b&gt;Oops&lt;/b&gt;");
    expect(r.emails[0].html).toContain("a &amp; b");
    expect(r.emails[0].text).toContain("<b>Oops</b>");
  });
});

describe("day plan email client", () => {
  it("is off unless the owner turned it on", () => {
    expect(emailCrewOnSave(undefined)).toBe(false);
    expect(emailCrewOnSave({})).toBe(false);
    expect(emailCrewOnSave({ emailCrewOnSave: true })).toBe(true);
  });

  it("reads only counts and a reason from the reply", () => {
    expect(parseDayPlanReply({ sent: 4, skipped: 1, extra: "x" })).toEqual({ sent: 4, skipped: 1 });
    expect(parseDayPlanReply({ sent: 0, reason: "gmail-not-set-up" })).toEqual({
      sent: 0,
      skipped: 0,
      reason: "gmail-not-set-up",
    });
    expect(parseDayPlanReply(null).reason).toBe("error");
  });

  it("writes a plain-English message", () => {
    expect(dayPlanEmailMessage({ sent: 4, skipped: 0 })).toBe("Emailed 4 people their day");
    expect(dayPlanEmailMessage({ sent: 1, skipped: 2 })).toBe(
      "Emailed 1 person their day (2 people skipped: no email saved)",
    );
    expect(dayPlanEmailMessage({ sent: 0, skipped: 0, reason: "demo" })).toMatch(/Demo/);
  });

  it("emailDayPlan sends nothing in demo mode", async () => {
    expect(await emailDayPlan(DATE)).toEqual({ sent: 0, skipped: 0, reason: "demo" });
  });
});
