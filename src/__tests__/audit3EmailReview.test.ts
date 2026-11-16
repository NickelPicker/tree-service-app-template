// Review fixes on the audit 3 email branch: deploy order, day plans and
// receipts that failed 3 times, the quick email-settings run, and the
// "Send receipt" button never sending a second receipt by itself.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { planReceipts, receiptStates } from "../../supabase/functions/_shared/paymentReceipt.ts";
import { recipientAllowed } from "../../supabase/functions/_shared/testMode.ts";
import { planDayPlanSends } from "../../supabase/functions/send-day-plan/compose.ts";
import { dayPlanEmailMessage, parseDayPlanReply } from "../dayPlanEmail";
import { receiptIsResend } from "../paymentReceipts";
import type { InvoiceSplit } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("deploy order", () => {
  const yml = read(".github/workflows/deploy.yml");
  const deploy = yml.slice(yml.indexOf("\n  deploy:"));
  it("deploys the email functions only after the migrations", () => {
    const migrate = deploy.indexOf("- name: Apply migrations");
    const fns = deploy.indexOf("supabase functions deploy send-day-plan");
    const publish = deploy.indexOf("- name: Publish the new website");
    expect(migrate).toBeGreaterThan(0);
    expect(fns).toBeGreaterThan(migrate);
    expect(publish).toBeGreaterThan(fns);
    for (const f of ["run-automations", "send-invoice", "send-estimate", "book-estimate"]) {
      expect(deploy.indexOf(`supabase functions deploy ${f}`)).toBeGreaterThan(migrate);
    }
    expect(yml).not.toContain("the old site never calls them");
  });
  it("the email-settings run skips tests, build and rehearsal", () => {
    const cond = "github.event_name != 'workflow_dispatch' || inputs.mode != 'email-settings'";
    for (const [start, end] of [
      ["\n  test:", "\n  build:"],
      ["\n  build:", "\n  setup-check:"],
      ["\n  rehearse:", "\n  deploy:"],
    ]) {
      const job = yml.slice(yml.indexOf(start), yml.indexOf(end));
      expect(job).toContain(cond);
    }
  });
});

describe("run-automations on an older database", () => {
  it("finishes the run even if the blocked column is missing", () => {
    const src = read("supabase/functions/run-automations/index.ts");
    const fn = src.slice(src.indexOf("async function finishRun"), src.indexOf("/** Everything one company"));
    expect(fn).toMatch(/if \(error\)/);
    expect(fn).toContain("delete rest.blocked");
  });
});

describe("day-plan emails: test mode and 3 failed tries", () => {
  const items = [
    { key: "k1", to: "a@example.com" },
    { key: "k2", to: "biz@example.com" },
    { key: "k3", to: "c@example.com" },
    { key: "k4", to: "biz@example.com" },
  ];
  const testMode = (to: string) => recipientAllowed(to, "on", "biz@example.com", "");
  it("test mode holds people back before anything is claimed", () => {
    const p = planDayPlanSends(items, [], testMode);
    expect(p.toSend.map((x) => x.key)).toEqual(["k2", "k4"]);
    expect(p.blocked).toBe(2);
    expect(p.unchanged).toBe(0);
  });
  it("a plan that failed 3 times is reported as failed, not as already had", () => {
    const p = planDayPlanSends(
      items,
      [
        { dedupe_key: "k2", status: "failed", attempts: 3 },
        { dedupe_key: "k4", status: "failed", attempts: 1 },
        { dedupe_key: "k1", status: "sent", attempts: 1 },
      ],
      () => true,
    );
    expect(p.failed).toBe(1);
    expect(p.unchanged).toBe(1);
    expect(p.toSend.map((x) => x.key)).toEqual(["k3", "k4"]);
  });
  it("the toast says so in plain words", () => {
    const r = parseDayPlanReply({ sent: 0, skipped: 0, blocked: 2, failed: 1 });
    expect(r).toEqual({ sent: 0, skipped: 0, blocked: 2, failed: 1 });
    expect(dayPlanEmailMessage(r)).toBe("No new emails (2 people held back by test mode; 1 person could not be emailed)");
    expect(dayPlanEmailMessage({ sent: 1, skipped: 0, failed: 1 })).toBe(
      "Emailed 1 person their day (1 person could not be emailed)",
    );
  });
  it("send-day-plan checks test mode and stops calling failures 'skipped'", () => {
    const src = read("supabase/functions/send-day-plan/index.ts");
    expect(src).toContain("planDayPlanSends(");
    expect(src).toContain("recipientAllowed(");
    expect(src).not.toContain("skippedNoEmail + failed");
    expect(src.indexOf("planDayPlanSends(")).toBeLessThan(src.indexOf('rpc("claim_day_plan_sends"'));
  });
});

describe("receipts that failed 3 times", () => {
  const split = (id: string): InvoiceSplit => ({
    id,
    recipientName: `Payer ${id}`,
    recipientEmail: `${id}@example.com`,
    kind: "percentage",
    value: 100,
    paid: true,
    paidDate: "2026-11-17",
  } as InvoiceSplit);
  const base = { invoiceId: "inv-1", splits: [split("a")], total: 100, only: ["a"], allowed: () => true };
  const dead = {
    dedupe_key: "payment_receipt:inv-1:payer-a:2026-11-17:first",
    status: "failed",
    created_at: "2026-11-17T15:00:00Z",
    attempts: 3,
  };
  it("Send receipt follows the dead row with a new key", () => {
    const states = receiptStates("inv-1", [dead]);
    expect(states.get("a|2026-11-17")?.sentAt).toBeNull();
    const p = planReceipts({ ...base, again: false, states });
    if (!p.ok) throw new Error("plan");
    expect(p.payers[0].skip).toBeNull();
    expect(p.toSend[0].key).toBe("payment_receipt:inv-1:payer-a:2026-11-17:2026-11-17T15:00:00Z");
    const r = planReceipts({ ...base, again: true, states });
    if (!r.ok) throw new Error("plan");
    expect(r.toSend[0].key).toBe("payment_receipt:inv-1:payer-a:2026-11-17:2026-11-17T15:00:00Z");
  });
  it("a failed row with tries left is retried on the same key", () => {
    const states = receiptStates("inv-1", [{ ...dead, attempts: 2 }]);
    const p = planReceipts({ ...base, again: false, states });
    if (!p.ok) throw new Error("plan");
    expect(p.toSend[0].key).toBe("payment_receipt:inv-1:payer-a:2026-11-17:first");
  });
  it("after a later receipt went, a press without Resend sends nothing", () => {
    const states = receiptStates("inv-1", [
      dead,
      {
        dedupe_key: "payment_receipt:inv-1:payer-a:2026-11-17:2026-11-17T15:00:00Z",
        status: "sent",
        sent_at: "2026-11-17T15:10:00Z",
        attempts: 1,
      },
    ]);
    const p = planReceipts({ ...base, again: false, states });
    if (!p.ok) throw new Error("plan");
    expect(p.payers[0].skip).toBe("already-sent");
  });
  it("send-invoice reports a refused failed key as failed, not already sent", () => {
    const src = read("supabase/functions/send-invoice/index.ts");
    expect(src).toContain('failedKeys.has(p.key) ? "error" : "already-sent"');
    expect(src).toContain('"dedupe_key,status,sent_at,created_at,attempts"');
  });
});

describe("Send receipt never sends a second receipt by itself", () => {
  it("only Resend receipt asks for another one", () => {
    expect(receiptIsResend(null)).toBe(false);
    expect(receiptIsResend("2026-11-17T15:00:00Z")).toBe(true);
    const ui = read("src/components/SplitPayers.tsx");
    expect(ui).toContain("onConfirmResendReceipt(s.id, receiptIsResend(receiptAt))");
    const detail = read("src/components/InvoiceDetail.tsx");
    expect(detail).toContain("onConfirmResendReceipt={(id, again) => emailReceipts([id], again, 1)}");
  });
});
