import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useStore } from "../store";
import { supabase } from "../data/supabaseClient";
import { companyName } from "../company";
import { dangerBtn, inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

type Status =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "on"; factorId: string }
  | { kind: "setup"; factorId: string; qrCode: string; secret: string };

/** Whether this login has two-step login on (a verified app factor). */
async function readStatus(): Promise<{ status: Status; error: string | null }> {
  if (!supabase) return { status: { kind: "off" }, error: null };
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return { status: { kind: "off" }, error: error.message };
  const on = data?.totp?.find((f) => f.status === "verified");
  return {
    status: on ? { kind: "on", factorId: on.id } : { kind: "off" },
    error: null,
  };
}

/**
 * Turn two-step login on or off for your own login (optional, each
 * person's choice). On: scan a QR code with an authenticator app
 * (Google Authenticator, Microsoft Authenticator, 1Password...), then
 * type the code it shows. From then on, signing in asks for a fresh
 * code after the password.
 */
export default function TwoStepSettings({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = async () => {
    const result = await readStatus();
    setStatus(result.status);
    if (result.error) setError(result.error);
  };

  useEffect(() => {
    let cancelled = false;
    void readStatus().then((result) => {
      if (cancelled) return;
      setStatus(result.status);
      if (result.error) setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setDone(null);
    // A setup that was started but never finished blocks a new one.
    const { data: existing } = await supabase.auth.mfa.listFactors();
    for (const f of existing?.all ?? []) {
      if (f.factor_type === "totp" && f.status !== "verified") {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Authenticator app",
      issuer: companyName(state),
    });
    setBusy(false);
    if (enrollError || !data) {
      setError(
        enrollError?.message ?? "Two-step login could not be started. Try again.",
      );
      return;
    }
    setCode("");
    setStatus({
      kind: "setup",
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || status.kind !== "setup") return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: status.factorId,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyError) {
      setError(
        /invalid|expired/i.test(verifyError.message)
          ? "That code didn't work. Codes change every 30 seconds; type the one showing now."
          : verifyError.message,
      );
      setCode("");
      return;
    }
    setDone("Two-step login is on. Next time you sign in, the app asks for a code from your authenticator app.");
    await refresh();
  };

  const turnOff = async () => {
    if (!supabase || status.kind !== "on") return;
    if (
      !window.confirm(
        "Turn off two-step login? Signing in will need only your password again.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    const { error: offError } = await supabase.auth.mfa.unenroll({
      factorId: status.factorId,
    });
    setBusy(false);
    if (offError) {
      setError(
        /aal2|assurance/i.test(offError.message)
          ? "Sign out and sign in again with your code, then turn it off."
          : offError.message,
      );
      return;
    }
    setDone("Two-step login is off.");
    await refresh();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Two-step login"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900">🔐 Two-step login</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Optional. With it on, signing in needs your password and a
          6-digit code from an authenticator app on your phone, so a
          stolen password alone can't open your account.
        </p>

        {status.kind === "loading" && (
          <p className="mt-4 text-sm text-slate-500">Checking…</p>
        )}

        {status.kind === "off" && (
          <div className="mt-4">
            <p className="text-sm font-semibold text-slate-800">Status: off</p>
            <p className="mt-1 text-sm text-slate-600">
              You need an authenticator app on your phone first, for
              example Google Authenticator or Microsoft Authenticator
              (free in the App Store / Play Store).
            </p>
            <button
              onClick={() => void start()}
              disabled={busy}
              className={`${primaryBtn()} mt-3 w-full`}
            >
              {busy ? "Starting…" : "Turn on two-step login"}
            </button>
          </div>
        )}

        {status.kind === "setup" && (
          <form onSubmit={confirm} className="mt-4">
            <p className="text-sm font-semibold text-slate-800">
              1. In your authenticator app, add an account and scan this code:
            </p>
            <img
              src={status.qrCode}
              alt="QR code for your authenticator app"
              className="mx-auto mt-2 h-48 w-48 rounded-lg border border-slate-200 bg-white p-2"
            />
            <p className="mt-2 text-xs text-slate-500">
              Can't scan? Choose "enter a setup key" in the app and type:
            </p>
            <p className="mt-1 break-all rounded bg-slate-100 px-2 py-1 font-mono text-sm text-slate-900">
              {status.secret}
            </p>
            <label className={`${labelCls()} mt-4`} htmlFor="two-step-setup-code">
              2. Type the 6-digit code the app shows
            </label>
            <input
              id="two-step-setup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              className={`${inputCls()} text-center text-2xl tracking-[0.4em]`}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className={`${primaryBtn()} flex-1`}
              >
                {busy ? "Checking…" : "Turn on"}
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className={secondaryBtn()}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {status.kind === "on" && (
          <div className="mt-4">
            <p className="text-sm font-semibold text-emerald-800">Status: on ✓</p>
            <p className="mt-1 text-sm text-slate-600">
              Signing in asks for a code from your authenticator app.
              New phone? Turn it off here, then on again with the new
              phone. Lost your phone? An owner or manager can reset it
              from the Team page.
            </p>
            <button
              onClick={() => void turnOff()}
              disabled={busy}
              className={`${dangerBtn()} mt-3 w-full`}
            >
              {busy ? "Turning off…" : "Turn off two-step login"}
            </button>
          </div>
        )}

        {done && (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {done}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
