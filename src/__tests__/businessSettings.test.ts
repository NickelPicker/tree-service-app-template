import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS_TIME_ZONE, OVERTIME_RULES } from "../businessSettings";
import { CLOCK_TZ } from "../clockTime";
import { weekOvertime } from "../overtime";
import { TIME_ZONE } from "../../supabase/functions/run-automations/plan.ts";

// The business's location settings (README: "Your location: time zone
// and overtime"). The app, the edge functions and the database must use
// the same time zone.

describe("business time zone", () => {
  it("is a real IANA time zone", () => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE })).not.toThrow();
  });

  it("the clock taps and the automatic emails use it", () => {
    expect(CLOCK_TZ).toBe(BUSINESS_TIME_ZONE);
    expect(TIME_ZONE).toBe(BUSINESS_TIME_ZONE);
  });

  it("the database's public.business_time_zone() says the same (newest migration wins)", () => {
    const dir = resolve(__dirname, "../../supabase/migrations");
    let value = "";
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      // Line comments removed: the baseline's header shows an example.
      const sql = readFileSync(resolve(dir, f), "utf8").replace(/--.*$/gm, "");
      const re = /FUNCTION public\.business_time_zone\(\)\s+RETURNS text[^;]*?AS \$\$\s*SELECT '([^']+)'/g;
      for (const m of sql.matchAll(re)) value = m[1];
    }
    expect(value).toBe(BUSINESS_TIME_ZONE);
  });
});

describe("overtime rules setting", () => {
  const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
  const long = { date: "2026-11-09", clockIn: "06:00", clockOut: "20:00", hours: null };

  it("is one of the built-in rules", () => {
    expect(["colorado", "weekly40"]).toContain(OVERTIME_RULES);
  });

  it("colorado counts a 14-hour day; weekly40 only counts over 40 in the week", () => {
    expect(weekOvertime([long], week, [], "colorado").overtimeHours).toBe(2);
    expect(weekOvertime([long], week, [], "weekly40").overtimeHours).toBe(0);
    const fiftyHours = week.slice(0, 5).map((d) => ({ date: d, clockIn: "07:00", clockOut: "17:00", hours: null }));
    expect(weekOvertime(fiftyHours, week, [], "weekly40")).toMatchObject({ hours: 50, overtimeHours: 10, rules: ["week"] });
  });
});
