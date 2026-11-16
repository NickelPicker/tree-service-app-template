import { describe, expect, it } from "vitest";
import { businessDaysAfter, businessToday, isPastDueForOffice, OVERDUE_BUSINESS_DAYS } from "../overdueInvoice";

describe("overdue = unpaid 10 business days past the due date", () => {
  it("is 10 business days", () => {
    expect(OVERDUE_BUSINESS_DAYS).toBe(10);
  });

  it("counts Monday to Friday only, after the due date", () => {
    // Mon 2 Nov 2026 -> Fri 6 Nov: Tue..Fri = 4
    expect(businessDaysAfter("2026-11-02", "2026-11-06")).toBe(4);
    // weekend adds nothing
    expect(businessDaysAfter("2026-11-06", "2026-11-08")).toBe(0);
    expect(businessDaysAfter("2026-11-06", "2026-11-09")).toBe(1);
    expect(businessDaysAfter("2026-11-02", "2026-11-02")).toBe(0);
    expect(businessDaysAfter("2026-11-10", "2026-11-02")).toBe(0);
    expect(businessDaysAfter("", "2026-11-02")).toBe(0);
  });

  it("exactly 10 business days is overdue, 9 is not", () => {
    // Due Mon 2 Nov: Fri 13 Nov = 9, Mon 16 Nov = 10.
    expect(businessDaysAfter("2026-11-02", "2026-11-13")).toBe(9);
    expect(isPastDueForOffice("2026-11-02", "2026-11-13")).toBe(false);
    expect(isPastDueForOffice("2026-11-02", "2026-11-14")).toBe(false); // Saturday, still 9
    expect(isPastDueForOffice("2026-11-02", "2026-11-15")).toBe(false); // Sunday, still 9
    expect(businessDaysAfter("2026-11-02", "2026-11-16")).toBe(10);
    expect(isPastDueForOffice("2026-11-02", "2026-11-16")).toBe(true);
    expect(isPastDueForOffice("2026-11-02", "2026-12-01")).toBe(true);
  });

  it("a due date on a weekend starts counting on Monday", () => {
    // Due Sat 7 Nov: Mon 9 .. Fri 20 Nov = 10.
    expect(isPastDueForOffice("2026-11-07", "2026-11-19")).toBe(false);
    expect(isPastDueForOffice("2026-11-07", "2026-11-20")).toBe(true);
  });

  it("calendar days past due are not enough", () => {
    // 10 calendar days, only 8 business days.
    expect(isPastDueForOffice("2026-11-02", "2026-11-12")).toBe(false);
  });

  it("no due date is never overdue by date", () => {
    expect(isPastDueForOffice("", "2026-11-16")).toBe(false);
    expect(isPastDueForOffice(null, "2026-11-16")).toBe(false);
  });

  it("today is the Denver date", () => {
    // 03:00 UTC on 17 Nov is still the evening of 16 Nov in Denver.
    expect(businessToday(new Date("2026-11-17T03:00:00Z"))).toBe("2026-11-16");
    expect(businessToday(new Date("2026-11-17T08:00:00Z"))).toBe("2026-11-17");
  });
});
