/**
 * Reorderable top nav bar, persisted per person in localStorage —
 * the same place the dashboard layout order lives
 * (`dashboard-layout-<viewerId>`), so each person's tab order is
 * their own. The saved value is just an array of view ids in
 * the order the person put them; the labels and badges stay keyed by
 * view id in App.tsx, so a badge always travels with its own tab.
 * Kept in its own module (no imports) so the persistence and
 * reordering logic can be unit-tested without pulling in React.
 */

/** How long after a drag ends a click on the same tab is ignored. */
export const CLICK_SUPPRESS_MS = 200;

/**
 * A click that lands right after a drag ends is the drag's own
 * mouse-up, not a real tap — ignore it so dragging a tab never also
 * switches to it. `lastDragEndMs` is 0 when no drag has happened.
 */
export function isClickSuppressed(lastDragEndMs: number, nowMs: number): boolean {
  return lastDragEndMs > 0 && nowMs - lastDragEndMs < CLICK_SUPPRESS_MS;
}

export function loadNavOrder(
  storage: Pick<Storage, "getItem">,
  key: string,
): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    const out: string[] = [];
    for (const id of saved) {
      if (typeof id === "string" && id && !out.includes(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveNavOrder(
  storage: Pick<Storage, "setItem">,
  key: string,
  order: string[],
): void {
  try {
    storage.setItem(key, JSON.stringify(order));
  } catch {
    // Private mode etc. — the order just won't stick.
  }
}

export function clearNavOrder(
  storage: Pick<Storage, "removeItem">,
  key: string,
): void {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to clear anyway.
  }
}

/**
 * Order the views the person is allowed to see by their saved order.
 * Saved ids that aren't in this list (an owner-only tab for a crew
 * viewer, or a tab that no longer exists) are ignored, so reordering
 * can never reveal a tab the role can't see. Views with no saved
 * position keep their default order at the end, so a new tab added
 * later still shows up.
 */
export function applyNavOrder<T extends { id: string }>(
  views: T[],
  saved: string[],
): T[] {
  if (saved.length === 0) return [...views];
  const rank = new Map(saved.map((id, i) => [id, i] as const));
  const ordered = views.filter((v) => rank.has(v.id));
  const unsaved = views.filter((v) => !rank.has(v.id));
  ordered.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...ordered, ...unsaved];
}

/**
 * Move `draggedId` to just before `targetId` in an id list. No-op
 * when either id is missing or they are the same tab.
 */
export function moveIdInOrder(
  order: string[],
  draggedId: string,
  targetId: string,
): string[] {
  if (draggedId === targetId) return [...order];
  const rest = order.filter((id) => id !== draggedId);
  if (rest.length === order.length) return [...order];
  const at = rest.indexOf(targetId);
  if (at < 0) return [...order];
  return [...rest.slice(0, at), draggedId, ...rest.slice(at)];
}

/**
 * Nudge one tab one step left (-1) or right (+1) in an id list.
 * Clamps at the ends — nudging the first tab left does nothing.
 */
export function nudgeIdInOrder(
  order: string[],
  id: string,
  dir: -1 | 1,
): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  next[i] = order[j];
  next[j] = id;
  return next;
}
