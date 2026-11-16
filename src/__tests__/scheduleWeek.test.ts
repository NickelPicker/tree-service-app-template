import { describe, expect, it } from "vitest";
import { defaultCalendarView, weekLabel, weekOf } from "../scheduleWeek";

describe("This week list", () => {
  it("runs Sunday to Saturday around the chosen day, like the month grid", () => {
    expect(weekOf("2026-11-18")).toEqual([
      "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21",
    ]);
    // A Sunday starts its own week (today's jobs and the week ahead).
    expect(weekOf("2026-11-15")[0]).toBe("2026-11-15");
    expect(weekOf("2026-11-21")[0]).toBe("2026-11-15");
    // Across a month end.
    expect(weekOf("2026-12-01")[0]).toBe("2026-11-29");
  });
  it("labels the week in plain words", () => {
    expect(weekLabel(weekOf("2026-11-18"))).toBe("Sun, Nov 15 – Sat, Nov 21");
  });
  it("starts phones on the week list", () => {
    expect(defaultCalendarView(390)).toBe("week");
    expect(defaultCalendarView(1366)).toBe("month");
  });
});
