import { describe, expect, it } from "vitest";
import { setupChecklist, setupToDo } from "../setupChecklist";
import type { CompanyDocument, CompanyProfile } from "../types";
import { baseState, equip, person } from "../planner/__tests__/fixtures";

const TODAY = "2026-11-17";

const company = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  name: "Your Tree Company",
  phone: "555-555-0100",
  email: "office@example.com",
  smsNumber: "",
  logoDataUrl: null,
  ownerEmail: "owner@example.com",
  sites: [{ label: "Shop", address: "1 Yard Rd", lat: null, lng: null }],
  zelleNumber: "555-555-0100",
  checkPayee: "",
  checkMailingAddress: "",
  reviewUrl: "https://g.page/r/abc/review",
  ...over,
});

const insurance = (over: Partial<CompanyDocument> = {}): CompanyDocument => ({
  id: "d1",
  kind: "liability_insurance",
  name: "GL-1",
  crewId: null,
  issuer: "",
  startDate: null,
  expiryDate: "2027-06-01",
  notes: "",
  fileId: "f1",
  fileName: "gl.pdf",
  ...over,
} as CompanyDocument);

function done() {
  const s = baseState({
    equipment: [equip("t1", "Truck", { weightLbs: 14000, homeSite: "1 Yard Rd" }), equip("c1", "Chipper", { homeSite: "1 Yard Rd", weightLbs: 3000 })],
    crew: [person("gus", ["ground_work"])],
    companyDocuments: [insurance()],
  });
  s.settings = { ...s.settings, company: company() };
  return s;
}

const ids = (state: ReturnType<typeof done>, gmailReady: boolean | null = null) =>
  setupToDo(setupChecklist({ state, today: TODAY, gmailReady })).map((i) => i.id);

describe("Finish setting up", () => {
  it("is empty (the card hides) when everything is done", () => {
    expect(ids(done())).toEqual([]);
    expect(ids(done(), true)).toEqual([]);
  });

  it("lists everything for a brand-new company", () => {
    const s = baseState({ crew: [person("gus", [])], equipment: [equip("t1", "Truck")] });
    expect(ids(s as ReturnType<typeof done>)).toEqual([
      "company", "pay", "review", "site", "truckWeights", "parkedAt", "skills", "insurance",
    ]);
  });

  it("company details need name, phone and email", () => {
    const s = done();
    s.settings = { ...s.settings, company: company({ phone: " ", email: "" }) };
    const item = setupChecklist({ state: s, today: TODAY, gmailReady: null }).find((i) => i.id === "company")!;
    expect(item.done).toBe(false);
    expect(item.missing).toBe("Missing phone, email");
  });

  it("how to pay: Zelle or a check payee is enough", () => {
    const s = done();
    s.settings = { ...s.settings, company: company({ zelleNumber: "", checkPayee: "Your Tree Company LLC" }) };
    expect(ids(s)).toEqual([]);
    s.settings = { ...s.settings, company: company({ zelleNumber: "", checkPayee: "" }) };
    expect(ids(s)).toEqual(["pay"]);
  });

  it("review link and a shop with an address", () => {
    const s = done();
    s.settings = { ...s.settings, company: company({ reviewUrl: "", sites: [{ label: "Shop", address: "", lat: null, lng: null }] }) };
    expect(ids(s)).toEqual(["review", "site"]);
  });

  it("every truck in use has a weight; retired ones do not count", () => {
    const s = done();
    s.equipment = [
      ...s.equipment,
      equip("t2", "Truck", { name: "Big Truck", homeSite: "1 Yard Rd", weightLbs: 0 }),
      equip("t3", "Truck", { status: "retired" }),
    ];
    const item = setupChecklist({ state: s, today: TODAY, gmailReady: null }).find((i) => i.id === "truckWeights")!;
    expect(item.done).toBe(false);
    expect(item.missing).toBe("No weight: Big Truck");
    expect(ids(s)).toEqual(["truckWeights"]);
  });

  it("trailers and the chipper need a weight too; other machines do not (business rule)", () => {
    const s = done();
    s.equipment = [
      ...s.equipment,
      equip("tr", "Trailer", { name: "Flatbed", homeSite: "1 Yard Rd" }),
      equip("dt", "Dump trailer", { name: "Dumpy", homeSite: "1 Yard Rd" }),
      equip("et", "Equipment trailer", { name: "Lowboy", homeSite: "1 Yard Rd", weightLbs: 2500 }),
      equip("c2", "Chipper", { name: "Bandit", homeSite: "1 Yard Rd" }),
      equip("sk", "Mini skid", { name: "Dingo", homeSite: "1 Yard Rd" }),
      equip("sg", "Stump grinder", { name: "Grinder", homeSite: "1 Yard Rd" }),
      equip("ot", "Other", { name: "Saw", homeSite: "1 Yard Rd" }),
      equip("old", "Trailer", { name: "Old", homeSite: "1 Yard Rd", status: "retired" }),
    ];
    const item = setupChecklist({ state: s, today: TODAY, gmailReady: null }).find((i) => i.id === "truckWeights")!;
    expect(item.label).toBe("Every truck, trailer and chipper in use has a weight");
    expect(item.missing).toBe("No weight: Flatbed, Dumpy, Bandit");
    expect(ids(s)).toEqual(["truckWeights"]);
  });

  it("every machine has Parked at", () => {
    const s = done();
    s.equipment = [...s.equipment, equip("x", "Trailer", { name: "Dump", homeSite: null, weightLbs: 2000 })];
    expect(ids(s)).toEqual(["parkedAt"]);
  });

  it("crew on the Skills grid need a skill; pending, removed and hidden people do not count", () => {
    const s = done();
    s.crew = [
      ...s.crew,
      person("new", [], { status: "pending" }),
      person("gone", [], { status: "revoked" }),
      person("hidden", [], { permissions: { hideFromSchedule: true } } as never),
    ];
    expect(ids(s)).toEqual([]);
    // Office staff are left out (business rule).
    s.crew = [
      ...s.crew,
      person("own", [], { appRole: "owner" }),
      person("mgr", [], { appRole: "manager" }),
      person("off", [], { appRole: "office" }),
    ];
    expect(ids(s)).toEqual([]);
    s.crew = [...s.crew, person("ann", [], { name: "Ann" })];
    expect(setupChecklist({ state: s, today: TODAY, gmailReady: null }).find((i) => i.id === "skills")!.missing).toBe(
      "No skills: Ann",
    );
  });

  it("liability insurance must be uploaded, for the business, and not expired", () => {
    const s = done();
    s.companyDocuments = [insurance({ fileId: null })];
    expect(ids(s)).toEqual(["insurance"]);
    s.companyDocuments = [insurance({ expiryDate: "2026-11-01" })];
    expect(ids(s)).toEqual(["insurance"]);
    s.companyDocuments = [insurance({ crewId: "gus" })];
    expect(ids(s)).toEqual(["insurance"]);
    s.companyDocuments = [insurance({ kind: "auto_insurance" })];
    expect(ids(s)).toEqual(["insurance"]);
  });

  it("Gmail is listed only when the app knows", () => {
    const s = done();
    expect(setupChecklist({ state: s, today: TODAY, gmailReady: null }).some((i) => i.id === "gmail")).toBe(false);
    expect(ids(s, false)).toEqual(["gmail"]);
    expect(ids(s, true)).toEqual([]);
  });

  it("each item has a how-to and a page", () => {
    for (const i of setupChecklist({ state: baseState() as ReturnType<typeof done>, today: TODAY, gmailReady: false })) {
      expect(i.how.length).toBeGreaterThan(10);
      expect(i.view).toBeTruthy();
      expect(i.button).toBeTruthy();
    }
  });
});
