import { useSyncExternalStore } from "react";
import type { AppState, AuditEntry, JobStatus, TimesheetEntry } from "./types";
import { switchClock } from "./crewDay";
import { CLOCK_DAY_END, isTapTooOldMessage, tappedAtFromMessage } from "./clockTime";

/**
 * Field actions kept on the phone until they reach the database: clock
 * in, clock out, Arrived and Done. Crew work in yards with weak signal;
 * an action made without signal must never be silently lost.
 *
 * Each action is recorded here (localStorage, per login) the moment it is
 * made, then applied and saved the usual way. It is removed once a save
 * containing it succeeds. Until then:
 * - "sending": the save is running;
 * - "waiting": no signal — it is sent again when the phone is back online
 *   (and after a reload, the actions still here are applied again);
 * - "failed": the database answered with an error — "Not saved — tap to retry".
 *
 * Re-applying an action is safe (idempotent): a clock-in that is already
 * there is not added twice, and a status tap is only re-applied while the
 * job still has the status it had when tapped (someone else changing it
 * since wins).
 *
 * The queue lives under the `treeapp:` prefix, so sign-out wipes it with the
 * rest of the company data on the phone; signing out first warns while
 * anything is still queued (unsentTapsWarning) and tries to send it.
 */

export type FieldOp =
  | {
      id: string;
      kind: "clockIn";
      entry: TimesheetEntry;
      audit: AuditEntry[];
    }
  | {
      id: string;
      kind: "clockOut";
      entryId: string;
      at: string;
      /** The entry's date (the day the clock-out is counted on); older queues lack it. */
      date?: string;
      audit: AuditEntry[];
    }
  | {
      id: string;
      kind: "status";
      jobId: string;
      from: JobStatus;
      to: JobStatus;
      audit: AuditEntry[];
    };

export type FieldOpState = "sending" | "waiting" | "failed";

export interface QueuedFieldOp {
  op: FieldOp;
  /** Plain words for the screen, e.g. "Clock in · Big oak". */
  label: string;
  state: FieldOpState;
  addedAt: number;
  /**
   * Set when the database refused the tap as too old (code CT001): its
   * message, which gives the tapped time for the office. Such a tap is
   * never sent again and never dropped by a save; it stays on the phone,
   * shown to the crew member, until they dismiss it (dismissTooOldTap).
   */
  tooOld?: string;
}

/** The date and 'HH:MM' a field action was tapped at (status taps: null). */
export function fieldOpTapTime(op: FieldOp): { date: string | null; time: string } | null {
  if (op.kind === "clockIn") {
    return op.entry.clockIn ? { date: op.entry.date, time: op.entry.clockIn } : null;
  }
  if (op.kind === "clockOut") return { date: op.date ?? null, time: op.at };
  return null;
}

/**
 * Which queued taps the database refused as too old, from the save's
 * refusal reasons: each "too old" reason names the tapped date and
 * time, matched to the queued clock taps. Returns op id -> message.
 */
export function tooOldTapIds(queue: QueuedFieldOp[], reasons: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const reason of reasons) {
    if (!isTapTooOldMessage(reason)) continue;
    const at = tappedAtFromMessage(reason);
    if (!at) continue;
    for (const q of queue) {
      if (out.has(q.op.id)) continue;
      const t = fieldOpTapTime(q.op);
      if (t && t.time === at.time && (t.date === null || t.date === at.date)) out.set(q.op.id, reason);
    }
  }
  // The clock-in and clock-out of one entry are saved as one row: when
  // the row is refused, both taps are kept, each with its own time.
  const entryOf = (op: FieldOp) =>
    op.kind === "clockIn" ? op.entry.id : op.kind === "clockOut" ? op.entryId : null;
  const refusedEntries = new Map<string, string>();
  for (const q of queue) {
    const id = entryOf(q.op);
    const reason = out.get(q.op.id);
    if (id && reason) refusedEntries.set(id, reason);
  }
  for (const q of queue) {
    const id = entryOf(q.op);
    if (out.has(q.op.id) || !id || !refusedEntries.has(id)) continue;
    const t = fieldOpTapTime(q.op);
    const reason = refusedEntries.get(id) as string;
    const date = t?.date ?? tappedAtFromMessage(reason)?.date ?? "";
    out.set(
      q.op.id,
      t ? reason.replace(/tapped: \d{4}-\d{2}-\d{2} at \d{2}:\d{2}/, `tapped: ${date} at ${t.time}`) : reason,
    );
  }
  return out;
}

function withAudit(state: AppState, audit: AuditEntry[]): AppState {
  const have = new Set(state.auditLog.map((a) => a.id));
  const missing = audit.filter((a) => !have.has(a.id));
  if (missing.length === 0) return state;
  return { ...state, auditLog: [...state.auditLog, ...missing] };
}

/** True when the action no longer applies (the office changed the job since). */
export function isStaleFieldOp(state: AppState, op: FieldOp): boolean {
  if (op.kind === "status") {
    const job = state.jobs.find((j) => j.id === op.jobId);
    return !job || (job.status !== op.from && job.status !== op.to);
  }
  if (op.kind === "clockOut") {
    return !state.timesheets.some((t) => t.id === op.entryId);
  }
  return false;
}

/**
 * True when a queued Clock out tap at `at` should replace the 20:00 the
 * 8 PM rule saved (the "crew day and 8pm clockout" rules): the entry was closed
 * automatically and the tap is between its clock-in and 8 PM.
 */
export function replacesAutoClose(t: TimesheetEntry, at: string): boolean {
  return (
    t.autoClosed === true &&
    t.clockOut === CLOCK_DAY_END &&
    t.clockIn !== null &&
    /^\d{2}:\d{2}/.test(at) &&
    at.slice(0, 5) < CLOCK_DAY_END &&
    at.slice(0, 5) >= t.clockIn.slice(0, 5)
  );
}

/**
 * Apply one action to the app state. Returns the same object when there
 * is nothing to change (already applied, or stale).
 */
export function applyFieldOp(state: AppState, op: FieldOp): AppState {
  if (isStaleFieldOp(state, op)) return state;
  if (op.kind === "clockIn") {
    const res = switchClock(state.timesheets, op.entry);
    const already = state.timesheets.some((t) => t.id === op.entry.id);
    if (res.unchanged || (already && res.closed.length === 0)) return withAudit(state, op.audit);
    return withAudit({ ...state, timesheets: res.timesheets }, op.audit);
  }
  if (op.kind === "clockOut") {
    const t = state.timesheets.find((x) => x.id === op.entryId);
    if (t && replacesAutoClose(t, op.at)) {
      // The 8 PM rule closed it while this tap waited for signal: the
      // real tap replaces the 20:00 (the database accepts it too).
      return withAudit(
        {
          ...state,
          timesheets: state.timesheets.map((x) =>
            x.id === op.entryId ? { ...x, clockOut: op.at, autoClosed: false } : x,
          ),
        },
        op.audit,
      );
    }
    if (!t || t.clockOut !== null) return withAudit(state, op.audit);
    return withAudit(
      {
        ...state,
        timesheets: state.timesheets.map((x) =>
          x.id === op.entryId ? { ...x, clockOut: op.at } : x,
        ),
      },
      op.audit,
    );
  }
  const job = state.jobs.find((j) => j.id === op.jobId);
  if (!job || job.status === op.to) return withAudit(state, op.audit);
  return withAudit(
    {
      ...state,
      jobs: state.jobs.map((j) => (j.id === op.jobId ? { ...j, status: op.to } : j)),
    },
    op.audit,
  );
}

/** Apply every queued action in order. */
export function applyFieldOps(state: AppState, ops: FieldOp[]): AppState {
  return ops.reduce(applyFieldOp, state);
}

/**
 * The queued actions that someone else's change made pointless, checked
 * in the order they were tapped, each against the state with the
 * earlier ones already applied: an Arrived then Done made offline, or a
 * clock-in then clock-out, are both still live after a reload that
 * shows the job scheduled and no clock entry yet.
 */
export function staleFieldOpIds(state: AppState, ops: FieldOp[]): string[] {
  const stale: string[] = [];
  let s = state;
  for (const op of ops) {
    if (isStaleFieldOp(s, op)) stale.push(op.id);
    else s = applyFieldOp(s, op);
  }
  return stale;
}

/**
 * A save error that means "no signal" rather than "the database said no":
 * the phone is offline, the request could not reach the server, or it
 * timed out.
 */
export function isNoSignalError(message: string | null | undefined, online: boolean): boolean {
  if (!online) return true;
  return /failed to fetch|networkerror|network request failed|load failed|timed out|no company access|sign-in needs refreshing|fetch failed|err_internet|offline/i.test(
    message ?? "",
  );
}

// ---------- the queue itself (module state + localStorage) ----------

const PREFIX = "treeapp:field-queue:v1:";
let owner: string | null = null;
let ops: QueuedFieldOp[] = [];
const listeners = new Set<() => void>();

function storageKey(userId: string): string {
  return `${PREFIX}${userId}`;
}

function persist(): void {
  if (!owner) return;
  try {
    if (ops.length === 0) localStorage.removeItem(storageKey(owner));
    else localStorage.setItem(storageKey(owner), JSON.stringify(ops));
  } catch {
    // Storage unavailable (private mode): the action still saves while
    // the app is open; it just cannot survive a reload.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function set(next: QueuedFieldOp[]): void {
  ops = next;
  persist();
  emit();
}

/** Switch to this login's queue (null = signed out). */
export function selectFieldQueueUser(userId: string | null): void {
  if (owner === userId) return;
  owner = userId;
  let loaded: QueuedFieldOp[] = [];
  if (userId) {
    try {
      const raw = localStorage.getItem(storageKey(userId));
      const parsed = raw ? (JSON.parse(raw) as QueuedFieldOp[]) : [];
      // Anything left from an earlier visit has not reached the database.
      loaded = Array.isArray(parsed)
        ? parsed.map((q) => ({ ...q, state: q.state === "failed" ? "failed" : "waiting" }))
        : [];
    } catch {
      loaded = [];
    }
  }
  ops = loaded;
  emit();
}

export function queuedFieldOps(): QueuedFieldOp[] {
  return ops;
}

export function addFieldOp(op: FieldOp, label: string, now = Date.now()): void {
  set([...ops.filter((q) => q.op.id !== op.id), { op, label, state: "sending", addedAt: now }]);
}

/**
 * These actions reached the database: forget them. A tap the database
 * refused as too old is kept (see QueuedFieldOp.tooOld).
 */
export function fieldOpsSent(ids: string[]): void {
  const done = new Set(ids);
  if (!ops.some((q) => done.has(q.op.id) && !q.tooOld)) return;
  set(ops.filter((q) => !done.has(q.op.id) || q.tooOld));
}

/**
 * The save's refusal reasons: mark the taps the database refused as too
 * old (failed, with the message). Returns how many were marked.
 */
export function markTooOldTaps(reasons: string[]): number {
  const hits = tooOldTapIds(
    ops.filter((q) => !q.tooOld),
    reasons,
  );
  if (hits.size === 0) return 0;
  set(ops.map((q) => (hits.has(q.op.id) ? { ...q, state: "failed" as const, tooOld: hits.get(q.op.id) } : q)));
  return hits.size;
}

/** The crew member has told the office about a too-old tap: forget it. */
export function dismissTooOldTap(id: string): void {
  if (!ops.some((q) => q.op.id === id && q.tooOld)) return;
  set(ops.filter((q) => q.op.id !== id));
}

/** The queued taps still worth sending (not refused as too old). */
export function sendableFieldOps(q: QueuedFieldOp[]): QueuedFieldOp[] {
  return q.filter((x) => !x.tooOld);
}

/** Mark every queued action (optionally only those in `from`) with a new state. */
export function setFieldOpsState(state: FieldOpState, from?: FieldOpState[]): void {
  let changed = false;
  const next = ops.map((q) => {
    if (q.tooOld || q.state === state || (from && !from.includes(q.state))) return q;
    changed = true;
    return { ...q, state };
  });
  if (changed) set(next);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The queue, for the screen (re-renders when it changes). */
export function useFieldQueue(): QueuedFieldOp[] {
  return useSyncExternalStore(subscribe, queuedFieldOps, queuedFieldOps);
}

/**
 * The question asked before signing out while taps are still on the
 * phone, or null when nothing is waiting. Signing out wipes the phone's
 * copy of the company data, these taps included.
 */
export function unsentTapsWarning(count: number, refused: string[] = []): string | null {
  const parts: string[] = [];
  if (count > 0) {
    const what = count === 1 ? "1 clock or job tap is" : `${count} clock or job taps are`;
    parts.push(
      `${what} not sent yet (no signal). If you sign out now, ${count === 1 ? "it" : "they"} will be lost. ` +
        "Press Cancel to stay signed in: the app sends them as soon as there is signal.",
    );
  }
  // A tap the database refused (too old) is never sent again: the note
  // on Today is the only record of the tapped time (audit 3).
  for (const message of refused) {
    const at = tappedAtFromMessage(message);
    parts.push(
      `You haven't told the office about a refused clock tap${at ? ` (${at.date} at ${at.time})` : ""}. ` +
        "Signing out removes this note. Press Cancel, tell the office, then tap \"I told the office\".",
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join("\n\n")}\n\nPress OK to sign out anyway.`;
}

/** One line for the screen, or null when nothing is waiting. */
export function fieldQueueSummary(q: QueuedFieldOp[]): {
  tone: "waiting" | "failed";
  text: string;
} | null {
  const tooOld = q.find((x) => x.tooOld);
  if (tooOld) return { tone: "failed", text: tooOld.tooOld as string };
  if (q.length === 0) return null;
  if (q.some((x) => x.state === "failed")) {
    return { tone: "failed", text: "Not saved — tap to retry" };
  }
  if (q.some((x) => x.state === "waiting")) {
    return { tone: "waiting", text: OFFLINE_SAVED_TEXT };
  }
  return null;
}

/** What the crew sees while taps wait for signal (review, #8). */
export const OFFLINE_SAVED_TEXT = "No signal: saved on this phone, will send when you're back online";

/** A save error about the sign-in, not the signal. */
export function isSignInProblem(message: string | null | undefined): boolean {
  return /no company access|sign-in needs refreshing/i.test(message ?? "");
}

/**
 * Which save banner to show at the top of the app:
 * - "none": nothing failed;
 * - "offline-saved": no signal, and every unsaved change is a field tap
 *   kept on this phone (it sends by itself later): a calm amber note,
 *   not red. `unsavedNonField` (store) is true when some other change
 *   is waiting too: that one is only in memory, so the banner is red.
 *   A sign-in problem is never "saved on this phone";
 * - "offline-unsaved": no signal, and the change is not kept on the
 *   phone: red, in plain words;
 * - "failed": the database said no: red.
 */
export function saveBannerKind(
  saveStatus: string,
  saveError: string | null | undefined,
  queue: QueuedFieldOp[],
  online: boolean,
  unsavedNonField: boolean,
): "none" | "offline-saved" | "offline-unsaved" | "failed" {
  if (saveStatus !== "error" || !saveError) return "none";
  if (!isNoSignalError(saveError, online)) return "failed";
  if (
    !unsavedNonField &&
    !(online && isSignInProblem(saveError)) &&
    queue.length > 0 &&
    !queue.some((q) => q.state === "failed")
  ) {
    return "offline-saved";
  }
  return "offline-unsaved";
}
