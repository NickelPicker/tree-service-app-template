// testMode.ts — the test-email lock. While you try the app out, only
// the business Gmail and your own test addresses may receive emails.
//
// While test mode is on (the default: anything but EMAIL_TEST_MODE=off),
// the edge functions email ONLY the business Gmail and the addresses in
// EMAIL_TEST_RECIPIENTS (comma separated). Every other email is refused
// before Gmail is contacted. Both values come from GitHub repository
// variables of the same names through the deploy; the owner turns test
// mode off by setting the variable EMAIL_TEST_MODE to "off".
// No Deno or npm imports, so the app's tests can load it.

export function parseRecipients(list: string | undefined | null): string[] {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * May this email go out? `to` may hold several addresses separated by
 * commas; every one must be allowed. Test mode is on unless `mode` is
 * exactly "off".
 */
export function recipientAllowed(
  to: string,
  mode: string | undefined | null,
  businessAddress: string,
  extra: string | undefined | null,
): boolean {
  if ((mode ?? "").trim().toLowerCase() === "off") return true;
  const allowed = new Set([businessAddress.toLowerCase(), ...parseRecipients(extra)]);
  const wanted = parseRecipients(to);
  return wanted.length > 0 && wanted.every((a) => allowed.has(a));
}
