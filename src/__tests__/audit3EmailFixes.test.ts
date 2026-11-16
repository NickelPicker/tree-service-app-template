// Audit 3 (email) fixes and payment receipts for split invoices.
// Owner: "I want the person who has paid to get a receipt of payment and
// no further information if the other portions have been paid or not."
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  composeReceiptEmail,
  paidDayOf,
  planReceipts,
  receiptDedupeKey,
  receiptStates,
} from "../../supabase/functions/_shared/paymentReceipt.ts";
import { sharesOf } from "../../supabase/functions/_shared/splitShares.ts";
import { recipientAllowed } from "../../supabase/functions/_shared/testMode.ts";
import { dayPlanDedupeKey, dayPlanHashInput } from "../../supabase/functions/send-day-plan/compose.ts";
import type { PlannedEmail } from "../../supabase/functions/run-automations/plan.ts";
import { emailDoneInvoice, emailPlanned, type Rpc, type Send } from "../../supabase/functions/run-automations/steps.ts";
import {
  parseReceiptReply,
  receiptPayerText,
  receiptSendText,
  receiptSentAt,
  receiptsToConfirm,
  unpaidPayerIds,
} from "../paymentReceipts";
import { batchResultText, parseBatchReply, runFromRow, runOutcomeText } from "../automationStatus";
import { dayPlanEmailMessage, parseDayPlanReply } from "../dayPlanEmail";
import { estimateSendText } from "../estimateSend";
import type { Invoice, InvoiceSplit } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ---------- Receipts ----------
const split = (id: string, over: Partial<InvoiceSplit> = {}): InvoiceSplit => ({
  id,
  recipientName: `Payer ${id}`,
  recipientEmail: `${id}@example.com`,
  kind: "percentage",
  value: 50,
  paid: false,
  paidDate: null,
  ...over,
});

function invoice(splits: InvoiceSplit[]): Invoice {
  return {
    id: "inv-1",
    number: "INV-1100",
    customerId: "c1",
    jobId: "j1",
    estimateId: null,
    lines: [{ id: "l1", description: "Oak removal", quantity: 1, unitPrice: 1000.01 }],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "unpaid",
    issuedDate: "2026-11-16",
    dueDate: "2026-12-16",
    paidDate: null,
    paymentMethod: null,
    emailQueuedAt: null,
    splits,
  } as Invoice;
}

const company = { name: "Your Tree Company", phone: "555-0100", email: "office@example.com" };

describe("receipt email", () => {
  const email = composeReceiptEmail({
    payerName: "Bo",
    amount: 500.01,
    paidDay: "2026-11-17",
    invoiceNumber: "INV-1100",
    company,
  });
  it("has the payer's amount, the date, the invoice number and the company details", () => {
    for (const part of [email.text, email.html]) {
      expect(part).toContain("$500.01");
      expect(part).toContain("INV-1100");
      expect(part).toContain("Your Tree Company");
      expect(part).toContain("555-0100");
      expect(part).toContain("office@example.com");
    }
    expect(email.text).toMatch(/Date paid: .*2026|Nov/);
    expect(email.subject).toContain("Receipt");
  });
  it("says nothing about the total, other payers or what is still owed", () => {
    for (const part of [email.text, email.html, email.subject]) {
      expect(part).not.toMatch(/total|balance|remaining|other payer|still owe|share/i);
      expect(part).not.toContain("1000");
    }
  });
  it("the thread line has no amount and no address", () => {
    expect(email.recordText).toBe("Receipt for invoice INV-1100 emailed to Bo.");
    expect(email.recordText).not.toMatch(/\$|@/);
  });
  it("escapes HTML in names", () => {
    const e = composeReceiptEmail({ payerName: "<b>x</b>", amount: 1, paidDay: "2026-11-17", invoiceNumber: "I", company });
    expect(e.html).not.toContain("<b>x</b>");
  });
});

describe("planReceipts", () => {
  const splits = [
    split("a", { paid: true, paidDate: "2026-11-17" }),
    split("b", { paid: true, paidDate: "2026-11-17", recipientEmail: "" }),
    split("c", { paid: false }),
  ];
  const total = 1000.01;
  const base = { invoiceId: "inv-1", splits, total, again: false, states: new Map(), allowed: () => true };

  it("one receipt for a payer just marked paid, with their own share", () => {
    const p = planReceipts({ ...base, only: ["a"] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.toSend.map((x) => x.payer.id)).toEqual(["a"]);
    expect(p.toSend[0].amount).toBe(sharesOf(splits, total)[0]);
    expect(p.toSend[0].key).toBe("payment_receipt:inv-1:payer-a:2026-11-17:first");
  });
  it("no receipt for an unpaid payer or a payer without email", () => {
    const p = planReceipts({ ...base, only: ["b", "c"] });
    if (!p.ok) throw new Error("plan");
    expect(p.toSend).toEqual([]);
    expect(p.payers.map((x) => x.skip)).toEqual(["no-email", "not-paid"]);
  });
  it("one per payment: a second press sends nothing, Resend does (with a new key)", () => {
    const states = receiptStates("inv-1", [
      { dedupe_key: "payment_receipt:inv-1:payer-a:2026-11-17:first", status: "sent", sent_at: "2026-11-17T15:00:00Z" },
    ]);
    const again = planReceipts({ ...base, only: ["a"], states });
    if (!again.ok) throw new Error("plan");
    expect(again.payers[0].skip).toBe("already-sent");
    const resend = planReceipts({ ...base, only: ["a"], states, again: true });
    if (!resend.ok) throw new Error("plan");
    expect(resend.toSend[0].key).toBe("payment_receipt:inv-1:payer-a:2026-11-17:2026-11-17T15:00:00Z");
  });
  it("a new payment day is a new receipt", () => {
    const states = receiptStates("inv-1", [
      { dedupe_key: "payment_receipt:inv-1:payer-a:2026-11-10:first", status: "sent", sent_at: "2026-11-10T15:00:00Z" },
    ]);
    const p = planReceipts({ ...base, only: ["a"], states });
    if (!p.ok) throw new Error("plan");
    expect(p.toSend).toHaveLength(1);
  });
  it("test mode blocks addresses that are not test addresses", () => {
    const p = planReceipts({ ...base, only: ["a"], allowed: (e) => recipientAllowed(e, "on", "biz@example.com", "") });
    if (!p.ok) throw new Error("plan");
    expect(p.payers[0].skip).toBe("blocked-test-mode");
  });
  it("unknown payer or no payer is refused", () => {
    expect(planReceipts({ ...base, only: ["zz"] })).toEqual({ ok: false, reason: "unknown-payer" });
    expect(planReceipts({ ...base, only: [] })).toEqual({ ok: false, reason: "no-payers" });
  });
  it("a stuck send older than 30 minutes is what Resend follows", () => {
    const now = new Date("2026-11-17T16:00:00Z");
    const st = receiptStates(
      "inv-1",
      [{ dedupe_key: "payment_receipt:inv-1:payer-a:2026-11-17:first", status: "sending", created_at: "2026-11-17T15:00:00Z" }],
      now,
    );
    expect(st.get("a|2026-11-17")).toEqual({ sentAt: null, resendAfter: "2026-11-17T15:00:00Z", retryAfter: null });
    expect(receiptDedupeKey("i", "a", "2026-11-17", null)).toBe("payment_receipt:i:payer-a:2026-11-17:first");
    expect(paidDayOf({ paid: true, paidDate: "2026-11-17" })).toBe("2026-11-17");
    expect(paidDayOf({ paid: false, paidDate: "2026-11-17" })).toBe("");
  });
});

describe("receipts in the app", () => {
  it("counts receipts to confirm: unpaid payers with an email and a share", () => {
    const inv = invoice([
      split("a"),
      split("b", { recipientEmail: "" }),
      split("c", { paid: true, paidDate: "2026-11-17" }),
      split("d", { kind: "fixed", value: 0 }),
    ]);
    expect(unpaidPayerIds(inv)).toEqual(["a", "b", "d"]);
    expect(receiptsToConfirm(inv, unpaidPayerIds(inv))).toBe(1);
    const five = invoice(["a", "b", "c", "d", "e"].map((id) => split(id, { value: 20 })));
    expect(receiptsToConfirm(five, unpaidPayerIds(five))).toBe(5);
  });
  it("shows Receipt sent only for the current payment", () => {
    const states = receiptStates("inv-1", [
      { dedupe_key: "payment_receipt:inv-1:payer-a:2026-11-17:first", status: "sent", sent_at: "2026-11-17T15:00:00Z" },
    ]);
    expect(receiptSentAt(states, split("a", { paid: true, paidDate: "2026-11-17" }))).toBe("2026-11-17T15:00:00Z");
    expect(receiptSentAt(states, split("a", { paid: true, paidDate: "2026-11-18" }))).toBeNull();
    expect(receiptSentAt(states, split("a"))).toBeNull();
  });
  it("reads the reply and says it plainly", () => {
    const r = parseReceiptReply({ sent: 1, receipt: true, payers: [{ id: "a", sent: 1 }, { id: "b", sent: 0, reason: "no-email" }] });
    expect(r.sent).toBe(1);
    expect(receiptSendText(r)).toBe("Receipt emailed to 1 payer.");
    expect(receiptPayerText(r.payers[1])).toMatch(/no email/i);
    expect(receiptSendText(parseReceiptReply({ sent: 0, reason: "needs-confirm", count: 5 }))).toMatch(/5 at once/);
    expect(receiptSendText(parseReceiptReply(null))).toMatch(/Could not/);
  });
  it("the invoice panel sends receipts on Mark paid, with the double confirm for more than 3", () => {
    const src = read("src/components/InvoiceDetail.tsx");
    expect(src).toContain("confirmEmails(count");
    expect(src).toMatch(/markInvoicePaid\(invoice\.id, method\);\s*if \(count > 0\) emailReceipts\(ids, false, count\)/);
    expect(read("src/components/SplitPayers.tsx")).toContain("Receipt sent");
  });
  it("the server checks the confirmed count and claims receipts atomically", () => {
    const src = read("supabase/functions/send-invoice/index.ts");
    expect(src).toMatch(/isMassEmail\(count\) && a\.confirmed < count/);
    expect(src).toContain("claim_payment_receipts");
    expect(src).toContain('p_sender_name: "Receipt email"');
  });
});

// ---------- run-automations ----------
type Call = { fn: string; args: Record<string, unknown> };
function fakeRpc(answers: Record<string, unknown>, fail: string[] = []) {
  const calls: Call[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fail.includes(fn)) return { data: null, error: { message: "boom" } };
    return { data: fn in answers ? answers[fn] : true, error: null };
  };
  return { rpc, calls, names: () => calls.map((c) => c.fn) };
}
const cust = { id: "c1", first_name: "Ann", email: "ann@example.com" };
const doneInv = { id: "inv1", jobId: "j1", customer: cust, customerName: "Ann" };
const compose = () => ({ subject: "s", text: "t", html: "h" });
const sendWith = (r: Awaited<ReturnType<Send>>): Send => async () => r;
const testModeOn = (to: string) => recipientAllowed(to, "on", "biz@example.com", "");

describe("test mode in the automatic emails", () => {
  it("a blocked Done invoice is not claimed and uses no try", async () => {
    const f = fakeRpc({});
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), async () => null, testModeOn)).toBe(
      "blocked-test-mode",
    );
    expect(f.calls).toEqual([]);
  });
  it("a blocked reminder is not claimed", async () => {
    const m = { to: "ann@example.com", kind: "invoice_reminder", dedupeKey: "k" } as PlannedEmail;
    const f = fakeRpc({});
    expect(await emailPlanned(f.rpc, "co", m, sendWith("sent"), testModeOn)).toBe("blocked-test-mode");
    expect(f.calls).toEqual([]);
  });
  it("a test address still goes", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    const allowAnn = (to: string) => recipientAllowed(to, "on", "biz@example.com", "ann@example.com");
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), async () => null, allowAnn)).toBe("sent");
  });
  it("the hourly report shows them as held back, not failed", () => {
    expect(runOutcomeText(runFromRow({ outcome: "done", sent: 0, failed: 0, skipped: 0, waiting: 0, blocked: 2 }))).toContain(
      "2 held back by test mode",
    );
    const yml = read(".github/workflows/automations.yml");
    expect(yml).toContain("blocked");
  });
});

describe("Done invoice after Gmail took it", () => {
  it("is never put back to waiting when marking it sent fails", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" }, ["auto_invoice_send_finish"]);
    await expect(emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), async () => null)).rejects.toThrow();
    const finishes = f.calls.filter((c) => c.fn === "auto_invoice_send_finish").map((c) => c.args.p_status);
    expect(finishes).toEqual(["sent", "sent"]);
    expect(finishes).not.toContain("waiting");
  });
  it("still goes back to waiting when the email was never tried", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    const boom = () => {
      throw new Error("compose");
    };
    await expect(emailDoneInvoice(f.rpc, "co", doneInv, boom, sendWith("sent"), async () => null)).rejects.toThrow();
    expect(f.calls.at(-1)).toMatchObject({ fn: "auto_invoice_send_finish", args: { p_status: "waiting" } });
  });
  it("Email invoice treats the automatic email's sends-log row as emailed", () => {
    const src = read("supabase/functions/send-invoice/index.ts");
    expect(src).toContain("`invoice_send:${invoiceId}`");
    expect(src).toMatch(/emailedBefore = emailedAt0 !== "" \|\| inv\.auto_send_status === "sent" \|\| autoMailed/);
  });
});

describe("Send them (approved batch)", () => {
  it("the server refuses more than 3 without the confirmed count", () => {
    const src = read("supabase/functions/run-automations/index.ts");
    expect(src).toMatch(/isMassEmail\(itemIds\.length\) && confirmed < itemIds\.length/);
    expect(read("src/automationStatus.ts")).toMatch(/batchId, itemIds, confirmed \}/);
    expect(read("src/components/Automations.tsx")).toContain("heldItems.map((x) => x.id), n)");
  });
  it("says why plainly", () => {
    expect(batchResultText(parseBatchReply({ sent: 0, failed: 0, skipped: 0, left: 5, reason: "needs-confirm" }))).toMatch(
      /are you sure/,
    );
    expect(batchResultText(parseBatchReply({ sent: 1, failed: 0, skipped: 0, left: 2, blocked: 2 }))).toBe(
      "Sent 1, 2 held back by test mode (only test addresses get emails).",
    );
  });
});

// ---------- send-estimate ----------
describe("Email again on an estimate in test mode", () => {
  it("checks test mode before a new link is made", () => {
    const src = read("supabase/functions/send-estimate/index.ts");
    const check = src.indexOf("recipientAllowed(to");
    const link = src.indexOf('rpc("create_estimate_accept_link"');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(link);
    expect(estimateSendText({ sent: 0, reason: "blocked-test-mode" })).toMatch(/test mode/);
  });
});

// ---------- send-day-plan ----------
describe("day-plan emails", () => {
  it("an unchanged plan has the same key; any change is a new one", () => {
    const m = { to: "Crew@Example.com", subject: "Your day", text: "Stop 1" };
    const k1 = dayPlanDedupeKey("2026-11-18", "crew1", "a".repeat(64));
    expect(k1).toBe(`day_plan:2026-11-18:crew1:${"a".repeat(32)}`);
    expect(dayPlanHashInput(m)).toBe(dayPlanHashInput({ ...m, to: "crew@example.com" }));
    expect(dayPlanHashInput(m)).not.toBe(dayPlanHashInput({ ...m, text: "Stop 2" }));
  });
  it("logs every send and skips unchanged plans", () => {
    const src = read("supabase/functions/send-day-plan/index.ts");
    expect(src).toContain("claim_day_plan_sends");
    expect(src).toContain("finish_day_plan_send");
    expect(src).toMatch(/toSend\.length > MASS_EMAIL_LIMIT && toSend\.length > confirmed/);
  });
  it("says who already had the plan", () => {
    const r = parseDayPlanReply({ sent: 1, skipped: 0, unchanged: 2 });
    expect(dayPlanEmailMessage(r)).toBe("Emailed 1 person their day (2 people already had this plan)");
    expect(dayPlanEmailMessage(parseDayPlanReply({ sent: 0, skipped: 0, unchanged: 3 }))).toBe(
      "No new emails (3 people already had this plan)",
    );
  });
});

// ---------- deploy ----------
describe("email switches on deploy", () => {
  const yml = read(".github/workflows/deploy.yml");
  const script = read(".github/scripts/email-settings.sh");
  it("has a quick email-settings run with no migrations or website", () => {
    expect(yml).toContain("options: [check, deploy, email-settings]");
    const job = yml.slice(yml.indexOf("  email-settings:"), yml.indexOf("\n  test:"));
    expect(job).toContain("email-settings.sh secrets");
    expect(job).toContain("email-settings.sh verify");
    expect(job).not.toMatch(/db push|migration|netlify/i);
  });
  it("checks after every deploy that an off switch really stuck", () => {
    const deploy = yml.slice(yml.indexOf("\n  deploy:"));
    expect(deploy).toMatch(/Check the email switches stuck[\s\S]*if: always\(\) && steps\.link\.outcome == 'success'/);
    expect(script).toContain("secrets list");
    expect(script).toMatch(/smtp_host/);
    expect(yml).not.toContain("Gmail sending is OFF: the email functions cannot send.");
  });
});
