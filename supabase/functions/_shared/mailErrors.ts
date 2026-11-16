// mailErrors.ts — sorts a Gmail (nodemailer) error into one of two kinds.
// No Deno or npm imports, so the app's tests can load it.
//
//   "account"  Gmail refused the whole account or could not be reached:
//              wrong app password (EAUTH, 535), no connection, Gmail busy
//              (421, 454), or the daily sending limit (550 5.4.5). Every
//              other email in the same run would fail the same way, so
//              the run stops and nothing counts as a try.
//   "failed"   only this email failed (for example a bad address).

export type SendResult = "sent" | "failed" | "account";

const CONNECTION_CODES = new Set([
  "EAUTH",
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETLS",
  "EPROTOCOL",
]);
const ACCOUNT_RESPONSE_CODES = new Set([421, 454, 535]);

/** "account" for errors that would hit every email this run, else "failed". */
export function mailErrorKind(err: unknown): "account" | "failed" {
  if (!err || typeof err !== "object") return "failed";
  const e = err as { code?: unknown; responseCode?: unknown; response?: unknown };
  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  if (CONNECTION_CODES.has(code)) return "account";
  const rc = typeof e.responseCode === "number" ? e.responseCode : Number(e.responseCode);
  if (ACCOUNT_RESPONSE_CODES.has(rc)) return "account";
  const response = typeof e.response === "string" ? e.response : "";
  // Gmail's daily limit: "550-5.4.5 Daily user sending limit exceeded."
  if (rc === 550 && /\b5\.4\.5\b/.test(response)) return "account";
  return "failed";
}
