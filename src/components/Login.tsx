import { useState } from "react";
import type { FormEvent } from "react";
import { useStore } from "../store";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";
import { turnstileConfigured } from "../config";
import Turnstile from "./Turnstile";
import {
  arrivedFromExpiredLink,
  friendlyAuthError,
  sendPasswordReset,
} from "../passwordReset";

/**
 * Login screen, shown ONLY in Supabase mode (config.ts filled in) when
 * no session exists. The preview runs on an empty local state and never
 * shows this: with placeholders in config.ts the app has no login at
 * all. Signing in loads that user's company through the membership
 * policies; the session persists across reloads via the client.
 *
 * New crew can also create their own login here ("Create an
 * account"). A signup only creates a pending roster row — the person
 * sees nothing until an owner approves them from the Users page
 * (migration 006's trigger + owner policies make that work).
 */
export default function Login() {
  const { signIn, signUp, authError } = useStore();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  // "Forgot password?": the address the reset link went to.
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);
  // Turnstile spam check, for Supabase Auth CAPTCHA (README Step 1).
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (mode === "forgot") {
      const err = await sendPasswordReset(email.trim(), captchaToken);
      if (err) setError(err);
      else setResetSentTo(email.trim());
    } else if (mode === "signup") {
      const { error: err, confirmationSent: sent } = await signUp(
        name.trim(),
        email.trim(),
        password,
        captchaToken,
      );
      if (err) {
        setError(err);
      } else if (sent) {
        setConfirmationSent(true);
      }
      // No confirmation step (email confirmation off): the session is
      // live and the auth listener signs them straight in, onto the
      // waiting-for-approval screen.
    } else {
      const err = await signIn(email.trim(), password, captchaToken);
      if (err) setError(err);
    }
    // A Turnstile token works once: get a fresh one for the next try.
    setCaptchaReset((n) => n + 1);
    setBusy(false);
  };

  if (resetSentTo) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-lg font-bold text-slate-900">
            📧 Check your email
          </p>
          <p className="mt-1 text-sm text-slate-600">
            If <span className="font-semibold text-slate-900">{resetSentTo}</span>{" "}
            has a login here, we just sent it a link to set a new
            password. Open the email on this phone or computer and tap
            the link. It can take a minute or two — check spam too.
          </p>
          <button
            onClick={() => {
              setResetSentTo(null);
              setMode("signin");
              setError(null);
            }}
            className={`${secondaryBtn()} mt-4 min-h-11 w-full`}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (confirmationSent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-lg font-bold text-slate-900">
            🌲 Check your email
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Your account was created for{" "}
            <span className="font-semibold text-slate-900">{email}</span>.
            Click the confirmation link in the email we just sent, then
            sign in here. After that, the owner approves your login from
            the Team page before you can see any company data.
          </p>
          <button
            onClick={() => {
              setConfirmationSent(false);
              setMode("signin");
              setError(null);
            }}
            className={`${secondaryBtn()} mt-4 w-full`}
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <img
          src="logo.png"
          alt="Your Tree Company"
          className="h-20 w-auto"
        />
        <p className="mt-1 text-sm text-slate-600">
          {mode === "signup"
            ? "Create your crew login. The owner approves new logins before they can see any company data."
            : mode === "forgot"
              ? "Type the email you sign in with. We'll email you a link to set a new password."
              : "Sign in with your crew login. You will see only your company's data."}
        </p>
        {mode !== "signup" && arrivedFromExpiredLink() && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            That email link has expired or was already used. Tap
            “Forgot password?” to get a new one.
          </p>
        )}
        {mode === "signup" && (
          <>
            <label className={labelCls()} htmlFor="login-name">
              Your name
            </label>
            <input
              id="login-name"
              type="text"
              autoComplete="name"
              required
              className={inputCls()}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}
        <label className={labelCls()} htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          required
          className={inputCls()}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {mode !== "forgot" && (
          <>
        <label className={labelCls()} htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={6}
          className={inputCls()}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
          </>
        )}
        <div className="mt-3">
          <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
        </div>
        {(error || (mode !== "forgot" && authError)) && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {friendlyAuthError(error || (mode !== "forgot" ? authError : null))}
          </p>
        )}
        <button
          type="submit"
          disabled={
            busy ||
            (turnstileConfigured && !captchaToken) ||
            !email.trim() ||
            (mode !== "forgot" && !password) ||
            (mode === "signup" && !name.trim())
          }
          className={`${primaryBtn()} mt-4 min-h-11 w-full`}
        >
          {busy
            ? mode === "signup"
              ? "Creating account…"
              : mode === "forgot"
                ? "Sending…"
                : "Signing in…"
            : mode === "signup"
              ? "Create account"
              : mode === "forgot"
                ? "Email me a reset link"
                : "Sign in"}
        </button>
        {mode !== "signup" && (
          <button
            type="button"
            onClick={() => {
              setMode(mode === "forgot" ? "signin" : "forgot");
              setError(null);
            }}
            className="mt-2 min-h-11 w-full text-center text-sm font-semibold text-emerald-700 hover:underline"
          >
            {mode === "forgot" ? "Back to sign in" : "Forgot password?"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setError(null);
          }}
          className="mt-1 min-h-11 w-full text-center text-sm font-semibold text-emerald-700 hover:underline"
        >
          {mode === "signup"
            ? "Already have a login? Sign in"
            : "New to the crew? Create an account"}
        </button>
        {mode === "signup" && (
          <p className="mt-3 text-xs text-slate-600">
            You will be able to sign in once the owner approves you.
          </p>
        )}
      </form>
    </div>
  );
}
