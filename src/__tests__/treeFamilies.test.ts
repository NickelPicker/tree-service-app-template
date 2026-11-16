import { describe, expect, it } from "vitest";
import { familiesForHosts } from "../treeFamilies";
import { PHC_SERVICES } from "../phcSchedule";

describe("tree families for PHC", () => {
  it("puts each host in its family", () => {
    expect(familiesForHosts("Aspen, cottonwood, maple, willow")).toEqual(["willow", "soapberry"]);
    expect(familiesForHosts("Apple, crabapple, hawthorn, mountain ash, pear")).toEqual(["rose"]);
    expect(familiesForHosts("Ash")).toEqual(["olive"]);
    expect(familiesForHosts("Pine, spruce, juniper")).toEqual(["pine", "cypress"]);
    expect(familiesForHosts("Apple, crabapple, hawthorn, juniper")).toEqual(["cypress", "rose"]);
    expect(familiesForHosts("Everything")).toEqual(["general"]);
    expect(familiesForHosts("Scotch pine")).toEqual(["pine"]);
  });
  it("every catalog service lands in at least one family", () => {
    for (const s of PHC_SERVICES) expect(familiesForHosts(s.hosts).length).toBeGreaterThan(0);
  });
});
