// splitInvoiceSend.ts — who gets an email when the office presses
// "Email invoice" on a split invoice (business rule: "Each payer
// should get an invoice for the amount they are going to pay").
//
// One email per payer, to that payer's own address, with their own
// share (splitShares.ts, the same math as the app). Nothing is sent
// when the shares don't add up. Each payer's send has its own sends-log
// key, so a double press emails nobody twice and "Email again" is a new
// email for that payer.
//
// Pure code with no Deno or browser globals: send-invoice uses it, and
// so do the app's tests (and the app's count for the double confirm).

import { sharesOf, splitsSendProblem } from "./splitShares.ts";

/**
 * One plain address: no commas, semicolons, brackets or quotes, so a
 * payer's email can never turn into a list that reaches someone else.
 */
export const EMAIL_RE = /^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]+$/;
/** Split ids are made by the app (uuid); anything else is refused. */
export const SPLIT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** A split as stored in invoices.splits (the app's InvoiceSplit). */
export interface StoredSplit {
  id?: unknown;
  recipientName?: unknown;
  recipientEmail?: unknown;
  kind?: unknown;
  value?: unknown;
  paid?: unknown;
}

export interface Payer {
  id: string;
  name: string;
  email: string;
  kind: "percentage" | "fixed";
  value: number;
  paid: boolean;
}

/** Splits as payers, or null when one of them is malformed. */
export function payersOf(raw: unknown): Payer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Payer[] = [];
  const seen = new Set<string>();
  for (const s of raw as StoredSplit[]) {
    if (!s || typeof s !== "object") return null;
    const id = typeof s.id === "string" ? s.id : "";
    if (!SPLIT_ID_RE.test(id) || seen.has(id)) return null;
    seen.add(id);
    const kind = s.kind === "percentage" || s.kind === "fixed" ? s.kind : null;
    const value = typeof s.value === "number" ? s.value : parseFloat(String(s.value ?? ""));
    if (!kind || !Number.isFinite(value)) return null;
    out.push({
      id,
      name: String(s.recipientName ?? "").trim().slice(0, 120),
      email: String(s.recipientEmail ?? "").trim(),
      kind,
      value,
      paid: s.paid === true,
    });
  }
  return out;
}

/**
 * The sends-log key of one payer's email: the invoice, the payer (split
 * id) and the time that payer was last REALLY emailed (from their own
 * 'sent' rows), or "first". So a double press is one email per payer,
 * and "Email again" after a real send is a new one, for that payer only.
 */
export function payerDedupeKey(invoiceId: string, splitId: string, lastSentAt: string | null | undefined): string {
  const at = String(lastSentAt ?? "").trim();
  return `invoice_emailed:${invoiceId}:payer-${splitId}:${at || "first"}`;
}

/**
 * Each payer's last real send, from this invoice's 'invoice_emailed'
 * rows of the sends log (status 'sent'). Rows of the whole-invoice email
 * (before it was split) are not any payer's.
 */
export function lastSentByPayer(
  invoiceId: string,
  rows: Array<{ dedupe_key?: string | null; status?: string | null; sent_at?: string | null }>,
): Map<string, string> {
  const prefix = `invoice_emailed:${invoiceId}:payer-`;
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = String(r.dedupe_key ?? "");
    if (r.status !== "sent" || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const cut = rest.indexOf(":");
    if (cut <= 0) continue;
    const id = rest.slice(0, cut);
    const at = String(r.sent_at ?? "");
    if (!at) continue;
    const prev = out.get(id);
    if (!prev || new Date(at).getTime() > new Date(prev).getTime()) out.set(id, at);
  }
  return out;
}

/**
 * Why one payer gets no email on this press:
 *   paid              their share (or the whole invoice) is marked paid
 *   no-email          no (valid) email address on the payer
 *   no-share          their share is $0
 *   already-sent      emailed before, and this is not "Email again"
 *   blocked-test-mode test mode (_shared/testMode.ts) refuses the address
 */
export type PayerSkip = "paid" | "no-email" | "no-share" | "already-sent" | "blocked-test-mode";

export interface PayerPlan {
  payer: Payer;
  share: number;
  /** Last real send to this payer (the dedupe key's time), if any. */
  lastSentAt: string | null;
  /** null = email this payer now. */
  skip: PayerSkip | null;
}

export type SplitPlan =
  | { ok: false; reason: "split-shares"; detail: string }
  | { ok: false; reason: "bad-split" | "unknown-payer" }
  | { ok: true; payers: PayerPlan[]; toSend: PayerPlan[] };

/**
 * Who gets an email on this press. `only` (split ids) limits it to some
 * payers ("Email again" for one payer); `allowed` is the test-mode check.
 * When the shares don't add up, nobody does.
 */
export function planSplitSend(input: {
  splits: unknown;
  total: number;
  again: boolean;
  only?: string[] | null;
  lastSent: Map<string, string>;
  allowed: (email: string) => boolean;
  /** The whole invoice is marked paid: nobody is asked to pay. */
  invoicePaid?: boolean;
}): SplitPlan {
  const payers = payersOf(input.splits);
  if (!payers || payers.length === 0) return { ok: false, reason: "bad-split" };
  const problem = splitsSendProblem(payers, input.total);
  if (problem) return { ok: false, reason: "split-shares", detail: problem };
  const only = input.only && input.only.length > 0 ? new Set(input.only) : null;
  if (only && [...only].some((id) => !payers.some((p) => p.id === id))) return { ok: false, reason: "unknown-payer" };
  // Shares of ALL payers (the rounding remainder is the last percentage payer's).
  const shares = sharesOf(payers, input.total);
  const plans: PayerPlan[] = payers
    .map((payer, n) => ({ payer, share: shares[n] }))
    .filter(({ payer }) => !only || only.has(payer.id))
    .map(({ payer, share }) => {
      const lastSentAt = input.lastSent.get(payer.id) ?? null;
      let skip: PayerSkip | null = null;
      if (payer.paid || input.invoicePaid === true) skip = "paid";
      else if (!EMAIL_RE.test(payer.email)) skip = "no-email";
      else if (!(Math.round(share * 100) > 0)) skip = "no-share";
      else if (lastSentAt && !input.again) skip = "already-sent";
      else if (!input.allowed(payer.email)) skip = "blocked-test-mode";
      return { payer, share, lastSentAt, skip };
    });
  return { ok: true, payers: plans, toSend: plans.filter((p) => p.skip === null) };
}

/**
 * The upper bound the app shows in the double confirm: payers on this
 * press with an email, an unpaid share above $0, and (unless "Email
 * again") not known to have been emailed. The server's count is never
 * higher (it also drops test-mode addresses and payers it knows were
 * emailed), so the app's confirmed number always covers it.
 */
export function payersToConfirm(input: {
  splits: unknown;
  total: number;
  again: boolean;
  only?: string[] | null;
  knownSent: Set<string>;
  invoicePaid?: boolean;
}): number {
  const lastSent = new Map([...input.knownSent].map((id) => [id, "known"]));
  const plan = planSplitSend({ ...input, lastSent, allowed: () => true });
  return plan.ok ? plan.toSend.length : 0;
}
