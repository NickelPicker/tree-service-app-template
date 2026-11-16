import { describe, expect, it } from "vitest";
import {
  FIELD_GROUPS,
  fieldGroupsFor,
  OFFICE_GROUPS,
  buildNav,
  groupForView,
  viewForGroup,
} from "../navGroups";
import { applyNavOrder } from "../navOrder";

const OWNER_VIEWS = [
  "dashboard", "customers", "schedule", "pipeline", "phc", "estimates",
  "invoices", "timesheets", "automations", "activity", "messages", "crew",
  "guide", "sales", "equipment", "crew-rules", "portal", "users",
];

describe("main tabs and More", () => {
  it("gives the owner six main tabs and puts the rest under More", () => {
    const nav = buildNav(OWNER_VIEWS, OFFICE_GROUPS);
    expect(nav.main.map((g) => g.label)).toEqual([
      "Dashboard", "Customers", "Schedule", "Sales", "Invoices", "Team",
    ]);
    expect(nav.main.find((g) => g.id === "sales")?.views).toEqual([
      "sales", "estimates", "pipeline",
    ]);
    expect(nav.more).toEqual([
      "phc", "automations", "activity", "messages", "crew", "guide",
      "equipment", "portal",
    ]);
    // Every screen is reachable exactly once.
    const all = [...nav.main.flatMap((g) => g.views), ...nav.more].sort();
    expect(all).toEqual([...OWNER_VIEWS].sort());
  });

  it("gives crew four tabs: Today, Schedule, Equipment, Me", () => {
    const crew = ["dashboard", "schedule", "timesheets", "activity", "messages",
      "crew", "guide", "equipment", "me", "customers"];
    const nav = buildNav(crew, FIELD_GROUPS);
    expect(nav.main.map((g) => g.label)).toEqual(["Today", "Schedule", "Equipment", "Me"]);
    expect(nav.more).toEqual(["dashboard", "activity", "messages", "customers"]);
    // Me holds the hours too, without sub-tabs.
    expect(groupForView(nav, "timesheets")?.id).toBe("me");
    expect(nav.main.find((g) => g.id === "me")?.subTabs).toBe(false);
  });

  it("never shows a screen the role can't see", () => {
    const office = OWNER_VIEWS.filter((v) => v !== "users" && v !== "crew-rules");
    const nav = buildNav(office, OFFICE_GROUPS);
    const team = nav.main.find((g) => g.id === "team");
    // Office can't open People, so the tab is just Timesheets.
    expect(team?.views).toEqual(["timesheets"]);
    expect(team?.label).toBe("Timesheets");
    expect(team?.subTabs).toBe(false);
    expect(nav.main.flatMap((g) => g.views)).not.toContain("users");
  });

  it("remembers the last sub-screen used in a tab", () => {
    const nav = buildNav(OWNER_VIEWS, OFFICE_GROUPS);
    const sales = nav.main.find((g) => g.id === "sales")!;
    expect(viewForGroup(sales, undefined)).toBe("sales");
    expect(viewForGroup(sales, "pipeline")).toBe("pipeline");
    expect(viewForGroup(sales, "users")).toBe("sales");
    expect(groupForView(nav, "portal")).toBeNull();
  });

  it("keeps the saved tab order working for the main row", () => {
    const nav = buildNav(OWNER_VIEWS, OFFICE_GROUPS);
    // An old saved order (from before the More menu) still sorts the
    // tabs it names; unknown ids are ignored.
    const ordered = applyNavOrder(nav.main, ["invoices", "customers", "phc"]);
    expect(ordered.map((g) => g.id)).toEqual([
      "invoices", "customers", "dashboard", "schedule", "sales", "team",
    ]);
  });

  it("gives a crew-login Sales person a Sales tab with the calendar first", () => {
    const sales = ["schedule", "timesheets", "crew", "guide", "equipment", "me",
      "customers", "sales", "estimates"];
    const nav = buildNav(sales, fieldGroupsFor(true));
    expect(nav.main.map((g) => g.label)).toEqual([
      "Today", "Sales", "Schedule", "Equipment", "Me",
    ]);
    expect(nav.main.find((g) => g.id === "sales")?.views).toEqual(["sales", "estimates"]);
    // Other crew keep their four tabs, even with "see money" (Estimates stays under More).
    const groundsman = buildNav(
      ["schedule", "crew", "guide", "equipment", "me", "estimates"],
      fieldGroupsFor(false),
    );
    expect(groundsman.main.map((g) => g.label)).toEqual(["Today", "Schedule", "Equipment", "Me"]);
    expect(groundsman.more).toEqual(["estimates"]);
  });
});
