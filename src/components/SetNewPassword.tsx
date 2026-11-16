import { useState } from "react";
import type { FormEvent } from "react";
import { useStore } from "../store";
import {
  MIN_PASSWORD_LENGTH,
  finishPasswordRecovery,
  newPasswordProblem,
  saveNewPassword,
} from "../passwordReset";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * Shown when someone arrives from the "Forgot password?" email link
 * (Supabase PASSWORD_RECOVERY). They are signed in for this one job:
 * choosing a new password. After saving they go straight into the app.
 */
export default function SetNewPassword() {
  const { authUser, signOut } = useStore();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = newPasswordProblem(password, again);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const err = await saveNewPassword(password);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <p className="text-lg font-bold text-slate-900">Set a new password</p>
        <p className="mt-1 text-sm text-slate-600">
          {authUser?.email ? (
            <>
              For <span className="font-semibold text-slate-900">{authUser.email}</span>.{" "}
            </>
          ) : null}
          Use at least {MIN_PASSWORD_LENGTH} characters.
        </p>
        <label className={`${labelCls()} mt-3`} htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          required
          autoFocus
          className={inputCls()}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className={`${labelCls()} mt-3`} htmlFor="new-password-again">
          Type it again
        </label>
        <input
          id="new-password-again"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          required
          className={inputCls()}
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={show}
            onChange={(e) => setShow(e.target.checked)}
            className="h-5 w-5"
          />
          Show password
        </label>
        {error && (
          <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !password || !again}
          className={`${primaryBtn()} mt-3 min-h-11 w-full`}
        >
          {busy ? "Saving…" : "Save new password"}
        </button>
        <button
          type="button"
          onClick={() => {
            finishPasswordRecovery();
            void signOut();
          }}
          className={`${secondaryBtn()} mt-2 min-h-11 w-full`}
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
