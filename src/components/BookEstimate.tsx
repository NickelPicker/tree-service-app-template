/**
 * Public booking page — "Book a free estimate visit".
 *
 * This page lives OUTSIDE the login gate (App renders it when the URL
 * is #/book): anyone with the link can request an estimate visit, no
 * account needed. It reads closed days with the
 * publishable key (anyone may READ them, so the page knows which days
 * are open) but cannot write to the database: the request goes to the
 * book-estimate Edge Function, which checks the Turnstile spam check,
 * validates and length-limits every field, rate-limits by IP, and
 * stores it as 'pending' (the "booking requests hardening" rules, audit SEC-6). The business name and phone shown here
 * come from the public company view (migration 028: name + phone
 * only — no email, no payment details); when they can't be read the
 * page falls back to generic wording.
 *
 * Days shown: today through the next 13 days, minus days marked
 * Business closed. No time slots — an estimate visit is a day-level
 * booking; the estimator confirms the time by phone. Requests land on the Sales
 * page, where accepting one creates the customer and a draft estimate.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../data/supabaseClient";
import { supabaseConfig, turnstileConfigured } from "../config";
import { addDaysISO, todayStr } from "../utils";
import { inputCls, labelCls, primaryBtn } from "./ui";
import Turnstile from "./Turnstile";

/** Same limits as the Edge Function and the database CHECKs. */
const MAX = { name: 100, phone: 30, email: 254, address: 300, details: 2000 };

const DAYS_AHEAD = 14;

function dayLabel(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function BookEstimate() {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [closedLoaded, setClosedLoaded] = useState(false);
  const [publicName, setPublicName] = useState("");
  const [publicPhone, setPublicPhone] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const live = supabase !== null;
  const days = useMemo(() => {
    const today = todayStr();
    const out: string[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) out.push(addDaysISO(today, i));
    return out;
  }, []);

  useEffect(() => {
    if (!live || !supabase) {
      setClosedLoaded(true);
      return;
    }
    let cancelled = false;
    // Business name + phone for the heading, from the public view.
    // A failure here just leaves the generic wording in place.
    void supabase
      .from("company_public")
      .select("name, phone")
      .eq("company_id", supabaseConfig.companyId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        if (typeof data.name === "string") setPublicName(data.name);
        if (typeof data.phone === "string") setPublicPhone(data.phone);
      });
    (async () => {
      const { data, error: err } = await supabase
        .from("closed_days")
        .select("id");
      if (cancelled) return;
      if (err) {
        // Closed days unreadable (migration 013 not run yet, or
        // offline) — show every day as open rather than blocking
        // bookings; the estimator still confirms by phone.
        setClosed(new Set());
      } else {
        setClosed(new Set((data ?? []).map((r) => String(r.id))));
      }
      setClosedLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [live]);

  const canSubmit =
    live &&
    selected !== null &&
    name.trim() !== "" &&
    phone.trim() !== "" &&
    address.trim() !== "" &&
    details.trim() !== "" &&
    (captchaToken !== null || !turnstileConfigured) &&
    !submitting;

  const submit = async () => {
    if (!canSubmit || !supabase || !selected) return;
    setSubmitting(true);
    setError(null);
    const { error: err } = await supabase.functions.invoke("book-estimate", {
      body: {
        date: selected,
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        address: address.trim(),
        details: details.trim(),
        turnstileToken: captchaToken ?? "",
      },
    });
    setSubmitting(false);
    if (err) {
      // Tokens are single-use: get a fresh one for the next try.
      setCaptchaReset((n) => n + 1);
      // The function explains fixable problems (a field too long, the
      // spam check, too many tries); anything else gets the phone line.
      let reason: string | null = null;
      try {
        const ctx = (err as { context?: Response }).context;
        const status = ctx?.status ?? 0;
        if (ctx && status >= 400 && status < 500) {
          const body = (await ctx.json()) as { error?: unknown };
          if (typeof body.error === "string") reason = body.error;
        }
      } catch {
        // Fall through to the generic message.
      }
      setError(
        reason ??
          (publicPhone
            ? `That didn't go through — please call us at ${publicPhone} and we'll book you in.`
            : "That didn't go through — please try again, or call us (the number is on our website) and we'll book you in."),
      );
      return;
    }
    setDone(true);
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-lg space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-center">
          <p className="text-3xl">🌲</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">
            {publicName || "Tree Service"}
          </h1>
          <p className="mt-1 text-slate-600">
            Book a free estimate visit — we come out, look at the trees,
            and give you a price.
          </p>
        </div>

        {done ? (
          <div className="rounded-xl bg-emerald-50 p-4 text-center">
            <p className="text-lg font-bold text-emerald-900">
              Request received ✓
            </p>
            <p className="mt-1 text-sm text-emerald-800">
              Thanks, {name.trim().split(" ")[0]} — we&apos;ve got your
              visit for {selected ? dayLabel(selected) : ""} at {address.trim()}.
              We&apos;ll call {phone.trim()} shortly to confirm a time.
            </p>
          </div>
        ) : (
          <>
            {!live && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                You&apos;re viewing a preview of this page — booking only
                works on the live app.
              </p>
            )}
            <div>
              <p className={labelCls()}>Pick a day</p>
              {!closedLoaded ? (
                <p className="text-sm text-slate-500">
                  Checking which days we&apos;re open…
                </p>
              ) : (
                <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {days.map((d) => {
                    const isClosed = closed.has(d);
                    const isSelected = selected === d;
                    return (
                      <button
                        key={d}
                        type="button"
                        disabled={isClosed}
                        onClick={() => setSelected(d)}
                        className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                          isClosed
                            ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"
                            : isSelected
                              ? "border-emerald-700 bg-emerald-700 text-white"
                              : "border-slate-300 bg-white text-slate-800 hover:border-emerald-500"
                        }`}
                      >
                        {dayLabel(d)}
                        {isClosed && (
                          <span className="block text-xs font-normal no-underline">
                            Closed
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-xs text-slate-500">
                Days marked Closed are days we&apos;re not booking. We&apos;ll
                confirm a time by phone after you send the request.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className={labelCls()} htmlFor="book-name">
                  Your name
                </label>
                <input
                  id="book-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX.name}
                  className={inputCls()}
                  autoComplete="name"
                />
              </div>
              <div>
                <label className={labelCls()} htmlFor="book-phone">
                  Phone
                </label>
                <input
                  id="book-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={MAX.phone}
                  className={inputCls()}
                  autoComplete="tel"
                  inputMode="tel"
                />
              </div>
              <div>
                <label className={labelCls()} htmlFor="book-email">
                  Email (optional)
                </label>
                <input
                  id="book-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={MAX.email}
                  className={inputCls()}
                  autoComplete="email"
                  inputMode="email"
                />
              </div>
              <div>
                <label className={labelCls()} htmlFor="book-address">
                  Address (where the trees are)
                </label>
                <input
                  id="book-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  maxLength={MAX.address}
                  className={inputCls()}
                  autoComplete="street-address"
                />
              </div>
              <div>
                <label className={labelCls()} htmlFor="book-details">
                  What do you need?
                </label>
                <textarea
                  id="book-details"
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  maxLength={MAX.details}
                  rows={3}
                  placeholder="e.g. Trim the big maple in the back yard, and take a look at the ash by the driveway."
                  className={inputCls()}
                />
              </div>
            </div>

            <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
              </p>
            )}
            <button
              onClick={submit}
              disabled={!canSubmit}
              className={`${primaryBtn()} w-full py-3 text-base disabled:opacity-40`}
            >
              {submitting ? "Sending…" : "Request my estimate visit"}
            </button>
            {publicPhone && (
              <p className="text-center text-xs text-slate-400">
                Prefer to talk? Call {publicPhone}.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
