import { describe, expect, it } from "vitest";
import type { AutomationRule, Customer, Estimate } from "../types";
import type { DrawerTarget } from "../store";
import { dismissFailedSave, hasUnsavedChange, loadArrival, reloadTiming } from "../saveQueue";
import { addressWrite, formatRoute, isAppRoute, mergeDrawers, parseRoute, sameDrawers } from "../route";
import { newJobDate, newJobMissing, nextWorkingDay } from "../jobForm";
import { orderedRules, RULE_ORDER, sampleFor } from "../automationOrder";
import { accessNote, canEditRecords, landsOnDashboard, redirectToToday } from "../permissions";
import { estimateEmailPreview, PREVIEW_LINK } from "../estimatePreview";
import { routeCardSpot } from "../routeCard";

const idle = { pending: false, running: false, blocked: false };

describe("retrying a failed save never overwrites teammates' work", () => {
  it("loads fresh data at once when nothing of ours is waiting", () => {
    expect(hasUnsavedChange(idle)).toBe(false);
    expect(reloadTiming(idle, true)).toBe("now");
    expect(loadArrival(idle, true)).toBe("use");
  });

  it("waits while a failed save is queued (Retry would compare against the new copy)", () => {
    const failed = { pending: true, running: false, blocked: true };
    expect(reloadTiming(failed, true)).toBe("after-save");
    expect(loadArrival(failed, true)).toBe("discard");
  });

  it("waits while a save is queued or being sent", () => {
    expect(reloadTiming({ ...idle, pending: true }, true)).toBe("after-save");
    expect(reloadTiming({ ...idle, running: true }, true)).toBe("after-save");
    expect(loadArrival({ ...idle, running: true }, true)).toBe("discard");
  });

  it("always loads when nothing is on screen yet", () => {
    const failed = { pending: true, running: false, blocked: true };
    expect(reloadTiming(failed, false)).toBe("now");
    expect(loadArrival(failed, false)).toBe("use");
  });
});

describe("crew land on Today only from the default screen", () => {
  it("an address from a link or a reload (a screen chosen on purpose) is kept", () => {
    expect(redirectToToday("crew", "dashboard", false)).toBe(true);
    // UrlSync opened #/schedule first: screen chosen.
    expect(redirectToToday("crew", "dashboard", true)).toBe(false);
    expect(redirectToToday("crew", "schedule", false)).toBe(false);
    expect(redirectToToday("office", "dashboard", false)).toBe(false);
  });
});

describe("discarding a save that keeps failing", () => {
  it("drops the failed save and reloads, so later reloads are not held back for good", () => {
    expect(dismissFailedSave({ pending: true, running: false, blocked: true })).toBe("drop-and-reload");
    // Being sent right now: let it finish; only hide the banner.
    expect(dismissFailedSave({ pending: false, running: true, blocked: true })).toBe("hide");
    expect(dismissFailedSave({ pending: false, running: false, blocked: false })).toBe("hide");
  });
});

describe("web addresses for screens and panels", () => {
  const job: DrawerTarget = { kind: "job", jobId: "j9", defaultDate: "2026-11-16" };
  const customer: DrawerTarget = { kind: "customer", customerId: "c 1" };

  it("closing panels opened in the app steps back, so Back does not reopen them", () => {
    const at = (view: string, drawers: DrawerTarget[]) => ({ view, drawers });
    // Open customer, then job: one entry each, depth 1 then 2.
    expect(addressWrite(at("customers", []), at("customers", [customer]), 0)).toEqual({ kind: "push", depth: 1 });
    expect(addressWrite(at("customers", [customer]), at("customers", [customer, job]), 1)).toEqual({
      kind: "push",
      depth: 2,
    });
    // Close the job: step back one entry (to the customer).
    expect(addressWrite(at("customers", [customer, job]), at("customers", [customer]), 2)).toEqual({
      kind: "back",
      steps: 1,
    });
    // Close both at once (saving a new job, say).
    expect(addressWrite(at("customers", [customer, job]), at("customers", []), 2)).toEqual({ kind: "back", steps: 2 });
    // Opened from a link or a reload (no entries of ours): rewrite, never add.
    expect(addressWrite(at("customers", [customer, job]), at("customers", [customer]), 0)).toEqual({
      kind: "replace",
    });
    // A tab switch is a new entry and starts again at depth 0.
    expect(addressWrite(at("customers", [customer]), at("schedule", [customer]), 1)).toEqual({ kind: "push", depth: 0 });
  });

  it("writes one address per screen and open panel", () => {
    expect(formatRoute("schedule", [])).toBe("#/schedule");
    expect(formatRoute("crew", [])).toBe("#/today");
    expect(formatRoute("users", [])).toBe("#/team");
    expect(formatRoute("customers", [customer, job])).toBe("#/customers/customer/c%201/job/j9");
    expect(formatRoute("schedule", [{ kind: "job", jobId: null, defaultDate: "x" }])).toBe("#/schedule/job/new");
    expect(formatRoute("invoices", [{ kind: "invoice", invoiceId: "i1" }])).toBe("#/invoices/invoice/i1");
    expect(formatRoute("sales", [{ kind: "estimate", estimateId: "e1" }])).toBe("#/sales-calendar/estimate/e1");
  });

  it("reads an address back", () => {
    const r = parseRoute("#/customers/customer/c%201/job/j9", "2026-11-17");
    expect(r?.view).toBe("customers");
    expect(r?.drawers).toEqual([
      { kind: "customer", customerId: "c 1" },
      { kind: "job", jobId: "j9", defaultDate: "2026-11-17" },
    ]);
    expect(parseRoute("#/team/person/p1", "d")?.drawers).toEqual([
      { kind: "employee", employeeId: "p1", edit: false },
    ]);
    expect(parseRoute("#/schedule/job/new", "2026-11-17")?.drawers[0]).toEqual({
      kind: "job",
      jobId: null,
      defaultDate: "2026-11-17",
    });
  });

  it("round-trips every screen", () => {
    for (const v of ["dashboard", "customers", "schedule", "estimates", "pipeline", "sales", "invoices", "users", "timesheets", "crew-rules", "automations", "activity", "messages", "crew", "guide", "equipment", "portal", "phc", "me"] as const) {
      expect(parseRoute(formatRoute(v, []), "d")?.view).toBe(v);
    }
  });

  it("leaves sign-in links and the public pages alone", () => {
    expect(isAppRoute("")).toBe(false);
    expect(isAppRoute("#access_token=abc&type=recovery")).toBe(false);
    expect(isAppRoute("#/book")).toBe(false);
    expect(isAppRoute("#/runsheet/2026-11-16")).toBe(false);
    expect(parseRoute("#/book", "d")).toBeNull();
    expect(parseRoute("#/nowhere/job/1", "d")).toBeNull();
  });

  it("skips broken panel parts", () => {
    expect(parseRoute("#/schedule/job", "d")?.drawers).toEqual([]);
    expect(parseRoute("#/schedule/bogus/1/job/j1", "d")?.drawers).toEqual([
      { kind: "job", jobId: "j1", defaultDate: "d" },
    ]);
    expect(parseRoute("#/schedule/job/%E0%A4%A", "d")?.drawers).toEqual([]);
  });

  it("Back keeps the open panel objects that still match", () => {
    const newJob: DrawerTarget = { kind: "job", jobId: null, defaultDate: "2026-11-18", defaultStartTime: "10:00" };
    const parsed = parseRoute("#/schedule/job/new", "2026-11-17")!.drawers;
    const merged = mergeDrawers([newJob, customer], parsed);
    expect(merged).toEqual([newJob]);
    expect(sameDrawers(merged, parsed)).toBe(true);
    expect(sameDrawers([job], [customer])).toBe(false);
  });
});

describe("new job form", () => {
  it("defaults to the next working day, skipping Sundays and closed days", () => {
    // 2026-11-14 is a Saturday, 2026-11-15 a Sunday.
    expect(nextWorkingDay("2026-11-14")).toBe("2026-11-16");
    expect(nextWorkingDay("2026-11-15")).toBe("2026-11-16");
    expect(nextWorkingDay("2026-11-13")).toBe("2026-11-14");
    expect(nextWorkingDay("2026-11-15", [{ date: "2026-11-16" }])).toBe("2026-11-17");
  });

  it("keeps a future day someone picked; today or the past becomes the next working day", () => {
    expect(newJobDate("2026-11-20", "2026-11-15")).toBe("2026-11-20");
    expect(newJobDate("2026-11-15", "2026-11-15")).toBe("2026-11-16");
    expect(newJobDate("2026-11-01", "2026-11-15")).toBe("2026-11-16");
    expect(newJobDate(null, "2026-11-15")).toBe("2026-11-16");
  });

  it("says plainly what is missing", () => {
    expect(newJobMissing({ customerId: "", title: " " })).toEqual(["pick a customer", "type a job title"]);
    expect(newJobMissing({ customerId: "c1", title: "" })).toEqual(["type a job title"]);
    expect(newJobMissing({ customerId: "c1", title: "Oak trim" })).toEqual([]);
  });
});

describe("office role", () => {
  it("gives office editing rights whatever the job title", () => {
    expect(canEditRecords("office")).toBe(true);
    expect(canEditRecords("owner")).toBe(true);
    expect(canEditRecords("manager")).toBe(true);
    expect(canEditRecords("crew")).toBe(false);
    expect(canEditRecords(undefined)).toBe(false);
  });

  it("opens owners, managers and the office on the Dashboard, crew on Today", () => {
    expect(landsOnDashboard("office")).toBe(true);
    expect(landsOnDashboard("manager")).toBe(true);
    expect(landsOnDashboard("crew")).toBe(false);
  });

  it("only shows a header note when something really is view-only", () => {
    expect(accessNote(true, true)).toBeNull();
    expect(accessNote(false, true)).toBe("You can update the jobs you are on.");
    expect(accessNote(false, false)).toMatch(/Ask the office/);
  });
});

describe("Automations page", () => {
  const rule = (kind: AutomationRule["kind"], id: string): AutomationRule => ({
    id,
    kind,
    label: kind,
    description: "",
    enabled: true,
    timingDays: 1,
    template: "",
  });

  it("lists rules in one fixed order, whatever order they were saved in", () => {
    const shuffled = [...RULE_ORDER].reverse().map((k, i) => rule(k, `r${i}`));
    expect(orderedRules(shuffled).map((r) => r.kind)).toEqual([...RULE_ORDER]);
    // Saving one rule (it moves to the end of the list) changes nothing.
    const edited = [...shuffled.slice(1), shuffled[0]];
    expect(orderedRules(edited).map((r) => r.kind)).toEqual([...RULE_ORDER]);
  });

  it("uses a sample that fits each rule", () => {
    expect(sampleFor("estimate_reminder", "Mon").title).toBe("Silver maple removal");
    expect(sampleFor("phc_renewal", "Mon").title).toBe("EAB program 2027");
    expect(sampleFor("invoice_reminder", "Mon").title).toBe("INV-1040");
    for (const k of RULE_ORDER) {
      if (!k.startsWith("invoice") && k !== "overdue_escalation" && k !== "thank_you") {
        expect(sampleFor(k, "Mon").title).not.toMatch(/INV-/);
      }
    }
  });
});

describe("estimate email preview", () => {
  const customer = { id: "c1", firstName: "Dana", lastName: "T", email: "dana@example.com" } as Customer;
  const estimate = {
    id: "e1",
    title: "Remove oak",
    lines: [{ id: "l1", description: "Remove oak", quantity: 1, unitPrice: 2400 }],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    createdDate: "2026-11-15",
    notes: "",
    options: null,
  } as unknown as Estimate;

  it("matches the real email: accept button, closing line, no thread code", () => {
    const e = estimateEmailPreview(estimate, customer, { name: "Your Tree Company", phone: "555-555-0100", email: "" });
    expect(e.acceptButton).toBe(true);
    expect(e.body).toContain(`Review and accept: ${PREVIEW_LINK}`);
    expect(e.body).toContain("Questions? Just reply to this email or give us a call.");
    expect(e.body).not.toMatch(/Reply to this email to approve/);
    expect(e.body).not.toMatch(/thread/i);
    expect(e.subject).toBe("Your estimate: Remove oak — $2,400");
    expect(e.to).toBe("dana@example.com");
  });
});

describe("month view route card", () => {
  it("opens beside the day and stays on screen", () => {
    expect(routeCardSpot({ left: 100, right: 250, top: 300 }, 1280, 800)).toEqual({ left: 258, top: 300 });
    // No room on the right: opens to the left of the day.
    expect(routeCardSpot({ left: 1000, right: 1150, top: 700 }, 1280, 800)).toEqual({ left: 612, top: 364 });
  });
});
