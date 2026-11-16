/**
 * The "New invoice" pop-up (src/components/InvoiceComposer.tsx), Gmail
 * draft style: one small external store, so the window and its draft
 * stay put while the person moves between screens.
 *
 * - "+ New invoice" calls openCompose(). If a draft is already open or
 *   minimized, it is restored as it was, never wiped.
 * - The draft (and whether the window is open or minimized) is kept in
 *   localStorage per signed-in person, so a reload keeps it. A
 *   signed-out viewer (owner null) has nothing kept at all.
 * - The key starts with `treeapp:`, so the sign-out wipe
 *   (clearLocalCompanyData in src/data/localData.ts) removes it with
 *   the rest of this device's company data; setComposeOwner(null)
 *   drops the copy in memory.
 * - finishCompose() after a successful save, discardCompose() when the
 *   person agrees to throw the draft away: both close it and clear it.
 */
import { useSyncExternalStore } from "react";
import type { Invoice } from "./types";

export type ComposeDraft = {
  custId: string;
  desc: string;
  amount: number;
  due: string;
  /** The due date was edited by hand: picking a customer keeps it. */
  dueTouched: boolean;
};

export type ComposeState = {
  open: boolean;
  minimized: boolean;
  expanded: boolean;
  draft: ComposeDraft;
  /** Goes up each time the window is opened or restored, so it can move focus inside. */
  focusRequest: number;
};

export const BLANK_DRAFT: ComposeDraft = {
  custId: "",
  desc: "",
  amount: 0,
  due: "",
  dueTouched: false,
};

const CLOSED: ComposeState = {
  open: false,
  minimized: false,
  expanded: false,
  draft: BLANK_DRAFT,
  focusRequest: 0,
};

export const COMPOSE_KEY_PREFIX = "treeapp:invoice-compose:";
export const composeStorageKey = (ownerId: string) =>
  `${COMPOSE_KEY_PREFIX}${ownerId}`;

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let state: ComposeState = CLOSED;
let owner: string | null = null;
let storageOverride: KeyStore | null = null;
const listeners = new Set<() => void>();

function storage(): KeyStore | null {
  if (storageOverride) return storageOverride;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Tests: use this storage instead of the browser's localStorage (null: back to it). */
export function setComposeStorage(s: KeyStore | null): void {
  storageOverride = s;
}

/** Anything typed that would be lost by closing. */
export function draftHasContent(d: ComposeDraft): boolean {
  return (
    d.custId !== "" ||
    d.desc.trim() !== "" ||
    d.amount !== 0 ||
    (d.dueTouched && d.due !== "")
  );
}

function persist(): void {
  if (!owner) return;
  const s = storage();
  if (!s) return;
  try {
    if (!state.open) s.removeItem(composeStorageKey(owner));
    else
      s.setItem(
        composeStorageKey(owner),
        JSON.stringify({
          open: state.open,
          minimized: state.minimized,
          expanded: state.expanded,
          draft: state.draft,
        }),
      );
  } catch {
    // Storage full or blocked: the draft still lives in memory.
  }
}

function load(ownerId: string): ComposeState {
  const s = storage();
  if (!s) return CLOSED;
  try {
    const raw = s.getItem(composeStorageKey(ownerId));
    if (!raw) return CLOSED;
    const v = JSON.parse(raw) as Partial<ComposeState>;
    if (!v || v.open !== true) return CLOSED;
    const d = (v.draft ?? {}) as Partial<ComposeDraft>;
    return {
      open: true,
      minimized: v.minimized === true,
      expanded: v.expanded === true,
      draft: {
        custId: typeof d.custId === "string" ? d.custId : "",
        desc: typeof d.desc === "string" ? d.desc : "",
        amount:
          typeof d.amount === "number" && Number.isFinite(d.amount)
            ? d.amount
            : 0,
        due: typeof d.due === "string" ? d.due : "",
        dueTouched: d.dueTouched === true,
      },
      focusRequest: 0,
    };
  } catch {
    return CLOSED;
  }
}

function set(next: ComposeState, save = true): void {
  state = next;
  if (save) persist();
  for (const l of listeners) l();
}

/**
 * Who is signed in (null: nobody). A new person loads their own kept
 * draft; signing out drops the one in memory (the sign-out wipe has
 * already removed the stored copy).
 */
export function setComposeOwner(ownerId: string | null): void {
  if (ownerId === owner) return;
  owner = ownerId;
  set(ownerId ? load(ownerId) : CLOSED, false);
}

export function getComposeState(): ComposeState {
  return state;
}

/** "+ New invoice": a blank draft, or the existing one restored. */
export function openCompose(): void {
  if (state.open) {
    set({ ...state, minimized: false, focusRequest: state.focusRequest + 1 });
    return;
  }
  set({
    open: true,
    minimized: false,
    expanded: false,
    draft: BLANK_DRAFT,
    focusRequest: state.focusRequest + 1,
  });
}

export function minimizeCompose(): void {
  if (!state.open || state.minimized) return;
  set({ ...state, minimized: true });
}

export function restoreCompose(): void {
  if (!state.open) return;
  set({ ...state, minimized: false, focusRequest: state.focusRequest + 1 });
}

export function toggleExpandCompose(): void {
  if (!state.open) return;
  set({ ...state, expanded: !state.expanded, minimized: false });
}

export function updateComposeDraft(patch: Partial<ComposeDraft>): void {
  if (!state.open) return;
  set({ ...state, draft: { ...state.draft, ...patch } });
}

function closeAndClear(): void {
  set({ ...CLOSED, focusRequest: state.focusRequest });
}

/** After Save for later or Save and email succeeded. */
export function finishCompose(): void {
  closeAndClear();
}

/** The person agreed to throw the draft away (or there was nothing in it). */
export function discardCompose(): void {
  closeAndClear();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useInvoiceCompose(): ComposeState {
  return useSyncExternalStore(subscribe, getComposeState, getComposeState);
}

/**
 * The invoice the composer would save from this draft (null until a
 * customer and a description are filled in). "Preview email" builds it
 * from the live draft on every render, so the preview always shows the
 * amount and words as they are now.
 */
export function draftInvoice(
  draft: Pick<ComposeDraft, "custId" | "desc" | "amount" | "due">,
  opts: { id: string; lineId: string; number: string; today: string; defaultDue: string },
): Invoice | null {
  if (!draft.custId || !draft.desc.trim()) return null;
  return {
    id: opts.id,
    number: opts.number,
    customerId: draft.custId,
    jobId: null,
    estimateId: null,
    lines: [{ id: opts.lineId, description: draft.desc, quantity: 1, unitPrice: draft.amount }],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "unpaid",
    issuedDate: opts.today,
    dueDate: draft.due || opts.defaultDue,
    paidDate: null,
    paymentMethod: null,
    emailQueuedAt: null,
    splits: [],
  };
}
