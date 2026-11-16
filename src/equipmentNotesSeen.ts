import type { AppState, CrewMember } from "./types";
import { isOwnerLike } from "./permissions";

/**
 * Equipment-note "seen" watermark, per person (localStorage, same
 * place the Dashboard layout and collapsed panels live).
 *
 * The team can leave a comment on any machine, but only managers
 * flip a machine's status — so a comment left by the crew has to
 * REACH management. The Equipment nav tab carries a red count badge
 * for managers: how many notes by non-managers arrived since that
 * manager last opened the Equipment page. Opening the page marks
 * everything seen up to that moment.
 *
 * First run after the deploy: there is no watermark yet, so the
 * count is 0 — only comments left after the manager's first visit
 * to the Equipment page count as new. Old notes are not
 * retroactively flagged.
 */
const key = (viewerId: string) => `equipment-notes-seen-${viewerId}`;

export function loadEquipmentNotesSeen(viewerId: string): string | null {
  try {
    return window.localStorage.getItem(key(viewerId));
  } catch {
    return null;
  }
}

export function markEquipmentNotesSeen(viewerId: string): void {
  try {
    window.localStorage.setItem(key(viewerId), new Date().toISOString());
  } catch {
    // Private mode / storage blocked — the badge just stays as-is.
  }
}

/**
 * Notes a manager hasn't seen yet: written by someone who is NOT
 * an owner or a manager (the crew, or office), after the manager's
 * last Equipment visit. Non-managers always get 0 — the badge is
 * management-only. A note whose author can't be found in the roster
 * counts (better to surface an unknown author than hide them); the
 * "owner" fallback author id is treated as management and doesn't
 * count.
 */
export function unseenEquipmentNoteCount(
  state: AppState | null,
  viewer: CrewMember | null | undefined,
): number {
  if (!state || !viewer || !isOwnerLike(viewer.appRole)) return 0;
  const seenAt = loadEquipmentNotesSeen(viewer.id);
  if (!seenAt) return 0;
  let count = 0;
  for (const n of state.equipmentNotes ?? []) {
    if (n.createdAt <= seenAt) continue;
    if (n.authorId === "owner") continue;
    const author = state.crew.find((c) => c.id === n.authorId);
    if (author && isOwnerLike(author.appRole)) continue;
    count += 1;
  }
  return count;
}
