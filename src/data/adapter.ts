import type { AppState, DraftMap } from "../types";

/**
 * Data-access boundary for the whole app. Every component talks to this
 * interface, never to localStorage, fetch, or a database directly.
 *
 * Phase 1 ships exactly one implementation: the mock adapter
 * (see mockAdapter.ts), which seeds fictional data and persists to
 * localStorage. Phase 2 replaces it with a Supabase/Firebase adapter
 * implementing these same methods — the UI does not change.
 */
export interface SaveResult {
  ok: boolean;
  /** The table whose write failed, when known. */
  failedTable?: string;
  /** The database's error message, when known. */
  message?: string;
  /**
   * Changes the database refused because this login may not make
   * them (row-level security or a permission trigger), per table.
   * Everything else in the save was written; the refused rows are not
   * retried, and the app reloads the real data to show what is saved.
   */
  refused?: SaveRefusal[];
  /**
   * The save failed because this session has no company access right
   * now (sign-in expired, or two-step code not entered yet), not
   * because of the change itself. Nothing is marked saved; the change
   * stays queued and is retried once the session is back.
   */
  noAccess?: boolean;
}

export interface SaveRefusal {
  /** Database table, e.g. "jobs". */
  table: string;
  /** How many rows were refused. */
  count: number;
  /** The database's reasons, when it gave any (a delete gives none). */
  reasons: string[];
}

export interface LoadOptions {
  discard?: () => boolean;
}

export interface DataAdapter {
  /**
   * Load the full saved state, or null when nothing has been saved yet.
   * `discard` is asked once the data has arrived: when it answers true
   * the caller will not use this copy (a change of its own is still
   * waiting to be saved), so the adapter must not treat it as the copy
   * the next save is compared with.
   */
  loadState(opts?: LoadOptions): Promise<AppState | null>;
  /**
   * Persist the full state. Called after every mutation. Returns
   * whether the whole state saved; when a core table failed, the
   * result names the table and the error so the app can show it
   * instead of failing silently (the caller keeps the latest state
   * queued and retries). Pre-migration tables still fall back
   * silently, as before.
   */
  saveState(state: AppState): Promise<SaveResult>;
  /** Load one autosaved draft by key, or undefined when there is none. */
  loadDraft(key: string): Promise<unknown | undefined>;
  /** Persist one autosaved draft (callers debounce this). */
  saveDraft(key: string, value: unknown): Promise<void>;
  /** Delete one autosaved draft (e.g. after the form is submitted). */
  clearDraft(key: string): Promise<void>;
  /** Wipe everything and return a fresh seeded state. */
  reset(): Promise<AppState>;
  /** All drafts currently stored, for debugging / draft recovery UI. */
  listDrafts(): Promise<DraftMap>;
}
