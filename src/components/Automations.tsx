import { useCallback, useEffect, useState } from "react";
import { invoiceTotal } from "../splits";
import { useStore } from "../store";
import { isOwnerLike } from "../permissions";
import {
  batchResultText,
  discardHeldBatch,
  loadAutomationStatus,
  loadHeldBatch,
  runOutcomeText,
  sendAutomationTest,
  sendHeldBatch,
  testResultText,
  type AutomationStatus,
  type HeldBatch,
} from "../automationStatus";
import { useDoubleConfirm } from "../useDoubleConfirm";
import { masterSwitchTexts, ruleOnTexts } from "../doubleConfirm";
import type { AutomationRule } from "../types";
import { jobValue } from "../jobValue";
import { addDaysISO, fmtDate, money, todayStr } from "../utils";
import { renderTemplate } from "../email";
import { orderedRules, pastDueTimingNote, sampleFor } from "../automationOrder";
import { pastDueEmailInvoices } from "../pastDueEmails";
import { businessToday } from "../overdueInvoice";
import { NEVER_AUTOMATIC } from "../../supabase/functions/run-automations/plan.ts";
import { inputCls, labelCls, linkCls, primaryBtn, secondaryBtn } from "./ui";

/** Plain-English rule names for the "sent recently" list. */
const RULE_NAMES: Record<string, string> = {
  invoice_reminder: "Invoice reminder",
  overdue_escalation: "Overdue invoice",
  estimate_reminder: "Estimate follow-up",
  job_reminder: "Day-before job reminder",
  thank_you: "Thank-you",
  review_request: "Review request",
  phc_renewal: "PHC renewal",
  invoice_send: "Invoice (job done)",
  estimate_sent: "Estimate",
  estimate_accepted: "Estimate accepted",
  invoice_emailed: "Invoice (emailed from the app)",
  customer_edit_suggested: "Suggested change (to the office)",
  day_plan: "Day plan (to the crew)",
  payment_receipt: "Payment receipt (split invoice)",
};

/**
 * Rules the page no longer shows: they never send by themselves
 * (run-automations NEVER_AUTOMATIC). Reviews are asked from the invoice
 * email by the person sending it (business rule).
 */
const HIDDEN_RULES: ReadonlySet<string> = NEVER_AUTOMATIC;

/** "Send a test to me" is one email (every rule's sample in it). */
const TEST_EMAILS = 1;

function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Automations page. Rules are configurable here (on/off, timing, message
 * template). The hourly run-automations check emails customers only
 * when the master switch "Automatic customer emails" is on (default
 * off) and the rule is on; each email lands in the customer's message
 * thread and the sends log, so nothing is sent twice.
 */
export default function Automations() {
  const {
    state,
    canEdit,
    saveAutomation,
    openInvoice,
    openEstimate,
    openJob,
    openCustomer,
    setView,
    viewer,
    setAutoEmails,
  } = useStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!savedField) return;
    const t = window.setTimeout(() => setSavedField(null), 2500);
    return () => window.clearTimeout(t);
  }, [savedField]);
  const showMoney = useStore().showMoney;
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testGmailMissing, setTestGmailMissing] = useState(false);
  // Owner's rule: more than 3 emails at once (and switching emails on)
  // need two "are you sure" steps, top then bottom of the screen.
  const { ask, confirmEmails, dialog: confirmDialog } = useDoubleConfirm();
  const [held, setHeld] = useState<HeldBatch | null>(null);
  const [heldOpen, setHeldOpen] = useState(false);
  const [heldBusy, setHeldBusy] = useState(false);
  const [heldMsg, setHeldMsg] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void loadAutomationStatus().then((s) => {
      setStatus(s);
      setStatusLoaded(true);
    });
    void loadHeldBatch().then(setHeld);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (!state) return null;
  const isAdmin = isOwnerLike(viewer?.appRole);
  const masterOn = state.settings.autoEmails === true;
  const gmailWaiting =
    testGmailMissing || status?.gmailReady === false;
  const sentWeek = status?.sentLast7Days ?? 0;
  const runTest = async () => {
    // One email to the business Gmail: every rule's sample is in it.
    if (!(await confirmEmails(TEST_EMAILS, "Samples of every rule go to the business Gmail only."))) return;
    setTesting(true);
    setTestMsg(null);
    void sendAutomationTest().then((r) => {
      setTesting(false);
      setTestMsg(testResultText(r));
      setTestGmailMissing(r.reason === "gmail-not-set-up");
      refresh();
    });
  };
  // Money is hidden for Crew viewers, same rule as everywhere else.

  const heldItems = held?.items ?? [];
  const sendHeld = async () => {
    if (!held || heldBusy) return;
    const n = heldItems.length;
    const names = heldItems
      .slice(0, 3)
      .map((x) => x.customerName || "Customer")
      .join(", ");
    const what = `These customers get an automatic email now: ${names}${n > 3 ? ` and ${n - 3} more` : ""}.`;
    const ok =
      n > 3
        ? await confirmEmails(n, what)
        : window.confirm(`Send ${n} email${n === 1 ? "" : "s"} now? ${what}`);
    if (!ok) return;
    setHeldBusy(true);
    setHeldMsg(null);
    const r = await sendHeldBatch(held.id, heldItems.map((x) => x.id), n);
    setHeldBusy(false);
    setHeldMsg(batchResultText(r));
    refresh();
  };
  const discardHeld = async () => {
    if (!held || heldBusy) return;
    const n = heldItems.length;
    if (
      !window.confirm(
        `Don't send these ${n} email${n === 1 ? "" : "s"}? They will not be sent. Emails that come due later still follow the rules.`,
      )
    )
      return;
    setHeldBusy(true);
    setHeldMsg(null);
    const r = await discardHeldBatch(held.id, heldItems.map((x) => x.id));
    setHeldBusy(false);
    setHeldMsg(r === null ? "Could not do that. Try again." : `Not sent: ${r} email${r === 1 ? "" : "s"} taken off the list.`);
    refresh();
  };

  const today = todayStr();
  // $0 invoices are never chased (the reminder rules skip them too).
  const openInvoices = state.invoices.filter((i) => i.status !== "paid" && invoiceTotal(i) > 0);
  // Past-due email: the same rule as the email itself (10 business days
  // past due, Denver, and at least the rule's Timing days).
  const pastDueFor = (rule: AutomationRule) =>
    pastDueEmailInvoices(state.invoices, rule.timingDays, businessToday());
  const paidInvoices = state.invoices.filter((i) => i.status === "paid");
  const awaitingEstimates = state.estimates.filter(
    (e) => e.status === "sent",
  );
  const waitingInvoices = state.invoices.filter(
    (i) => i.autoSendStatus === "waiting",
  );

  /** How many items a rule would act on, from live data. */
  const reach = (rule: AutomationRule): string => {
    switch (rule.kind) {
      case "invoice_send":
        return `${waitingInvoices.length} invoice${waitingInvoices.length === 1 ? "" : "s"} from jobs marked done, waiting to go`;
      case "invoice_reminder":
        return `${openInvoices.length} open invoice${openInvoices.length === 1 ? "" : "s"}`;
      case "review_request":
      case "thank_you":
        return `${paidInvoices.length} paid invoice${paidInvoices.length === 1 ? "" : "s"}`;
      case "estimate_reminder":
        return `${awaitingEstimates.length} estimate${awaitingEstimates.length === 1 ? "" : "s"} awaiting approval`;
      case "job_reminder": {
        const target = addDaysISO(today, rule.timingDays);
        const n = state.jobs.filter((j) => j.date === target).length;
        return `${n} job${n === 1 ? "" : "s"} scheduled for ${fmtDate(target)}`;
      }
      case "overdue_escalation": {
        const n = pastDueFor(rule).length;
        return `${n} invoice${n === 1 ? "" : "s"} past due by this rule`;
      }
      case "phc_renewal": {
        const renewing = state.phcPrograms.filter(
          (p) =>
            p.status === "active" &&
            p.renewalDate !== null &&
            p.renewalDate <= addDaysISO(today, rule.timingDays),
        );
        return `${renewing.length} PHC program${renewing.length === 1 ? "" : "s"} renewing within ${rule.timingDays} days`;
      }
    }
  };

  /** The actual records a rule would act on, each opening its editor. */
  const covered = (
    rule: AutomationRule,
  ): Array<{ key: string; label: string; open: () => void }> => {
    switch (rule.kind) {
      case "invoice_send":
        return waitingInvoices.map((i) => ({
          key: i.id,
          label: `${i.number} — waiting to be emailed`,
          open: () => openInvoice(i.id),
        }));
      case "invoice_reminder":
        return openInvoices.map((i) => ({
          key: i.id,
          label: `${i.number} — ${state.customers.find((c) => c.id === i.customerId)?.firstName ?? ""} ${state.customers.find((c) => c.id === i.customerId)?.lastName ?? ""}`,
          open: () => openInvoice(i.id),
        }));
      case "review_request":
      case "thank_you":
        return paidInvoices.map((i) => ({
          key: i.id,
          label: `${i.number} — paid`,
          open: () => openInvoice(i.id),
        }));
      case "estimate_reminder":
        return awaitingEstimates.map((e) => ({
          key: e.id,
          label: `${e.title} — awaiting approval`,
          open: () => openEstimate(e.id),
        }));
      case "job_reminder": {
        const target = addDaysISO(today, rule.timingDays);
        return state.jobs
          .filter((j) => j.date === target)
          .map((j) => {
            const v = jobValue(state, j);
            return {
              key: j.id,
              label: `${j.title} — ${fmtDate(j.date)}${v !== null && showMoney ? ` — ${money(v)}` : ""}`,
              open: () => openJob(j.id),
            };
          });
      }
      case "overdue_escalation":
        return pastDueFor(rule).map((i) => ({
          key: i.id,
          label: `${i.number} — overdue`,
          open: () => openInvoice(i.id),
        }));
      case "phc_renewal":
        return state.phcPrograms
          .filter(
            (p) =>
              p.status === "active" &&
              p.renewalDate !== null &&
              p.renewalDate <= addDaysISO(today, rule.timingDays),
          )
          .map((p) => ({
            key: p.id,
            label: `${p.name} — renews ${fmtDate(p.renewalDate ?? "")}`,
            open: () => setView("phc"),
          }));
    }
  };

  const sampleDate = fmtDate(addDaysISO(today, 1));
  // "Saved" shows next to the box that was just changed.
  const save = (rule: AutomationRule, field: string) => {
    saveAutomation(rule);
    setSavedField({ key: `${rule.id}:${field}`, at: Date.now() });
  };
  const savedMark = (ruleId: string, field: string) =>
    savedField?.key === `${ruleId}:${field}` ? (
      <span className="ml-2 text-xs font-semibold text-emerald-700" role="status">
        ✓ Saved
      </span>
    ) : null;

  return (
    <div className="space-y-4">
      {confirmDialog}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Automations</h1>
        <p className="mt-1 text-sm text-slate-600">
          Follow-up emails that go out by themselves from the business
          Gmail. Each one is saved in the customer&apos;s messages.
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Automatic customer emails
            </h2>
            <p className="text-sm text-slate-600">
              {masterOn
                ? "On: the rules switched on below email customers by themselves."
                : "Off: no customer gets an automatic email. Nothing is sent until you turn this on."}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={masterOn}
              disabled={!isAdmin}
              onChange={(e) => {
                const on = e.target.checked;
                if (!on) {
                  setAutoEmails(false);
                  return;
                }
                const rulesOn = state.automations.filter((r) => r.enabled && !HIDDEN_RULES.has(r.kind)).length;
                void ask(masterSwitchTexts(rulesOn)).then((ok) => {
                  if (ok) setAutoEmails(true);
                });
              }}
            />
            {masterOn ? "On" : "Off"}
          </label>
        </div>
        {!isAdmin && (
          <p className="mt-2 text-xs text-slate-500">
            Only an owner or manager can turn this on or off.
          </p>
        )}
        {gmailWaiting && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Waiting for Gmail: the Gmail app password is not saved yet, so
            nothing can be sent. Save it as the GitHub secret
            GMAIL_APP_PASSWORD; it is picked up on the next update.
          </p>
        )}
        <ul className="mt-3 space-y-1 text-sm text-slate-700">
          <li>
            Only things that come due after you turn this on are emailed.
            Older invoices and estimates are left alone.
          </li>
          <li>
            Sent between 8 AM and 6 PM, at most 150 a day, and at most one
            a day to the same customer.
          </li>
          <li>
            When more than 3 come due at once, none are sent by
            themselves: they wait here for you to review and approve.
          </li>
          <li>
            Every email ends with a line saying how to stop them. To stop
            them for one customer, tick &ldquo;No automatic emails&rdquo;
            on that customer.
          </li>
        </ul>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-semibold text-slate-900">Last check</p>
            {!statusLoaded ? (
              <p className="text-slate-500">Loading…</p>
            ) : (
              <>
                {status?.lastRun && (
                  <p className="text-slate-500">{whenText(status.lastRun.startedAt)}</p>
                )}
                <p className="text-slate-700">
                  {runOutcomeText(status?.lastRun ?? null)}
                </p>
              </>
            )}
            <p className="mt-2 text-slate-700">
              Sent in the last 7 days: <strong>{sentWeek}</strong>
            </p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-semibold text-slate-900">Send a test to me</p>
            <p className="text-slate-600">
              Emails every rule&apos;s message, with sample values, to the
              business Gmail only. No customer gets it.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => void runTest()}
                disabled={testing || !canEdit}
                className={primaryBtn()}
              >
                {testing ? "Sending…" : "Send a test to me"}
              </button>
              <button onClick={refresh} className={secondaryBtn()}>
                Refresh
              </button>
            </div>
            {testMsg && <p className="mt-2 text-slate-700">{testMsg}</p>}
          </div>
        </div>

        {held && heldItems.length > 0 && (
          <div className="mt-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-amber-950">
                {heldItems.length} email{heldItems.length === 1 ? " is" : "s are"} ready to send
              </p>
              <button
                type="button"
                onClick={() => setHeldOpen(!heldOpen)}
                className={`${secondaryBtn()} min-h-[44px]`}
              >
                {heldOpen ? "Hide" : "Review"}
              </button>
            </div>
            <p className="mt-1 text-amber-900">
              More than 3 came due at once, so none of them went out by
              themselves. Nothing is sent until you press Send them.
            </p>
            {heldOpen && (
              <>
                <ul className="mt-2 divide-y divide-amber-200">
                  {heldItems.map((x) => (
                    <li key={x.id} className="flex flex-wrap justify-between gap-2 py-1">
                      <button onClick={() => openCustomer(x.customerId)} className={linkCls()}>
                        {x.customerName || "Customer"}
                      </button>
                      <span className="text-slate-700">{RULE_NAMES[x.ruleKind] ?? x.ruleKind}</span>
                    </li>
                  ))}
                </ul>
                {gmailWaiting && (
                  <p className="mt-2 text-amber-900">
                    Waiting for Gmail: these cannot be sent until the Gmail
                    app password is saved.
                  </p>
                )}
                {held.status === "sending" && (
                  <p className="mt-2 text-amber-900">Being sent now… press Refresh in a minute.</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void sendHeld()}
                    disabled={!canEdit || heldBusy || gmailWaiting || !masterOn || held.status !== "waiting"}
                    className={`${primaryBtn()} min-h-[44px]`}
                  >
                    {heldBusy ? "Working…" : "Send them"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void discardHeld()}
                    disabled={!canEdit || heldBusy || held.status !== "waiting"}
                    className={`${secondaryBtn()} min-h-[44px]`}
                  >
                    Don&apos;t send
                  </button>
                </div>
                {!masterOn && (
                  <p className="mt-2 text-amber-900">
                    Automatic customer emails are off, so these cannot be sent.
                  </p>
                )}
              </>
            )}
            {heldMsg && <p className="mt-2 text-slate-800">{heldMsg}</p>}
          </div>
        )}
        {!held && heldMsg && <p className="mt-3 text-sm text-slate-800">{heldMsg}</p>}

        {(status?.recent ?? []).length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-semibold text-slate-900">
              Sent recently
            </p>
            <ul className="mt-1 divide-y divide-slate-100 text-sm">
              {(status?.recent ?? []).slice(0, 30).map((x) => (
                <li key={x.id} className="flex flex-wrap justify-between gap-2 py-1">
                  <span>
                    <button
                      onClick={() => openCustomer(x.customerId)}
                      className={linkCls()}
                    >
                      {x.customerName || "Customer"}
                    </button>{" "}
                    <span className="text-slate-600">
                      · {RULE_NAMES[x.ruleKind] ?? x.ruleKind}
                    </span>
                  </span>
                  <span className="text-slate-500">
                    {x.status === "sent"
                      ? whenText(x.sentAt ?? x.createdAt)
                      : x.status === "failed"
                        ? "Not sent (will try again)"
                        : "Sending…"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div>
        {!canEdit && (
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
            Only the office and owners can change automatic email
            rules.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
          <span className="font-semibold text-slate-900">Review requests are not automatic.</span>{" "}
          Ask for a review from the invoice email: Invoices → open the invoice
          → tick &ldquo;Ask for a review in this email&rdquo; → Email invoice.
          The review link is set in Invoice settings.
        </p>
        {orderedRules(state.automations.filter((r) => !HIDDEN_RULES.has(r.kind))).map((rule) => (
          <section
            key={rule.id}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  {rule.label}
                </h2>
                <p className="text-sm text-slate-600">{rule.description}</p>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const on = e.target.checked;
                    // While emails are on, a rule switched on starts emailing customers.
                    if (on && masterOn) {
                      void ask(ruleOnTexts(rule.label)).then((ok) => {
                        if (ok) save({ ...rule, enabled: true }, "enabled");
                      });
                      return;
                    }
                    save({ ...rule, enabled: on }, "enabled");
                  }}
                />
                {rule.enabled ? "On" : "Off"}
                {savedMark(rule.id, "enabled")}
              </label>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {rule.kind === "invoice_send" ? (
                <div className="text-sm text-slate-600">
                  <p className="font-semibold text-slate-900">When</p>
                  <p>
                    2 hours after the job is marked Done (between 8 AM and
                    6 PM). Reopening the job, editing the invoice or
                    pressing Stop on it cancels the email.
                  </p>
                </div>
              ) : (
              <div>
                <label className={labelCls()}>
                  Timing (days){savedMark(rule.id, "timing")}
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className={inputCls()}
                  value={rule.timingDays}
                  disabled={!canEdit}
                  onChange={(e) =>
                    save(
                      {
                        ...rule,
                        timingDays: Number(e.target.value),
                      },
                      "timing",
                    )
                  }
                />
                {rule.kind === "overdue_escalation" ? (
                  <p className="mt-1 text-xs text-slate-600">
                    {pastDueTimingNote(rule.timingDays)}
                  </p>
                ) : null}
              </div>
              )}
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-900">Right now</p>
                {rule.enabled && masterOn ? (
                  <p className="text-slate-700">
                    On. Looks at {reach(rule)}; each customer is emailed
                    once, when it comes due.
                  </p>
                ) : rule.enabled ? (
                  <p className="text-slate-500">
                    Ready, but automatic customer emails are off (top of
                    the page). Looks at {reach(rule)}.
                  </p>
                ) : (
                  <p className="text-slate-500">
                    Off: this rule sends nothing. Would look at{" "}
                    {reach(rule)}.
                  </p>
                )}
                {(() => {
                  const items = covered(rule);
                  if (items.length === 0) return null;
                  const expanded = expandedId === rule.id;
                  return (
                    <div className="mt-2">
                      <button
                        onClick={() =>
                          setExpandedId(expanded ? null : rule.id)
                        }
                        className={secondaryBtn()}
                      >
                        {expanded
                          ? "Hide items"
                          : `Show ${items.length} item${items.length === 1 ? "" : "s"}`}
                      </button>
                      {expanded && (
                        <ul className="mt-2 space-y-1">
                          {items.map((item) => (
                            <li key={item.key}>
                              <button
                                onClick={item.open}
                                className={linkCls()}
                              >
                                {item.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="mt-3">
              <label className={labelCls()}>
                Message template{savedMark(rule.id, "template")}
              </label>
              <textarea
                className={inputCls()}
                rows={2}
                value={rule.template}
                disabled={!canEdit}
                onChange={(e) =>
                  save({ ...rule, template: e.target.value }, "template")
                }
              />
              <p className="mt-1 text-xs text-slate-500">
                Placeholders: {"{customer}"} {"{amount}"} {"{title}"}{" "}
                {"{date}"}
              </p>
            </div>

            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Preview with sample values
              </p>
              <p className="mt-1 text-sm text-slate-800">
                {renderTemplate(rule.template, sampleFor(rule.kind, sampleDate))}
              </p>
            </div>
          </section>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        More rules can be added the same way — for example a seasonal
        service reminder (EAB treatments every spring) or a
        &ldquo;we&apos;re in your neighborhood&rdquo; note when a crew is
        booked nearby.
      </p>
    </div>
  );
}
