import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  base64Length,
  base64ToBytes,
  bytesToBase64,
  cleanFileName,
  documentHolder,
  documentReminders,
  documentStatus,
  documentStatusLabel,
  hasLiabilityInsurance,
  isRenewed,
  sniffType,
  sortDocuments,
  uploadKind,
  uploadProblem,
} from "../companyDocuments";
import type { CompanyDocument, CrewMember } from "../types";
import { ROUTE_VIEWS, formatRoute, parseRoute } from "../route";

const TODAY = "2026-11-15";

function doc(over: Partial<CompanyDocument>): CompanyDocument {
  return {
    id: over.id ?? "d1",
    kind: "liability_insurance",
    name: "",
    crewId: null,
    issuer: "",
    startDate: null,
    expiryDate: null,
    notes: "",
    fileId: null,
    fileName: "",
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}

describe("documentStatus", () => {
  it("is Valid more than 30 days out", () => {
    const s = documentStatus(doc({ expiryDate: "2026-12-16" }), TODAY);
    expect(s).toEqual({ kind: "valid", daysLeft: 31 });
    expect(documentStatusLabel(s)).toBe("Valid");
  });
  it("counts down from 30 days", () => {
    expect(documentStatusLabel(documentStatus(doc({ expiryDate: "2026-12-15" }), TODAY))).toBe("Expires in 30 days");
    expect(documentStatusLabel(documentStatus(doc({ expiryDate: "2026-11-16" }), TODAY))).toBe("Expires in 1 day");
  });
  it("is still good on its expiry day", () => {
    const s = documentStatus(doc({ expiryDate: TODAY }), TODAY);
    expect(s).toEqual({ kind: "expiring", daysLeft: 0 });
    expect(documentStatusLabel(s)).toBe("Expires today");
  });
  it("is Expired the day after", () => {
    const s = documentStatus(doc({ expiryDate: "2026-11-14" }), TODAY);
    expect(s).toEqual({ kind: "expired", daysAgo: 1 });
    expect(documentStatusLabel(s)).toBe("Expired");
  });
  it("handles no expiry date", () => {
    expect(documentStatus(doc({}), TODAY)).toEqual({ kind: "no-expiry" });
  });
  it("crosses the daylight-saving change correctly", () => {
    expect(documentStatus(doc({ expiryDate: "2027-03-20" }), "2027-03-01")).toEqual({ kind: "expiring", daysLeft: 19 });
  });
});

describe("documentReminders", () => {
  it("lists expired and expiring only, most urgent first", () => {
    const docs = [
      doc({ id: "ok", kind: "business_licence", expiryDate: "2027-06-01" }),
      doc({ id: "soon", kind: "workers_comp", expiryDate: "2026-12-01" }),
      doc({ id: "gone", kind: "auto_insurance", expiryDate: "2026-10-01" }),
      doc({ id: "never" }),
      doc({ id: "sooner", expiryDate: "2026-11-20" }),
    ];
    expect(documentReminders(docs, TODAY).map((r) => r.doc.id)).toEqual(["gone", "sooner", "soon"]);
    expect(documentReminders(undefined, TODAY)).toEqual([]);
  });
  it("sorts the list urgent first, no-expiry last", () => {
    const docs = [
      doc({ id: "never", name: "A" }),
      doc({ id: "ok", expiryDate: "2027-06-01" }),
      doc({ id: "gone", expiryDate: "2026-10-01" }),
    ];
    expect(sortDocuments(docs, TODAY).map((d) => d.id)).toEqual(["gone", "ok", "never"]);
  });
});

describe("liability insurance on file", () => {
  it("needs an unexpired general liability document", () => {
    expect(hasLiabilityInsurance({ companyDocuments: [] }, TODAY)).toBe(false);
    expect(hasLiabilityInsurance({ companyDocuments: [doc({ expiryDate: "2026-01-01" })] }, TODAY)).toBe(false);
    expect(hasLiabilityInsurance({ companyDocuments: [doc({ kind: "auto_insurance" })] }, TODAY)).toBe(false);
    expect(hasLiabilityInsurance({ companyDocuments: [doc({ expiryDate: "2027-01-01" })] }, TODAY)).toBe(true);
  });
});

describe("documentHolder", () => {
  const crew = [{ id: "c1", name: "Cal Climber" }] as CrewMember[];
  it("names the business, the person, or a removed person", () => {
    expect(documentHolder({ crewId: null }, crew)).toBe("The business");
    expect(documentHolder({ crewId: "c1" }, crew)).toBe("Cal Climber");
    expect(documentHolder({ crewId: "gone" }, crew)).toBe("Former team member");
  });
});

describe("uploads", () => {
  it("accepts PDF, JPG, PNG and HEIC, by type or extension", () => {
    expect(uploadKind({ name: "a.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(uploadKind({ name: "a.JPG", type: "" })).toBe("image/jpeg");
    expect(uploadKind({ name: "IMG_1.HEIC", type: "" })).toBe("heic");
    expect(uploadKind({ name: "IMG_1.heic", type: "image/heic" })).toBe("heic");
    expect(uploadKind({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(uploadKind({ name: "a.svg", type: "image/svg+xml" })).toBeNull();
    expect(uploadKind({ name: "a.html", type: "text/html" })).toBeNull();
    expect(uploadKind({ name: "a.pdf", type: "text/html" })).toBeNull();
  });
  it("refuses a PDF over 5 MB but lets big photos through to be shrunk", () => {
    expect(uploadProblem({ name: "a.pdf", type: "application/pdf", size: MAX_FILE_BYTES })).toBeNull();
    expect(uploadProblem({ name: "a.pdf", type: "application/pdf", size: MAX_FILE_BYTES + 1 })).toMatch(/limit is 5 MB/);
    expect(uploadProblem({ name: "a.jpg", type: "image/jpeg", size: MAX_FILE_BYTES * 3 })).toBeNull();
    expect(uploadProblem({ name: "a.doc", type: "application/msword", size: 10 })).toMatch(/Only PDF/);
    expect(uploadProblem({ name: "a.pdf", type: "application/pdf", size: 0 })).toMatch(/empty/);
  });
  it("recognises files by their first bytes", () => {
    expect(sniffType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffType(new TextEncoder().encode("<html>"))).toBeNull();
  });
  it("base64 matches the database's length rule and round-trips", () => {
    for (const n of [1, 2, 3, 4, 100, 70000]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) % 256);
      const b64 = bytesToBase64(bytes);
      expect(b64.length).toBe(base64Length(n));
      expect(b64.length).toBe(Math.floor((n + 2) / 3) * 4);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
    // The DB's limit on the stored text for a 5 MB file.
    expect(base64Length(MAX_FILE_BYTES)).toBe(6990508);
  });
  it("cleans file names and fixes the extension", () => {
    expect(cleanFileName("IMG_0001.HEIC", "image/jpeg")).toBe("IMG_0001.jpg");
    expect(cleanFileName("../../etc/<pass>.pdf", "application/pdf")).toBe(".._.._etc_pass_.pdf");
    expect(cleanFileName(".pdf", "application/pdf")).toBe("document.pdf");
  });
});

describe("screen address", () => {
  it("has its own address", () => {
    expect(ROUTE_VIEWS).toContain("documents");
    expect(formatRoute("documents", [])).toBe("#/licences-insurance");
    expect(parseRoute("#/licences-insurance", TODAY)?.view).toBe("documents");
  });
});

describe("a renewed document stops reminding", () => {
  const same = { name: "Policy GL-1", issuer: "Acme Mutual" };
  const old = doc({ id: "old", expiryDate: "2026-11-01", ...same });
  const renewed = doc({ id: "new", expiryDate: "2027-11-01", ...same, name: " policy  gl-1 " });
  it("the old policy leaves the reminders once the new one is added", () => {
    expect(documentReminders([old], TODAY).map((r) => r.doc.id)).toEqual(["old"]);
    expect(documentReminders([old, renewed], TODAY)).toEqual([]);
    expect(isRenewed(old, [old, renewed], TODAY)).toBe(true);
    expect(isRenewed(renewed, [old, renewed], TODAY)).toBe(false);
  });
  it("only the same kind and the same holder count", () => {
    expect(documentReminders([old, doc({ id: "x", kind: "auto_insurance", expiryDate: "2027-11-01", ...same })], TODAY)).toHaveLength(1);
    expect(documentReminders([old, doc({ id: "y", crewId: "gus", expiryDate: "2027-11-01", ...same })], TODAY)).toHaveLength(1);
  });
  it("an expired newer one, or an 'Other' document, does not count", () => {
    expect(documentReminders([old, doc({ id: "z", expiryDate: "2026-11-10", ...same })], TODAY)).toHaveLength(2);
    const a = doc({ id: "a", kind: "other", expiryDate: "2026-11-01" });
    const b = doc({ id: "b", kind: "other", expiryDate: "2027-11-01" });
    expect(documentReminders([a, b], TODAY).map((r) => r.doc.id)).toEqual(["a"]);
  });
  it("two different policies of one kind never silence each other", () => {
    // Auto policy A lapses Dec 1; policy B (another vehicle) runs to June.
    const a = doc({ id: "A", kind: "auto_insurance", name: "Auto 111", issuer: "Acme Mutual", expiryDate: "2026-12-01" });
    const b = doc({ id: "B", kind: "auto_insurance", name: "Auto 222", issuer: "Acme Mutual", expiryDate: "2027-06-01" });
    expect(isRenewed(a, [a, b], TODAY)).toBe(false);
    expect(documentReminders([a, b], TODAY).map((r) => r.doc.id)).toEqual(["A"]);
    // A city and a state licence (different issuers).
    const city = doc({ id: "C", kind: "business_licence", name: "Licence", issuer: "City", expiryDate: "2026-12-01" });
    const st = doc({ id: "S", kind: "business_licence", name: "Licence", issuer: "State", expiryDate: "2027-12-01" });
    expect(isRenewed(city, [city, st], TODAY)).toBe(false);
    // No name and no issuer: nothing to tell them apart, so no match.
    const n1 = doc({ id: "n1", expiryDate: "2026-12-01" });
    const n2 = doc({ id: "n2", expiryDate: "2027-12-01" });
    expect(isRenewed(n1, [n1, n2], TODAY)).toBe(false);
  });
  it("a renewal that is itself expiring soon still reminds once", () => {
    const soon = doc({ id: "soon", expiryDate: "2026-11-30", ...same });
    expect(documentReminders([old, soon], TODAY).map((r) => r.doc.id)).toEqual(["soon"]);
  });
});
