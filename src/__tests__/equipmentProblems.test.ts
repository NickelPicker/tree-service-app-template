import { describe, expect, it } from "vitest";
import {
  myProblems,
  openProblems,
  problemNoteProblem,
  problemStatusLabel,
  recentlyFixedFor,
  statusAfter,
  unresolvedFor,
} from "../equipmentProblems";
import type { EquipmentProblem } from "../types";

const p = (id: string, over: Partial<EquipmentProblem> = {}): EquipmentProblem => ({
  id,
  equipmentId: "chip",
  note: "x",
  status: "open",
  hasPhoto: false,
  reportedBy: "gus",
  reportedName: "Gus",
  createdAt: `2026-11-1${id.slice(-1)}T10:00:00Z`,
  statusByName: null,
  statusAt: null,
  ...over,
});

describe("equipment problems", () => {
  it("needs some text, at most 1000 characters", () => {
    expect(problemNoteProblem("  ")).toMatch(/Say what is wrong/);
    expect(problemNoteProblem("x".repeat(1001))).toMatch(/1000/);
    expect(problemNoteProblem(" Belt squeals ")).toBeNull();
  });

  it("open list is oldest first; per machine lists open and in-the-shop, newest first", () => {
    const list = [p("p3"), p("p1"), p("p2", { status: "in_shop" }), p("p4", { status: "fixed", statusAt: "2026-11-15T00:00:00Z" }), p("p5", { equipmentId: "truck" })];
    expect(openProblems(list).map((x) => x.id)).toEqual(["p1", "p3", "p5"]);
    expect(unresolvedFor(list, "chip").map((x) => x.id)).toEqual(["p3", "p2", "p1"]);
    expect(recentlyFixedFor(list, "chip").map((x) => x.id)).toEqual(["p4"]);
    expect(openProblems(undefined)).toEqual([]);
  });

  it("a person's own reports", () => {
    const list = [p("p1"), p("p2", { reportedBy: "ann" }), p("p3")];
    expect(myProblems(list, "gus").map((x) => x.id)).toEqual(["p3", "p1"]);
  });

  it("labels and office actions", () => {
    expect(problemStatusLabel("in_shop")).toBe("In the shop");
    expect(statusAfter("shop")).toBe("in_shop");
    expect(statusAfter("fixed")).toBe("fixed");
  });
});
