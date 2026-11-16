import { useState } from "react";
import { useStore } from "../store";
import { isOwnerLike } from "../permissions";
import { paymentDetails } from "../payments";
import { reviewLink } from "../../supabase/functions/_shared/invoiceEmail.ts";
import { companyLogoSrc } from "../company";
import { termsLabel } from "../utils";
import type { AutomationKind, CompanyProfile } from "../types";
import { inputCls, labelCls, secondaryBtn } from "./ui";

/** The automatic emails that are about invoices, in the order they happen. */
export const INVOICE_EMAIL_KINDS: readonly AutomationKind[] = [
  "invoice_send",
  "invoice_reminder",
  "overdue_escalation",
  "thank_you",
];

/** When each invoice email goes, in plain words. */
export function invoiceEmailTiming(kind: AutomationKind, days: number): string {
  const d = `${days} day${days === 1 ? "" : "s"}`;
  switch (kind) {
    case "invoice_send":
      return "2 hours after a job is marked Done";
    case "invoice_reminder":
      return `${d} after the invoice is issued, while unpaid`;
    case "overdue_escalation":
      return `once overdue (10 business days past the due date), and at least ${d} past it`;
    case "thank_you":
      return `${d} after it is paid`;
    default:
      return "";
  }
}

const TERMS = [0, 15, 30, 45, 60];

/**
 * Every setting that changes an invoice, in one place on the Invoices
 * page: payment terms, how customers pay (Zelle / check), the review
 * link for the optional "Review us" button, the company
 * details printed on the invoice, and the automatic invoice emails.
 * Terms and how-to-pay are edited here (owners and managers; the
 * database only lets them change settings). Company name/logo and the
 * emails link to where they are changed, because the emails have their
 * own "are you sure" steps on the Automations page.
 */
export default function InvoiceSettingsPanel() {
  const { state, viewer, setInvoiceSettings, setCalendarSettings, setView } =
    useStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{
    zelleNumber: string;
    checkPayee: string;
    checkMailingAddress: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [reviewDraft, setReviewDraft] = useState<string | null>(null);
  const [reviewSaved, setReviewSaved] = useState(false);
  if (!state) return null;
  const mayChange = isOwnerLike(viewer?.appRole);
  const company: CompanyProfile | null | undefined = state.settings.company;
  const pay = paymentDetails(company);
  const payValue = draft ?? pay;
  const commercial = state.settings.commercialTermsDays ?? 30;
  const residential = state.settings.residentialTermsDays ?? 0;
  const masterOn = state.settings.autoEmails === true;
  const rules = INVOICE_EMAIL_KINDS.map((k) =>
    state.automations.find((r) => r.kind === k),
  ).filter((r): r is NonNullable<typeof r> => !!r);

  const savedReview = (company?.reviewUrl ?? "").trim();
  const reviewValue = reviewDraft ?? savedReview;
  const reviewTrim = reviewValue.trim();
  const reviewOk = reviewTrim === "" || reviewLink(reviewTrim) !== "";
  const reviewDirty = reviewDraft !== null && reviewTrim !== savedReview;
  const saveReview = () => {
    if (!company || !reviewDirty || !reviewOk) return;
    setCalendarSettings({
      company: { ...company, reviewUrl: reviewTrim === "" ? "" : reviewLink(reviewTrim) },
    });
    setReviewDraft(null);
    setReviewSaved(true);
    window.setTimeout(() => setReviewSaved(false), 3000);
  };

  const payDirty =
    draft !== null &&
    (draft.zelleNumber.trim() !== pay.zelleNumber ||
      draft.checkPayee.trim() !== pay.checkPayee ||
      draft.checkMailingAddress.trim() !== pay.checkMailingAddress);

  const savePay = () => {
    if (!company || !draft) return;
    setCalendarSettings({
      company: {
        ...company,
        zelleNumber: draft.zelleNumber.trim(),
        checkPayee: draft.checkPayee.trim(),
        checkMailingAddress: draft.checkMailingAddress.trim(),
      },
    });
    setDraft(null);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
  };

  const termsSelect = (
    value: number,
    onChange: (n: number) => void,
    label: string,
  ) => (
    <div>
      <label className={labelCls()}>{label}</label>
      {mayChange ? (
        <select
          className={inputCls()}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {TERMS.map((t) => (
            <option key={t} value={t}>
              {termsLabel(t)}
            </option>
          ))}
        </select>
      ) : (
        <p className="text-sm text-slate-800">{termsLabel(value)}</p>
      )}
    </div>
  );

  const payWays = [
    pay.zelleNumber && "Zelle",
    pay.checkPayee && "Check",
  ].filter(Boolean);
  const emailsOn = rules.filter((r) => masterOn && r.enabled).length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-base font-bold text-slate-900">
          Invoice settings
        </span>
        <span className="text-sm font-semibold text-emerald-700">
          {open ? "Hide" : "Show all"}
        </span>
      </button>
      <p className="mt-1 text-sm text-slate-600">
        Commercial: {termsLabel(commercial)} · Residential:{" "}
        {termsLabel(residential)} · How to pay:{" "}
        {payWays.length ? payWays.join(" and ") : "not set"} · Invoice
        emails: {emailsOn} of {rules.length} on
      </p>

      {open && (
        <div className="mt-4 space-y-5">
          {/* 1. Payment terms */}
          <div>
            <p className="text-sm font-bold text-slate-900">Payment terms</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {termsSelect(
                commercial,
                (n) => setInvoiceSettings({ commercialTermsDays: n }),
                "Commercial — default payment terms",
              )}
              {termsSelect(
                residential,
                (n) => setInvoiceSettings({ residentialTermsDays: n }),
                "Residential — default payment terms",
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              New invoices fill their due date from these terms (issue date
              + terms). Change the due date on any single invoice without
              touching these.
            </p>
          </div>

          {/* 2. How customers pay */}
          <div className="border-t border-slate-200 pt-4">
            <p className="text-sm font-bold text-slate-900">
              How customers pay
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Shown in the &ldquo;How to pay&rdquo; box on every invoice and
              invoice email. Leave one blank to leave it off.
            </p>
            {mayChange && company ? (
              <>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls()}>Zelle number or email</label>
                    <input
                      className={inputCls()}
                      value={payValue.zelleNumber}
                      onChange={(e) => {
                        setDraft({ ...payValue, zelleNumber: e.target.value });
                        setSaved(false);
                      }}
                    />
                  </div>
                  <div>
                    <label className={labelCls()}>Checks payable to</label>
                    <input
                      className={inputCls()}
                      value={payValue.checkPayee}
                      onChange={(e) => {
                        setDraft({ ...payValue, checkPayee: e.target.value });
                        setSaved(false);
                      }}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelCls()}>Mail checks to</label>
                    <input
                      className={inputCls()}
                      value={payValue.checkMailingAddress}
                      onChange={(e) => {
                        setDraft({
                          ...payValue,
                          checkMailingAddress: e.target.value,
                        });
                        setSaved(false);
                      }}
                    />
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={!payDirty}
                    onClick={savePay}
                    className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
                  >
                    Save how to pay
                  </button>
                  {saved && (
                    <span className="text-sm font-semibold text-emerald-700">
                      ✓ Saved
                    </span>
                  )}
                </div>
              </>
            ) : (
              <ul className="mt-2 space-y-0.5 text-sm text-slate-800">
                <li>Zelle: {pay.zelleNumber || "not set"}</li>
                <li>Checks payable to: {pay.checkPayee || "not set"}</li>
                <li>Mail checks to: {pay.checkMailingAddress || "not set"}</li>
              </ul>
            )}
          </div>

          {/* 2b. Review link for the "Review us" button */}
          <div className="border-t border-slate-200 pt-4">
            <p className="text-sm font-bold text-slate-900">
              Review link (Google)
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              The &ldquo;Review us&rdquo; button in an invoice email. It is
              only added when the person sending the invoice ticks
              &ldquo;Ask for a review in this email&rdquo; — never
              automatically. Paste your Google review link (it starts with
              https://).
            </p>
            {mayChange && company ? (
              <>
                <div className="mt-2">
                  <label className={labelCls()} htmlFor="review-url">
                    Review link (Google)
                  </label>
                  <input
                    id="review-url"
                    type="url"
                    inputMode="url"
                    className={inputCls()}
                    placeholder="https://g.page/r/…/review"
                    value={reviewValue}
                    onChange={(e) => {
                      setReviewDraft(e.target.value);
                      setReviewSaved(false);
                    }}
                  />
                  {!reviewOk && (
                    <p className="mt-1 text-xs font-semibold text-red-700">
                      That doesn&apos;t look like a web link. It must start
                      with https://
                    </p>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={!reviewDirty || !reviewOk}
                    onClick={saveReview}
                    className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
                  >
                    Save review link
                  </button>
                  {reviewSaved && (
                    <span className="text-sm font-semibold text-emerald-700">
                      ✓ Saved
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-2 break-all text-sm text-slate-800">
                {savedReview || "not set"}
              </p>
            )}
          </div>

          {/* 3. Company details printed on the invoice */}
          <div className="border-t border-slate-200 pt-4">
            <p className="text-sm font-bold text-slate-900">
              On the top of every invoice
            </p>
            <div className="mt-2 flex items-start gap-3">
              <img
                src={companyLogoSrc(state)}
                alt=""
                className="h-12 w-12 rounded object-contain"
              />
              <ul className="space-y-0.5 text-sm text-slate-800">
                <li className="font-semibold">
                  {company?.name || "Business name not set"}
                </li>
                <li>Phone: {company?.phone || "not set"}</li>
                <li>Email: {company?.email || "not set"}</li>
              </ul>
            </div>
            {mayChange && (
              <button
                type="button"
                className={`${secondaryBtn()} mt-2`}
                onClick={() => setView("schedule")}
              >
                Change in Schedule → Calendar settings → Company
              </button>
            )}
          </div>

          {/* 4. Automatic invoice emails */}
          <div className="border-t border-slate-200 pt-4">
            <p className="text-sm font-bold text-slate-900">
              Automatic invoice emails
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Automatic customer emails (master switch):{" "}
              <span
                className={
                  masterOn
                    ? "font-semibold text-emerald-700"
                    : "font-semibold text-slate-700"
                }
              >
                {masterOn ? "on" : "off — nothing is emailed"}
              </span>
            </p>
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {rules.map((r) => {
                const sending = masterOn && r.enabled;
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {r.label}
                      </p>
                      <p className="text-xs text-slate-500">
                        {invoiceEmailTiming(r.kind, r.timingDays)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        sending
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {sending
                        ? "On"
                        : r.enabled
                          ? "On, but master switch is off"
                          : "Off"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className={`${secondaryBtn()} mt-2`}
              onClick={() => setView("automations")}
            >
              Change emails, timing and wording in Automations
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
