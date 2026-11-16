/**
 * The customer's private accept page — /accept/<token>.
 *
 * Public (no login), opened from the "Review and accept" button in the
 * estimate email. Everything goes through the estimate-accept Edge
 * Function: it looks the token up (only its SHA-256 is stored), shows
 * ONLY that estimate (company name/phone/email, the options with
 * prices, notes, payment terms, the customer's first name), and accepts
 * it after the Turnstile spam check. The page never reads the database
 * itself. Netlify serves index.html for every path, so this route works
 * on a fresh load.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "../data/supabaseClient";
import { turnstileConfigured } from "../config";
import { estimateTotals, discountLabel } from "../email";
import { money } from "../utils";
import type { DiscountType } from "../types";
import { inputCls, labelCls, primaryBtn } from "./ui";
import Turnstile from "./Turnstile";

interface Line {
  description: string;
  quantity: number;
  unitPrice: number;
}
interface Option {
  id: string;
  label: string;
  description: string;
  lines: Line[];
}
interface PageEstimate {
  title: string;
  created_date?: string | null;
  notes?: string | null;
  tax_rate: number;
  discount_type: DiscountType;
  discount_value: number;
  lines: Line[];
  options: Option[];
}
interface Company {
  name?: string;
  phone?: string;
  email?: string;
}
interface View {
  status: string;
  company: Company | null;
  estimate: PageEstimate | null;
  greeting: string;
  termsDays: number | null;
  billingTerms: string;
  expiresAt: string | null;
  acceptedOptionId: string | null;
  acceptedAt: string | null;
}

const EMPTY_VIEW: View = {
  status: "",
  company: null,
  estimate: null,
  greeting: "",
  termsDays: null,
  billingTerms: "",
  expiresAt: null,
  acceptedOptionId: null,
  acceptedAt: null,
};

const NOT_OPEN: Record<string, { title: string; text: string }> = {
  "not-found": {
    title: "This link is not valid",
    text: "Please check the link in your email. If it still does not work, call or email us.",
  },
  changed: {
    title: "This estimate was updated",
    text: "We changed this estimate after sending it, so this link no longer works. Please use the newest email from us, or get in touch.",
  },
  closed: {
    title: "This estimate is no longer open",
    text: "Please call or email us if you would still like the work done.",
  },
  expired: {
    title: "This link has expired",
    text: "Links work for 60 days. Call or email us and we will send you a fresh one.",
  },
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function niceDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Reads the error text the function sends with a 4xx. */
async function errorText(err: unknown): Promise<string | null> {
  try {
    const ctx = (err as { context?: Response }).context;
    if (ctx && ctx.status >= 400 && ctx.status < 500) {
      const body = (await ctx.json()) as { error?: unknown; status?: unknown };
      if (typeof body.error === "string") return body.error;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export default function AcceptEstimate({ token }: { token: string | null }) {
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [optionId, setOptionId] = useState<string>("");
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedLabel, setAcceptedLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    // Even with no usable link, ask: the answer carries the business's
    // phone and email so the customer can get in touch.
    void supabase.functions
      .invoke("estimate-accept", { body: { action: "view", token: token ?? "" } })
      .then(async ({ data, error: err }) => {
        if (cancelled) return;
        if (err || !data || typeof data !== "object") {
          if (!token) return;
          setLoadError(
            (await errorText(err)) ??
              "We could not load your estimate. Please try again in a few minutes.",
          );
          return;
        }
        const v = data as View;
        setView(v);
        const opts = v.estimate?.options ?? [];
        if (opts.length === 1) setOptionId(opts[0].id);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const est = view?.estimate ?? null;
  const choices = useMemo(() => {
    if (!est) return [];
    const total = (lines: Line[]) =>
      estimateTotals(
        lines.map((l) => ({ quantity: num(l.quantity), unitPrice: num(l.unitPrice) })),
        num(est.tax_rate),
        est.discount_type,
        num(est.discount_value),
      );
    if (est.options.length > 0) {
      return est.options.map((o) => ({ ...o, totals: total(o.lines) }));
    }
    return [{ id: "", label: "", description: "", lines: est.lines, totals: total(est.lines) }];
  }, [est]);

  const company = view?.company ?? null;
  const companyName = company?.name || "Your Tree Company";
  const multi = choices.length > 1;
  const picked = choices.find((c) => c.id === optionId) ?? (multi ? null : choices[0] ?? null);
  const canSubmit =
    !!token &&
    !!picked &&
    name.trim().length >= 2 &&
    agree &&
    (captchaToken !== null || !turnstileConfigured) &&
    !submitting;

  const submit = async () => {
    if (!canSubmit || !supabase || !picked) return;
    setSubmitting(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("estimate-accept", {
      body: {
        action: "accept",
        token,
        optionId: picked.id,
        name: name.trim(),
        agree: true,
        turnstileToken: captchaToken ?? "",
      },
    });
    setSubmitting(false);
    setCaptchaReset((n) => n + 1);
    if (err) {
      setError(
        (await errorText(err)) ??
          `That didn't go through. Please try again${company?.phone ? `, or call us at ${company.phone}` : ""}.`,
      );
      return;
    }
    const d = (data ?? {}) as { status?: string; optionLabel?: string; error?: string };
    if (d.status === "accepted") {
      setAcceptedLabel(d.optionLabel ?? "");
    } else if (d.status === "already-accepted") {
      setError(d.error ?? "This estimate was already accepted. Thank you!");
    } else {
      setError(d.error ?? "That didn't go through. Please try again.");
    }
  };

  const terms =
    view?.billingTerms?.trim()
      ? `Payment terms: ${view.billingTerms.trim()}.`
      : (view?.termsDays ?? 0) > 0
        ? `Payment is due within ${view?.termsDays} days of the invoice.`
        : "Payment is due when the work is done.";

  const contact = (
    <p className="text-center text-xs text-slate-500">
      Questions?{" "}
      {company?.phone ? <>Call {company.phone}</> : "Get in touch"}
      {company?.email ? <> or email {company.email}</> : null}.
    </p>
  );

  // No usable token in the address, or no live project: nothing to load.
  const shownView: View | null =
    view ?? (token ? null : { ...EMPTY_VIEW, status: "not-found" });
  const shownError = loadError ?? (token && !supabase ? "This page only works on the live app." : null);

  let content: ReactNode;
  if (shownError) {
    content = <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{shownError}</p>;
  } else if (!shownView) {
    content = <p className="text-center text-sm text-slate-500">Loading your estimate…</p>;
  } else if (NOT_OPEN[shownView.status]) {
    const m = NOT_OPEN[shownView.status];
    content = (
      <div className="space-y-3">
        <div className="rounded-xl bg-amber-50 p-4 text-center">
          <p className="text-lg font-bold text-amber-900">{m.title}</p>
          <p className="mt-1 text-sm text-amber-800">{m.text}</p>
        </div>
        {shownView.company && (shownView.company.phone || shownView.company.email) ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {shownView.company.phone && (
              <a
                href={`tel:${shownView.company.phone.replace(/[^\d+]/g, "")}`}
                className="flex min-h-11 items-center justify-center rounded-lg bg-[#2f6b40] px-4 text-sm font-bold text-white"
              >
                📞 Call {shownView.company.phone}
              </a>
            )}
            {shownView.company.email && (
              <a
                href={`mailto:${shownView.company.email}`}
                className="flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800"
              >
                ✉️ Email {shownView.company.email}
              </a>
            )}
          </div>
        ) : (
          shownView.company && contact
        )}
      </div>
    );
  } else if (!view) {
    content = null;
  } else if (acceptedLabel !== null || view.status === "accepted" || view.status === "accepted-elsewhere") {
    const label =
      acceptedLabel ??
      (choices.find((c) => c.id !== "" && c.id === view.acceptedOptionId)?.label || "");
    content = (
      <div className="space-y-3">
        <div className="rounded-xl bg-emerald-50 p-4 text-center">
          <p className="text-lg font-bold text-emerald-900">Estimate accepted ✓</p>
          <p className="mt-1 text-sm text-emerald-800">
            {est?.title}
            {label ? ` — ${label}` : ""}
            {acceptedLabel === null && view.acceptedAt ? ` (accepted ${niceDay(view.acceptedAt)})` : ""}.
            {" "}Thank you! We will be in touch soon to schedule the work.
          </p>
        </div>
        {contact}
      </div>
    );
  } else if (est) {
    content = (
      <div className="space-y-5">
        <div>
          <p className="text-slate-700">
            Hi {view.greeting || "there"}, here is your estimate:
          </p>
          <h2 className="mt-1 text-xl font-bold text-slate-900">{est.title}</h2>
          {est.created_date && (
            <p className="text-xs text-slate-500">Written {niceDay(est.created_date)}</p>
          )}
        </div>

        <div className="space-y-3">
          {multi && <p className={labelCls()}>Pick the option you want</p>}
          {choices.map((c) => {
            const selected = picked?.id === c.id;
            const body = (
              <>
                {c.label && (
                  <p className="font-bold text-slate-900">
                    {c.label}
                    {c.description && (
                      <span className="font-normal text-slate-600"> — {c.description}</span>
                    )}
                  </p>
                )}
                <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
                  {c.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span>
                        {l.description || "Item"}
                        {num(l.quantity) !== 1 && (
                          <span className="text-slate-500">
                            {" "}({num(l.quantity)} × {money(num(l.unitPrice))})
                          </span>
                        )}
                      </span>
                      <span className="whitespace-nowrap">{money(num(l.quantity) * num(l.unitPrice))}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 space-y-0.5 border-t border-slate-200 pt-2 text-sm">
                  {est.discount_type !== "none" && c.totals.discount > 0 && (
                    <p className="flex justify-between text-slate-600">
                      <span>Discount ({discountLabel(est.discount_type, num(est.discount_value))})</span>
                      <span>−{money(c.totals.discount)}</span>
                    </p>
                  )}
                  {num(est.tax_rate) > 0 && (
                    <p className="flex justify-between text-slate-600">
                      <span>Tax ({num(est.tax_rate)}%)</span>
                      <span>{money(c.totals.tax)}</span>
                    </p>
                  )}
                  <p className="flex justify-between font-bold text-slate-900">
                    <span>{c.label ? "Option total" : "Total"}</span>
                    <span>{money(c.totals.total)}</span>
                  </p>
                </div>
              </>
            );
            return multi ? (
              <label
                key={c.id}
                className={`block cursor-pointer rounded-xl border p-3 ${
                  selected ? "border-emerald-700 bg-emerald-50 ring-2 ring-emerald-700" : "border-slate-300 bg-white"
                }`}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="option"
                    className="mt-1 h-5 w-5"
                    checked={selected}
                    onChange={() => setOptionId(c.id)}
                  />
                  <span className="block flex-1">{body}</span>
                </span>
              </label>
            ) : (
              <div key={c.id || "only"} className="rounded-xl border border-slate-300 p-3">
                {body}
              </div>
            );
          })}
        </div>

        {est.notes?.trim() && (
          <p className="whitespace-pre-line rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <b>Notes:</b> {est.notes.trim()}
          </p>
        )}
        <p className="text-sm text-slate-600">{terms}</p>

        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div>
            <label className={labelCls()} htmlFor="accept-name">
              Type your full name
            </label>
            <input
              id="accept-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className={inputCls()}
              autoComplete="name"
            />
          </div>
          <label className="flex items-start gap-3 text-sm text-slate-800">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            <span>
              I accept this estimate{picked?.label ? ` (${picked.label}, ${money(picked.totals.total)})` : ""} from{" "}
              {companyName} and its terms. Typing my name counts as my signature.
            </span>
          </label>
          <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
          )}
          <button
            onClick={submit}
            disabled={!canSubmit}
            className={`${primaryBtn()} w-full py-3 text-base disabled:opacity-40`}
          >
            {submitting ? "Accepting…" : multi && !picked ? "Pick an option above" : "Accept estimate"}
          </button>
          {view.expiresAt && (
            <p className="text-center text-xs text-slate-500">
              This private link works until {niceDay(view.expiresAt)}.
            </p>
          )}
        </div>
        {contact}
      </div>
    );
  } else {
    content = <p className="text-sm text-slate-500">Nothing to show.</p>;
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-lg space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-center">
          <img src="/logo.png" alt="" className="mx-auto h-20 w-20 object-contain" />
          <h1 className="mt-2 text-2xl font-bold text-slate-900">{companyName}</h1>
        </div>
        {content}
      </div>
    </div>
  );
}
