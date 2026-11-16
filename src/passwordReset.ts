/**
 * "Forgot password?" and "Set a new password".
 *
 * Forgot password: Supabase emails a reset link (resetPasswordForEmail).
 * The link brings the person back to the website already signed in for
 * a password change only; Supabase fires PASSWORD_RECOVERY and the app
 * shows "Set a new password" instead of the app until they pick one.
 *
 * The listener is registered when this module loads (before React
 * mounts), and the address bar is checked too, so the PASSWORD_RECOVERY
 * event can't be missed while the app is still starting.
 */
import { useSyncExternalStore } from "react";
import { supabase } from "./data/supabaseClient";

/** The live minimum (Supabase Auth password_min_length, PR #9). */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Where the reset email's link goes: the website's own address (the
 * site URL, which is already allowed in the Auth settings). Supabase
 * ignores any address that is not on its allowed list and uses the
 * site URL instead, so this never sends anyone elsewhere.
 */
export function resetRedirectUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/`;
}

/** What the address bar says about an email link we arrived from. */
export function parseAuthHash(hash: string): {
  recovery: boolean;
  linkExpired: boolean;
} {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    recovery: params.get("type") === "recovery" && params.has("access_token"),
    linkExpired: params.has("error_code") || params.get("error") === "access_denied",
  };
}

/** Plain-English versions of the sign-in errors people actually see. */
export function friendlyAuthError(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "That email and password don't match. Try again, or tap “Forgot password?” below.";
  if (m.includes("email not confirmed"))
    return "Please click the link in the confirmation email we sent you first, then sign in.";
  if (m.includes("rate limit") || m.includes("too many") || m.includes("security purposes"))
    return "Too many tries in a row. Please wait a minute and try again.";
  if (m.includes("error sending"))
    return "We couldn't send the email just now. Please try again in a few minutes, or ask the owner for help.";
  if ((m.includes("same") || m.includes("different")) && m.includes("password"))
    return "That is your current password. Please choose a new one.";
  if (m.includes("password") && (m.includes("at least") || m.includes("short") || m.includes("weak")))
    return `Please use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (m.includes("aal2") || m.includes("insufficient_aal"))
    return "Enter the code from your authenticator app first, then set your new password.";
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("abort"))
    return "No connection to the server. Check your signal and try again.";
  return message;
}

/** Check a new password before sending it. Returns a message, or null when fine. */
export function newPasswordProblem(password: string, again: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Please use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== again) return "The two passwords don't match.";
  return null;
}

// ---------------------------------------------------------------- state

let recovering = false;
let expiredLink = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  const h = parseAuthHash(window.location.hash);
  recovering = h.recovery;
  expiredLink = h.linkExpired;
}
supabase?.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY" && !recovering) {
    recovering = true;
    emit();
  }
  if (event === "SIGNED_OUT" && recovering) {
    recovering = false;
    emit();
  }
});

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True while the person arrived from a reset link and hasn't set a new password. */
export function usePasswordRecovery(): boolean {
  return useSyncExternalStore(subscribe, () => recovering, () => false);
}

/** True when the person arrived from an email link that had expired. */
export function arrivedFromExpiredLink(): boolean {
  return expiredLink;
}

export function finishPasswordRecovery(): void {
  recovering = false;
  expiredLink = false;
  emit();
}

/** Email a reset link. Returns an error message, or null when sent. */
export async function sendPasswordReset(
  email: string,
  captchaToken?: string | null,
): Promise<string | null> {
  if (!supabase) return "Sign-in is not set up.";
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: resetRedirectUrl(window.location.origin),
    ...(captchaToken ? { captchaToken } : {}),
  });
  return error ? friendlyAuthError(error.message) : null;
}

/** Save the new password for the signed-in (recovering) login. */
export async function saveNewPassword(password: string): Promise<string | null> {
  if (!supabase) return "Sign-in is not set up.";
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return friendlyAuthError(error.message);
  finishPasswordRecovery();
  return null;
}
