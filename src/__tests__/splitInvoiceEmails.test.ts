// Business rule: "Each payer should get an invoice for the amount
// they are going to pay. Make sure that is an option on the invoices for
// us so we can send an invoice to multiple people and split it up how we
// need to on our end."
import { describe, expect, it, vi } from "vitest";
import {
  composeInvoiceEmailByHand,
  type InvoiceCompany,
} from "../../supabase/functions/_shared/invoiceEmail.ts";
import {
  exactInvoiceTotal,
  shareOf,
  sharesOf,
  sharesTotal,
  splitsCoverageWarning as serverCoverage,
  splitsSendProblem,
} from "../../supabase/functions/_shared/splitShares.ts";
import {
  EMAIL_RE,
  lastSentByPayer,
  payerDedupeKey,
  planSplitSend,
} from "../../supabase/functions/_shared/splitInvoiceSend.ts";
import { recipientAllowed } from "../../supabase/functions/_shared/testMode.ts";
import {
  invoiceMayBeChased,
  isSplitInvoice,
  planAutomaticEmails,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import { estimateTotals } from "../email";
import { invoiceTotal, splitAmount, splitsCoverageWarning } from "../splits";
import { invoiceForEmail, invoicePayerEmailPreview } from "../invoicePreview";
import { emailablePayers, payerEmailCount, splitCheck } from "../splitPayers";
import { needsDoubleConfirm } from "../doubleConfirm";
import { invoiceSendText, parseInvoiceSendReply, payerSendText, sendMayHaveGone } from "../invoiceSend";
import { REVIEW_REASONS } from "../autoInvoice";
import { defaultAutomations } from "../data/seed";
import type { CompanyProfile, Invoice, InvoiceSplit } from "../types";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

const GMAIL = "business@example.com";
const company = {
  name: "Your Tree Company",
  phone: "555-0100",
  zelleNumber: "555-0199",
  checkPayee: "Your Tree Company",
  checkMailingAddress: "1 Shop Rd, Anytown CO",
  reviewUrl: "https://g.page/r/example-test/review",
} satisfies InvoiceCompany;
const profile = company as unknown as CompanyProfile;

function split(id: string, name: string, email: string, kind: "percentage" | "fixed", value: number, paid = false): InvoiceSplit {
  return { id, recipientName: name, recipientEmail: email, kind, value, paid, paidDate: null };
}

function invoice(splits: InvoiceSplit[], over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    number: "INV-1100",
    customerId: "c1",
    jobId: "j1",
    estimateId: null,
    lines: [
      { id: "l1", description: "Oak removal", quantity: 1, unitPrice: 1200 },
      { id: "l2", description: "Stump grinding", quantity: 2, unitPrice: 150 },
    ],
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
    ...over,
  } as Invoice;
}

const serverTotal = (i: Invoice) => {
  const e = invoiceForEmail(i);
  return exactInvoiceTotal(e.lines, e.tax_rate, e.discount_type, e.discount_value);
};

describe("share math: the app and the server agree", () => {
  it("same total and same share for many invoices and splits", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 400; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => ({
        id: `l${k}`,
        description: "Work",
        quantity: 1 + Math.floor(rnd() * 3),
        unitPrice: Math.round(rnd() * 250000) / 100,
      }));
      const dt = (["none", "percent", "fixed"] as const)[Math.floor(rnd() * 3)];
      const inv = invoice(
        [
          split("a", "A", "a@x.com", "percentage", Math.round(rnd() * 10000) / 100),
          split("b", "B", "b@x.com", "fixed", Math.round(rnd() * 100000) / 100),
          split("c", "C", "c@x.com", "percentage", 33.33),
        ],
        {
          lines,
          taxRate: Math.round(rnd() * 900) / 100,
          discountType: dt,
          discountValue: dt === "percent" ? Math.round(rnd() * 30) : Math.round(rnd() * 20000) / 100,
        },
      );
      const appTotal = estimateTotals(inv.lines, inv.taxRate, inv.discountType, inv.discountValue).total;
      expect(serverTotal(inv)).toBe(appTotal);
      expect(invoiceTotal(inv)).toBe(appTotal);
      const server = sharesOf(inv.splits, serverTotal(inv));
      inv.splits.forEach((s, k) => expect(server[k]).toBe(splitAmount(s, inv)));
      expect(serverCoverage(inv.splits, serverTotal(inv))).toBe(splitsCoverageWarning(inv.splits, inv));
    }
  });

  it("shares that add up always bill exactly the total, to the cent (400 random invoices)", () => {
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 400; n++) {
      const inv0 = invoice([], {
        lines: [{ id: "l", description: "Work", quantity: 1 + Math.floor(rnd() * 3), unitPrice: Math.round(rnd() * 500000) / 100 + 0.01 }],
        taxRate: Math.round(rnd() * 900) / 100,
        discountType: rnd() < 0.3 ? "percent" : "none",
        discountValue: Math.round(rnd() * 25),
      });
      const total = invoiceTotal(inv0);
      // 2-5 percentage payers adding to 100 (two decimals), sometimes after a fixed payer.
      const k = 2 + Math.floor(rnd() * 4);
      const cuts = Array.from({ length: k - 1 }, () => Math.round(rnd() * 10000)).sort((a, b) => a - b);
      const pcts = [...cuts, 10000].map((c, j) => (c - (j === 0 ? 0 : cuts[j - 1])) / 100);
      const fixedFirst = rnd() < 0.4;
      const fixed = fixedFirst ? Math.round(total * rnd() * 50) / 100 : 0;
      const pctBase = total - fixed;
      const splits: InvoiceSplit[] = fixedFirst
        ? [split("f", "F", "f@x.com", "fixed", fixed), split("p", "P", "p@x.com", "fixed", 0)]
        : pcts.map((p, j) => split(`p${j}`, `P${j}`, `p${j}@x.com`, "percentage", p));
      if (fixedFirst) {
        // The rest as a percentage of the total, rounded to two decimals: mixed shares within rounding.
        splits[1] = split("p", "P", "p@x.com", "percentage", Math.round((pctBase / total) * 10000) / 100);
      }
      const inv = { ...inv0, splits };
      const server = sharesOf(splits, serverTotal(inv));
      const app = splits.map((s) => splitAmount(s, inv));
      expect(server).toEqual(app);
      const sumCents = app.reduce((a, b) => a + Math.round(b * 100), 0);
      if (!fixedFirst || Math.abs(Math.round(total * 100) - Math.round((fixed + shareOf(splits[1], total)) * 100)) <= 1) {
        expect(sumCents).toBe(Math.round(total * 100));
        expect(sharesTotal(splits, total)).toBe(Math.round(total * 100) / 100);
        expect(splitCheck(inv).ok).toBe(true);
      }
    }
  });

  it("$10.01 at 50/50 is $5.01 + $5.00: the last percentage payer takes the rounding", () => {
    const inv = invoice([split("a", "A", "a@x.com", "percentage", 50), split("b", "B", "b@x.com", "percentage", 50)], {
      lines: [{ id: "l", description: "x", quantity: 1, unitPrice: 10.01 }],
    });
    expect(inv.splits.map((s) => splitAmount(s, inv))).toEqual([5.01, 5]);
    const three = invoice(
      [split("a", "A", "a@x.com", "percentage", 33.33), split("b", "B", "b@x.com", "percentage", 33.33), split("c", "C", "c@x.com", "percentage", 33.34)],
      { lines: [{ id: "l", description: "x", quantity: 1, unitPrice: 100 }] },
    );
    expect(three.splits.map((s) => splitAmount(s, three))).toEqual([33.33, 33.33, 33.34]);
    const plan = planSplitSend({ splits: inv.splits, total: serverTotal(inv), again: false, lastSent: new Map(), allowed: () => true });
    expect(plan.ok && plan.toSend.map((p) => p.share)).toEqual([5.01, 5]);
    // Only the selected payer is emailed, but with the share it has among all payers.
    const one = planSplitSend({ splits: inv.splits, total: serverTotal(inv), again: false, only: ["b"], lastSent: new Map(), allowed: () => true });
    expect(one.ok && one.toSend.map((p) => p.share)).toEqual([5]);
  });

  it("a real gap is not hidden by the rounding fix-up", () => {
    expect(sharesOf([split("a", "A", "", "percentage", 50), split("b", "B", "", "percentage", 49)], 100)).toEqual([50, 49]);
    expect(sharesOf([split("a", "A", "", "fixed", 5), split("b", "B", "", "fixed", 5)], 10.01)).toEqual([5, 5]);
  });

  it("percentage shares round to the cent; fixed shares are the amount", () => {
    const inv = invoice([split("a", "A", "a@x.com", "percentage", 33.33), split("b", "B", "b@x.com", "fixed", 1000.5)], {
      lines: [{ id: "l", description: "x", quantity: 1, unitPrice: 1500.5 }],
    });
    expect(splitAmount(inv.splits[0], inv)).toBe(500.12);
    expect(splitAmount(inv.splits[1], inv)).toBe(1000.5);
  });
});

describe("shares must add up", () => {
  it("refuses with a plain reason and sends nobody", () => {
    const inv = invoice([split("a", "Ann", "ann@x.com", "percentage", 60), split("b", "Bob", "bob@x.com", "percentage", 30)]);
    const plan = planSplitSend({ splits: inv.splits, total: serverTotal(inv), again: false, lastSent: new Map(), allowed: () => true });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe("split-shares");
      expect(plan.reason === "split-shares" && plan.detail).toContain("Percentages add to 90%");
    }
    expect(splitCheck(inv).ok).toBe(false);
    expect(invoiceSendText({ sent: 0, reason: "split-shares", detail: "Percentages add to 90%, not 100%." })).toContain(
      "Not sent to anyone",
    );
  });

  it("fixed amounts must cover the total; a $0 invoice or a negative share is refused", () => {
    const inv = invoice([split("a", "Ann", "ann@x.com", "fixed", 1000), split("b", "Bob", "bob@x.com", "fixed", 400)]);
    expect(splitsSendProblem(inv.splits, serverTotal(inv))).toContain("Fixed amounts add to $1400.00");
    expect(splitsSendProblem([split("a", "A", "a@x.com", "fixed", 0)], 0)).toContain("$0");
    expect(splitsSendProblem([split("a", "A", "a@x.com", "fixed", 1600), split("b", "B", "b@x.com", "fixed", -100)], 1500)).toContain(
      "below zero",
    );
  });

  it("the panel says when they add up and how much is left", () => {
    const ok = invoice([split("a", "Ann", "ann@x.com", "percentage", 50), split("b", "Bob", "bob@x.com", "fixed", 750)]);
    expect(splitCheck(ok)).toMatchObject({ ok: true, total: 1500, covered: 1500, left: 0 });
    const short = invoice([split("a", "Ann", "ann@x.com", "fixed", 1000)]);
    expect(splitCheck(short)).toMatchObject({ ok: false, left: 500 });
  });
});

describe("one email per payer, with only that payer's share", () => {
  const inv = invoice([
    split("a", "Ann <b>Lee</b>", "ann@x.com", "percentage", 60),
    split("b", "Bob Ray", "bob@secret.com", "percentage", 40),
  ]);

  it("shows the invoice number, lines, total, the payer's share and How to pay", () => {
    const m = invoicePayerEmailPreview(inv, inv.splits[1], profile, false);
    expect(m.to).toBe("bob@secret.com");
    expect(m.subject).toBe("Invoice INV-1100 from Your Tree Company — your share $600");
    expect(m.body).toContain("Hi Bob Ray,");
    expect(m.body).toContain("Invoice INV-1100");
    expect(m.body).toContain("Oak removal: $1,200");
    expect(m.body).toContain("Stump grinding (2 x $150): $300");
    expect(m.body).toContain("Invoice total: $1,500");
    expect(m.body).toContain("Your share: $600 (40% of the total)");
    expect(m.body).toContain("How to pay:");
    expect(m.body).toContain("Zelle — send to 555-0199.");
    expect(m.body).not.toContain("Review us");
  });

  it("never has another payer's name, email or share", () => {
    const e = composeInvoiceEmailByHand({
      invoice: invoiceForEmail(inv),
      greeting: "Bob Ray",
      company,
      askReview: true,
      share: { name: "Bob Ray", amount: splitAmount(inv.splits[1], inv), kind: "percentage", percent: 40 },
    });
    for (const text of [e.text, e.html, e.subject, e.recordText]) {
      expect(text).not.toContain("Ann");
      expect(text).not.toContain("ann@x.com");
      expect(text).not.toContain("$900");
      expect(text).not.toContain("60%");
    }
    // The thread copy: no amounts, no email address.
    expect(e.recordText).toBe("Invoice INV-1100 emailed to Bob Ray (their share), with a request for a review.");
  });

  it("escapes the payer's name in the HTML", () => {
    const e = composeInvoiceEmailByHand({
      invoice: invoiceForEmail(inv),
      greeting: "",
      company,
      askReview: false,
      share: { name: "Ann <b>Lee</b>", amount: 900, kind: "fixed" },
    });
    expect(e.html).toContain("Hi Ann &lt;b&gt;Lee&lt;/b&gt;,");
    expect(e.html).not.toContain("<b>Lee</b>");
    expect(e.html).toContain("<b>Your share: $900</b>");
  });

  it("has the review section only when ticked", () => {
    const off = invoicePayerEmailPreview(inv, inv.splits[0], profile, false);
    const on = invoicePayerEmailPreview(inv, inv.splits[0], profile, true);
    expect(off.reviewButton).toBeUndefined();
    expect(on.reviewButton).toBe("https://g.page/r/example-test/review");
    expect(on.body).toContain("Review us: https://g.page/r/example-test/review");
  });

  it("a payer's email is one plain address, never a list", () => {
    expect(EMAIL_RE.test("bob@secret.com")).toBe(true);
    expect(EMAIL_RE.test("bob@secret.com,ann@x.com")).toBe(false);
    expect(EMAIL_RE.test("Bob <bob@secret.com>")).toBe(false);
    expect(EMAIL_RE.test("a;b@c.com")).toBe(false);
  });
});

describe("who is emailed on a press", () => {
  const four = invoice([
    split("a", "Ann", "ann@x.com", "percentage", 25),
    split("b", "Bob", "bob@x.com", "percentage", 25),
    split("c", "Cat", "cat@x.com", "percentage", 25),
    split("d", "Dan", "dan@x.com", "percentage", 25),
  ]);

  it("more than 3 payers in one press needs the two-step confirm", () => {
    const n = payerEmailCount(four, { again: false, knownSent: new Set() });
    expect(n).toBe(4);
    expect(needsDoubleConfirm(n)).toBe(true);
    expect(needsDoubleConfirm(payerEmailCount(four, { again: false, knownSent: new Set(["a"]) }))).toBe(false);
    expect(payerEmailCount(four, { again: true, knownSent: new Set(["a", "b", "c", "d"]) })).toBe(4);
    expect(payerEmailCount(four, { again: true, only: ["b"], knownSent: new Set(["b"]) })).toBe(1);
  });

  it("skips paid shares, missing emails and earlier sends, each with a reason", () => {
    const inv = invoice([
      split("a", "Ann", "ann@x.com", "percentage", 25, true),
      split("b", "Bob", "", "percentage", 25),
      split("c", "Cat", "cat@x.com", "percentage", 25),
      split("d", "Dan", "dan@x.com", "percentage", 25),
    ]);
    const plan = planSplitSend({
      splits: inv.splits,
      total: serverTotal(inv),
      again: false,
      lastSent: new Map([["c", "2026-11-17T10:00:00+00:00"]]),
      allowed: () => true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.payers.map((p) => [p.payer.id, p.skip])).toEqual([
      ["a", "paid"],
      ["b", "no-email"],
      ["c", "already-sent"],
      ["d", null],
    ]);
    expect(plan.toSend.map((p) => p.share)).toEqual([375]);
    expect(emailablePayers(inv).map((s) => s.id)).toEqual(["c", "d"]);
    // "Email again" includes the payer already emailed.
    const again = planSplitSend({ splits: inv.splits, total: 1500, again: true, lastSent: new Map([["c", "x"]]), allowed: () => true });
    expect(again.ok && again.toSend.map((p) => p.payer.id)).toEqual(["c", "d"]);
  });

  it("test mode blocks every recipient that is not a test address", () => {
    const plan = planSplitSend({
      splits: four.splits,
      total: serverTotal(four),
      again: false,
      lastSent: new Map(),
      allowed: (e) => recipientAllowed(e, undefined, GMAIL, "cat@x.com"),
    });
    expect(plan.ok && plan.payers.map((p) => p.skip)).toEqual([
      "blocked-test-mode",
      "blocked-test-mode",
      null,
      "blocked-test-mode",
    ]);
    const off = planSplitSend({
      splits: four.splits,
      total: serverTotal(four),
      again: false,
      lastSent: new Map(),
      allowed: (e) => recipientAllowed(e, "off", GMAIL, ""),
    });
    expect(off.ok && off.toSend.length).toBe(4);
    expect(payerSendText({ id: "a", sent: 0, reason: "blocked-test-mode" })).toContain("test mode");
  });

  it("refuses an unknown payer or a malformed split", () => {
    expect(planSplitSend({ splits: four.splits, total: 1500, again: true, only: ["zz"], lastSent: new Map(), allowed: () => true })).toEqual({
      ok: false,
      reason: "unknown-payer",
    });
    expect(planSplitSend({ splits: [{ id: "a:b", kind: "fixed", value: 1 }], total: 1, again: false, lastSent: new Map(), allowed: () => true })).toEqual({
      ok: false,
      reason: "bad-split",
    });
  });
});

describe("one sends-log row per payer", () => {
  it("the key holds the invoice, the payer and that payer's last real send", () => {
    expect(payerDedupeKey("inv-1", "s1", null)).toBe("invoice_emailed:inv-1:payer-s1:first");
    expect(payerDedupeKey("inv-1", "s1", "2026-11-17T10:00:00+00:00")).toBe(
      "invoice_emailed:inv-1:payer-s1:2026-11-17T10:00:00+00:00",
    );
  });

  it("reads each payer's last send; ignores the whole-invoice email and unsent rows", () => {
    const m = lastSentByPayer("inv-1", [
      { dedupe_key: "invoice_emailed:inv-1:first", status: "sent", sent_at: "2026-11-15T10:00:00+00:00" },
      { dedupe_key: "invoice_emailed:inv-1:payer-s1:first", status: "sent", sent_at: "2026-11-16T10:00:00+00:00" },
      { dedupe_key: "invoice_emailed:inv-1:payer-s1:2026-11-16T10:00:00+00:00", status: "sent", sent_at: "2026-11-17T10:00:00+00:00" },
      { dedupe_key: "invoice_emailed:inv-1:payer-s2:first", status: "failed", sent_at: null },
      { dedupe_key: "invoice_emailed:inv-10:payer-s3:first", status: "sent", sent_at: "2026-11-17T10:00:00+00:00" },
    ]);
    expect([...m.entries()]).toEqual([["s1", "2026-11-17T10:00:00+00:00"]]);
  });
});

describe("the app reads the per-payer result", () => {
  it("parses one result per payer and says how many were emailed", () => {
    const r = parseInvoiceSendReply({
      sent: 2,
      split: true,
      marked: true,
      payers: [
        { id: "a", sent: 1 },
        { id: "b", sent: 0, reason: "no-email" },
        { id: "c", sent: 1 },
      ],
    });
    expect(r.sent).toBe(2);
    expect(r.payers?.map((p) => p.reason ?? "sent")).toEqual(["sent", "no-email", "sent"]);
    expect(invoiceSendText(r)).toBe("Emailed 2 of 3 payers their share. See each payer below.");
    expect(sendMayHaveGone(r)).toBe(false);
    expect(invoiceSendText({ sent: 0, reason: "needs-confirm", count: 5 })).toContain("5 emails at once");
  });
});

describe("automatic emails never go to a split invoice", () => {
  const row = (splits: unknown) => ({
    id: "inv-1",
    customer_id: "c1",
    status: "unpaid",
    lines: [{ description: "x", quantity: 1, unitPrice: 100 }],
    emailed_at: "2026-11-16T10:00:00Z",
    splits,
  });
  it("no reminders or past-due emails for a split invoice", () => {
    expect(isSplitInvoice(row([{ id: "a" }]))).toBe(true);
    expect(isSplitInvoice(row([]))).toBe(false);
    expect(invoiceMayBeChased(row([]))).toBe(true);
    expect(invoiceMayBeChased(row([{ id: "a" }]))).toBe(false);
  });
  it("no automatic thank-you after payment for a split invoice (nor any other automatic email)", () => {
    const on = ["invoice_reminder", "overdue_escalation", "thank_you", "review_request"];
    const rules: RuleRow[] = defaultAutomations().map((r) => ({
      kind: r.kind,
      enabled: on.includes(r.kind),
      timing_days: r.kind === "thank_you" ? 1 : r.timingDays,
      template: r.template,
      label: r.label,
    }));
    const paidRow = (id: string, splits: unknown) => ({
      id,
      number: `INV-${id}`,
      customer_id: "c1",
      status: "paid",
      issued_date: "2026-11-01",
      due_date: "2026-11-02",
      paid_date: "2026-11-15",
      lines: [{ quantity: 1, unitPrice: 500 }],
      emailed_at: "2026-11-01T10:00:00Z",
      splits,
    });
    const unpaidRow = { ...paidRow("u", [{ id: "a" }]), status: "overdue", paid_date: null };
    const plan = planAutomaticEmails({
      today: "2026-11-16",
      since: "2026-11-01",
      rules,
      customers: [{ id: "c1", first_name: "Rae", email: "rae@example.com" }],
      invoices: [paidRow("whole", []), paidRow("split", [{ id: "a" }, { id: "b" }]), unpaidRow],
      estimates: [],
      jobs: [],
      phc: [],
      company: null,
    });
    expect(plan.emails.map((e) => e.dedupeKey)).toEqual(["thank_you:whole"]);
  });

  it("Needs invoice review explains it", () => {
    expect(REVIEW_REASONS.split_invoice).toContain("email each payer their share");
  });
});

describe("a paid invoice", () => {
  it("emails no payer when the whole invoice is marked paid", () => {
    const inv = invoice([split("a", "Ann", "ann@x.com", "percentage", 50), split("b", "Bob", "bob@x.com", "percentage", 50)], {
      status: "paid",
    });
    const plan = planSplitSend({ splits: inv.splits, total: 1500, again: true, lastSent: new Map(), allowed: () => true, invoicePaid: true });
    expect(plan.ok && plan.toSend.length).toBe(0);
    expect(emailablePayers(inv)).toEqual([]);
    expect(payerEmailCount(inv, { again: true, knownSent: new Set() })).toBe(0);
  });
});
