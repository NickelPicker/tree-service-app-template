/**
 * Collapsed dashboard panels, persisted per person in localStorage —
 * the same place the dashboard layout order lives (there is no
 * per-person settings table in shared state, so the layout stays on
 * the device). A panel id maps to true when collapsed. Unknown ids
 * are kept as-is; malformed saved data reads as "nothing collapsed".
 * Kept in its own module (no imports) so the persistence logic can
 * be unit-tested without pulling in React or Leaflet.
 */
export type CollapsedPanels = Record<string, boolean>;

export function loadCollapsedPanels(
  storage: Pick<Storage, "getItem">,
  key: string,
): CollapsedPanels {
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
      return {};
    }
    const out: CollapsedPanels = {};
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCollapsedPanels(
  storage: Pick<Storage, "setItem">,
  key: string,
  next: CollapsedPanels,
): void {
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // Private mode etc. — the collapse just won't stick.
  }
}

export function toggleCollapsedPanel(
  prev: CollapsedPanels,
  id: string,
): CollapsedPanels {
  return { ...prev, [id]: !prev[id] };
}
