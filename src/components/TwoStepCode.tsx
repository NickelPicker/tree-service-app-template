import { useState } from "react";
import type { FormEvent } from "react";
import { useStore } from "../store";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * Two-step login, step 2 of signing in: shown after the password when
 * this login has two-step login turned on. The database shows company
 * data only after the 6-digit code from the authenticator app is
 * entered, so nothing loads until then.
 */
export default function TwoStepCode() {
  const { confirmTwoStepCode, signOut, authUser } = useStore();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await confirmTwoStepCode(code);
    setBusy(false);
    if (err) {
      setError(err);
      setCode("");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <p className="text-lg font-bold text-slate-900">🔐 Two-step login</p>
        <p className="mt-1 text-sm text-slate-500">
          Open the authenticator app on your phone and type the 6-digit
          code it shows for this app
          {authUser?.email ? (
            <>
              {" "}
              (<span className="font-semibold text-slate-900">{authUser.email}</span>)
            </>
          ) : null}
          .
        </p>
        <label className={labelCls()} htmlFor="two-step-code">
          6-digit code
        </label>
        <input
          id="two-step-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          className={`${inputCls()} text-center text-2xl tracking-[0.4em]`}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className={`${primaryBtn()} mt-4 w-full`}
        >
          {busy ? "Checking…" : "Continue"}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Lost your phone or changed apps? Ask an owner or manager to
          reset your two-step login on the Team page, then sign in with
          just your password.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className={`${secondaryBtn()} mt-3 w-full`}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
