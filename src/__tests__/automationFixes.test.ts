import { describe, expect, it, vi } from "vitest";
import { mailErrorKind } from "../../supabase/functions/_shared/mailErrors.ts";
import {
  addDays,
  invoiceMayBeChased,
  planAutomaticEmails,
  type PlanInput,
  type PlannedEmail,
  type RuleRow,
} from "../../supabase/functions/run-automations/plan.ts";
import {
  emailDoneInvoice,
  emailPlanned,
  type Rpc,
  type Send,
} from "../../supabase/functions/run-automations/steps.ts";
import { ALREADY_EMAILED, stopAutoSend } from "../autoInvoice";
import { runOutcomeText } from "../automationStatus";
import { defaultAutomations } from "../data/seed";

vi.mock("../data/supabaseClient", () => ({ supabase: null }));

// ---------- Gmail errors ----------
describe("mailErrorKind", () => {
  it("account-wide problems stop the run", () => {
    expect(mailErrorKind({ code: "EAUTH", responseCode: 535 })).toBe("account");
    expect(mailErrorKind({ code: "ECONNECTION" })).toBe("account");
    expect(mailErrorKind({ code: "ETIMEDOUT" })).toBe("account");
    expect(mailErrorKind({ code: "ESOCKET" })).toBe("account");
    expect(mailErrorKind({ code: "EMESSAGE", responseCode: 421 })).toBe("account");
    expect(mailErrorKind({ code: "EMESSAGE", responseCode: 454 })).toBe("account");
    expect(mailErrorKind({ code: "EENVELOPE", responseCode: 550, response: "550-5.4.5 Daily user sending limit exceeded." })).toBe(
      "account",
    );
  });

  it("a problem with one email is only that email", () => {
    expect(mailErrorKind({ code: "EENVELOPE", responseCode: 550, response: "550-5.1.1 The email account does not exist." })).toBe(
      "failed",
    );
    expect(mailErrorKind({ code: "EENVELOPE", responseCode: 553 })).toBe("failed");
    expect(mailErrorKind(new Error("odd"))).toBe("failed");
    expect(mailErrorKind(null)).toBe("failed");
    expect(mailErrorKind("text")).toBe("failed");
  });
});

// ---------- Reminders only for invoices the customer has ----------
const TODAY = "2026-11-16";

function rules(on: string[]): RuleRow[] {
  return defaultAutomations().map((r) => ({
    kind: r.kind,
    enabled: on.includes(r.kind),
    timing_days: r.timingDays,
    template: r.template,
    label: r.label,
  }));
}

const inv = (extra: Record<string, unknown> = {}) => ({
  id: "1",
  number: "INV-1",
  customer_id: "c1",
  status: "unpaid",
  issued_date: "2026-09-01",
  due_date: addDays("2026-09-01", 30),
  paid_date: null,
  lines: [{ quantity: 1, unitPrice: 500 }],
  tax_rate: 0,
  discount_type: "none",
  discount_value: 0,
  ...extra,
});

function plan(invoice: ReturnType<typeof inv>, kind: string) {
  // due recently for that rule (within the catch-up window)
  const issued = kind === "invoice_reminder" ? "2026-11-05" : "2026-10-01";
  invoice = { ...invoice, issued_date: issued, due_date: addDays(issued, 30) };
  const input: PlanInput = {
    today: TODAY,
    since: "2026-09-01",
    rules: rules([kind]),
    customers: [{ id: "c1", first_name: "Ann", email: "ann@example.com" }],
    invoices: [invoice],
    estimates: [],
    jobs: [],
    phc: [],
    company: { name: "Your Tree Company" },
  };
  return planAutomaticEmails(input).emails.map((e) => e.kind);
}

describe("invoice reminders and past-due emails", () => {
  for (const kind of ["invoice_reminder", "overdue_escalation"]) {
    it(`${kind}: sent for an office invoice and an emailed "Done" invoice`, () => {
      expect(plan(inv(), kind)).toEqual([kind]);
      expect(plan(inv({ auto_send_status: "sent" }), kind)).toEqual([kind]);
    });
    it(`${kind}: never for a "Done" invoice the customer did not get, or a $0 invoice`, () => {
      for (const st of ["waiting", "sending", "stopped"]) expect(plan(inv({ auto_send_status: st }), kind)).toEqual([]);
      expect(plan(inv({ lines: [] }), kind)).toEqual([]);
      expect(plan(inv({ lines: [{ quantity: 1, unitPrice: 0 }] }), kind)).toEqual([]);
    });
  }

  it("invoiceMayBeChased", () => {
    expect(invoiceMayBeChased(inv())).toBe(true);
    expect(invoiceMayBeChased(inv({ auto_send_status: null }))).toBe(true);
    expect(invoiceMayBeChased(inv({ auto_send_status: "stopped" }))).toBe(false);
    expect(invoiceMayBeChased(inv({ discount_type: "fixed", discount_value: 500 }))).toBe(false);
  });
});

// ---------- One email at a time ----------
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
const compose = () => ({ subject: "Invoice INV-1: $500.00", text: "t", html: "<p>t</p>" });
const sendWith = (r: Awaited<ReturnType<Send>>): Send => async () => r;
const noPrior = async () => null;

describe("emailDoneInvoice", () => {
  it("sent: records the send and marks the invoice sent", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), noPrior)).toBe("sent");
    expect(f.names()).toEqual(["auto_invoice_send_claim", "claim_automation_send", "finish_automation_send", "auto_invoice_send_finish"]);
    expect(f.calls[2].args.p_ok).toBe(true);
    expect(f.calls[3].args.p_status).toBe("sent");
  });

  it("failed: counts a try and the invoice waits for the next hour", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("failed"), noPrior)).toBe("failed");
    expect(f.calls[2]).toMatchObject({ fn: "finish_automation_send", args: { p_ok: false } });
    expect(f.calls[3].args.p_status).toBe("waiting");
  });

  it("Gmail refused the account: the claim is given back, no try counted", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("account"), noPrior)).toBe("account");
    expect(f.names()).toEqual(["auto_invoice_send_claim", "claim_automation_send", "release_automation_send", "auto_invoice_send_finish"]);
    expect(f.calls[2].args).toEqual({ p_send_id: "s1" });
    expect(f.calls[3].args.p_status).toBe("waiting");
  });

  it("not claimed: nothing else happens", async () => {
    const f = fakeRpc({ auto_invoice_send_claim: false });
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), noPrior)).toBe("taken");
    expect(f.names()).toEqual(["auto_invoice_send_claim"]);
  });

  it("already emailed by a check that stopped half way: marked sent, not emailed again", async () => {
    const f = fakeRpc({ claim_automation_send: null });
    const send = vi.fn(sendWith("sent"));
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, send, async () => "sent")).toBe("settled");
    expect(send).not.toHaveBeenCalled();
    expect(f.calls.at(-1)?.args.p_status).toBe("sent");
  });

  it("no email address: stopped", async () => {
    const f = fakeRpc({});
    const step = await emailDoneInvoice(f.rpc, "co", { ...doneInv, customer: { ...cust, email: "" } }, compose, sendWith("sent"), noPrior);
    expect(step).toBe("skipped");
    expect(f.calls[1].args).toMatchObject({ p_status: "stopped", p_note: "no-email" });
  });

  it("an error after the claim puts the invoice back to waiting", async () => {
    const f = fakeRpc({}, ["claim_automation_send"]);
    await expect(emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), noPrior)).rejects.toThrow();
    expect(f.calls.at(-1)).toMatchObject({ fn: "auto_invoice_send_finish", args: { p_status: "waiting" } });
  });

  it("an error before the email marks the send failed and the invoice waiting", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    const send = vi.fn(sendWith("sent"));
    const broken = () => {
      throw new Error("compose");
    };
    await expect(emailDoneInvoice(f.rpc, "co", doneInv, broken, send, noPrior)).rejects.toThrow("compose");
    expect(send).not.toHaveBeenCalled();
    expect(f.names()).toEqual(["auto_invoice_send_claim", "claim_automation_send", "finish_automation_send", "auto_invoice_send_finish"]);
    expect(f.calls[2].args).toMatchObject({ p_send_id: "s1", p_ok: false });
    expect(f.calls[3].args.p_status).toBe("waiting");
  });

  it("an error marking it sent after the email went: never back to waiting (audit 3: Email invoice could send it again)", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" }, ["auto_invoice_send_finish"]);
    await expect(emailDoneInvoice(f.rpc, "co", doneInv, compose, sendWith("sent"), noPrior)).rejects.toThrow();
    // the send was recorded as sent; it is not marked failed afterwards
    expect(f.calls.filter((c) => c.fn === "finish_automation_send").map((c) => c.args.p_ok)).toEqual([true]);
    expect(f.calls.at(-1)).toMatchObject({ fn: "auto_invoice_send_finish", args: { p_status: "sent" } });
    expect(f.calls.some((c) => c.args.p_status === "waiting")).toBe(false);
  });

  it("a mailer that throws counts as a failed email", async () => {
    const f = fakeRpc({ claim_automation_send: "s1" });
    const send: Send = async () => {
      throw new Error("x");
    };
    expect(await emailDoneInvoice(f.rpc, "co", doneInv, compose, send, noPrior)).toBe("failed");
  });
});

describe("emailPlanned", () => {
  const m: PlannedEmail = {
    kind: "invoice_reminder",
    dedupeKey: "invoice_reminder:1",
    targetId: "1",
    customerId: "c1",
    customerName: "Ann",
    to: "ann@example.com",
    subject: "s",
    text: "t",
    html: "h",
    record: "Automatic email: payment reminder for INV-1",
    jobId: null,
    estimateId: null,
    dueDay: TODAY,
  };
  it("account: released, not finished", async () => {
    const f = fakeRpc({ claim_automation_send: "s9" });
    expect(await emailPlanned(f.rpc, "co", m, sendWith("account"))).toBe("account");
    expect(f.names()).toEqual(["claim_automation_send", "release_automation_send"]);
  });
  it("sent and failed are recorded", async () => {
    for (const r of ["sent", "failed"] as const) {
      const f = fakeRpc({ claim_automation_send: "s9" });
      expect(await emailPlanned(f.rpc, "co", m, sendWith(r))).toBe(r);
      expect(f.calls[1]).toMatchObject({ fn: "finish_automation_send", args: { p_ok: r === "sent" } });
    }
  });
  it("taken elsewhere: not emailed", async () => {
    const f = fakeRpc({ claim_automation_send: null });
    const send = vi.fn(sendWith("sent"));
    expect(await emailPlanned(f.rpc, "co", m, send)).toBe("taken");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("runOutcomeText", () => {
  it("explains Gmail refusing the account", () => {
    const t = runOutcomeText({ outcome: "gmail-refused", sent: 0, failed: 0, skipped: 0, waiting: 0 } as never);
    expect(t).toContain("Gmail refused");
    expect(t).toContain("next hour");
  });
});

// ---------- Stop ----------
function fakeClient(result: { data: unknown; error: unknown }) {
  const seen: unknown[][] = [];
  const q = {
    update: (...a: unknown[]) => (seen.push(["update", ...a]), q),
    eq: (...a: unknown[]) => (seen.push(["eq", ...a]), q),
    select: (...a: unknown[]) => (seen.push(["select", ...a]), Promise.resolve(result)),
  };
  return { client: { from: () => q } as never, seen };
}

describe("stopAutoSend", () => {
  it("stopped: only a waiting invoice, and it checks a row changed", async () => {
    const f = fakeClient({ data: [{ id: "i1" }], error: null });
    expect(await stopAutoSend("i1", f.client)).toEqual({ error: null, reload: false });
    expect(f.seen).toContainEqual(["eq", "auto_send_status", "waiting"]);
    expect(f.seen).toContainEqual(["select", "id"]);
  });
  it("already emailed or being emailed: says so and reloads", async () => {
    const f = fakeClient({ data: [], error: null });
    expect(await stopAutoSend("i1", f.client)).toEqual({ error: ALREADY_EMAILED, reload: true });
    expect(ALREADY_EMAILED).toBe("It was already emailed or is being emailed now.");
  });
  it("no connection: try again", async () => {
    const f = fakeClient({ data: null, error: { message: "x" } });
    const r = await stopAutoSend("i1", f.client);
    expect(r.reload).toBe(false);
    expect(r.error).toMatch(/try again/);
  });
});
