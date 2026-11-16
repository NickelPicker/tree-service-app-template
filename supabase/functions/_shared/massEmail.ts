// Business rule: "Any mass emails will have to go through 2
// 'are you sure' buttons in different locations — any time there is
// more than 3 emails at once."
//
// Shared by the edge functions and the app (src/doubleConfirm.ts), so
// both sides use the same number. No Deno or browser globals.

/** More than this many emails at once needs the owner's two confirms. */
export const MASS_EMAIL_LIMIT = 3;

/** True when `count` emails at once is a mass email. */
export function isMassEmail(count: number): boolean {
  return Number.isFinite(count) && count > MASS_EMAIL_LIMIT;
}
