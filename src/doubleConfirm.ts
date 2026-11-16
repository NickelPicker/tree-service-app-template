/**
 * Business rule: "Any mass emails will have to go through 2
 * 'are you sure' buttons in different locations — any time there is more
 * than 3 emails at once."
 *
 * The decision and the wording live here (pure code, unit tested); the
 * two dialogs are src/components/DoubleConfirm.tsx, asked through the
 * hook in src/useDoubleConfirm.tsx. The first dialog sits at the top of
 * the screen, the second at the bottom, so one stray tap (or a pocket)
 * cannot press both.
 */

import { MASS_EMAIL_LIMIT, isMassEmail } from "../supabase/functions/_shared/massEmail.ts";

/** More than this many emails at once needs the two "are you sure" steps. */
export { MASS_EMAIL_LIMIT };

/** The second dialog's yes button ignores taps for this long after it opens. */
export const SECOND_TAP_DELAY_MS = 800;

/** True when `count` emails at once must go through both dialogs. */
export function needsDoubleConfirm(count: number): boolean {
  return isMassEmail(count);
}

export interface ConfirmStep {
  title: string;
  body?: string;
  /** The yes button's words. */
  yes: string;
}

export interface DoubleConfirmTexts {
  /** Top of the screen. */
  first: ConfirmStep;
  /** Bottom of the screen. */
  second: ConfirmStep;
}

const emails = (n: number) => `${n} email${n === 1 ? "" : "s"}`;
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * Wording for "send N emails": "Send N emails? <what>" with
 * "Yes, continue", then "Are you sure? This emails N people now." with
 * "Yes, send N emails".
 */
export function massEmailTexts(count: number, what = ""): DoubleConfirmTexts {
  return {
    first: {
      title: `Send ${emails(count)}?`,
      body: what.trim() || undefined,
      yes: "Yes, continue",
    },
    second: {
      title: "Are you sure?",
      body: `This emails ${people(count)} now.`,
      yes: `Yes, send ${emails(count)}`,
    },
  };
}

/** Wording for turning on the master switch "Automatic customer emails". */
export function masterSwitchTexts(rulesOn: number): DoubleConfirmTexts {
  return {
    first: {
      title: "Turn on automatic customer emails?",
      body:
        rulesOn > 0
          ? `The ${rulesOn} rule${rulesOn === 1 ? "" : "s"} switched on below will start emailing customers by themselves (only for things that come due from today on).`
          : "Rules you switch on below will start emailing customers by themselves (only for things that come due from today on).",
      yes: "Yes, continue",
    },
    second: {
      title: "Are you sure?",
      body: "Customers start getting emails without anyone pressing Send. More than 3 at once still wait for you to approve them on this page.",
      yes: "Yes, turn it on",
    },
  };
}

/** Wording for turning on one rule while the master switch is on. */
export function ruleOnTexts(label: string): DoubleConfirmTexts {
  const name = label.trim() || "this rule";
  return {
    first: {
      title: `Turn on "${name}"?`,
      body: "Automatic customer emails are on, so this rule starts emailing customers by itself.",
      yes: "Yes, continue",
    },
    second: {
      title: "Are you sure?",
      body: `Customers start getting "${name}" emails without anyone pressing Send.`,
      yes: "Yes, turn it on",
    },
  };
}

/** True once the second dialog has been open long enough to accept a tap. */
export function tapAllowed(openedAt: number, now: number): boolean {
  return now - openedAt >= SECOND_TAP_DELAY_MS;
}
