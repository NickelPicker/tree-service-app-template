/**
 * When may the app replace what is on screen with a fresh copy from
 * the database?
 *
 * A save that failed stays queued as a whole snapshot of the app, built
 * on the data this screen had at the time. The save sends the
 * difference between that snapshot and the last copy loaded from the
 * database. If a teammate's change were loaded in between, the old
 * snapshot would look as if it deleted their new rows and undid their
 * edits, and "Retry save" would do exactly that.
 *
 * So while one of this screen's own changes is waiting (queued, being
 * sent, or failed), a fresh load waits too: it runs as soon as the
 * queue is empty. A load that was already on its way when the change
 * was made is thrown away, and loaded again afterwards. No React here,
 * so it is unit tested on its own.
 */
export interface SaveQueueState {
  /** A snapshot waiting to be sent (also after a failed save). */
  pending: boolean;
  /** A save is being sent right now. */
  running: boolean;
  /** The last save failed and is waiting for Retry or a new change. */
  blocked: boolean;
}

/** True while this screen has a change that has not reached the database. */
export function hasUnsavedChange(q: SaveQueueState): boolean {
  return q.pending || q.running || q.blocked;
}

/**
 * What to do with a request to load fresh data: load it "now", or
 * "after-save" once this screen's own change is saved. With nothing on
 * screen yet there is nothing to protect, so it always loads.
 */
export function reloadTiming(
  q: SaveQueueState,
  hasState: boolean,
): "now" | "after-save" {
  if (!hasState) return "now";
  return hasUnsavedChange(q) ? "after-save" : "now";
}

/**
 * A load finished. Use it ("use") or throw it away and load again once
 * the queue is empty ("discard"): a change made while it was loading is
 * not in it, and the queued save is built on the older data.
 */
export function loadArrival(
  q: SaveQueueState,
  hasState: boolean,
): "use" | "discard" {
  return reloadTiming(q, hasState) === "now" ? "use" : "discard";
}

/**
 * The save banner's "Discard change and reload": with a failed save
 * still queued (and not being sent right now), drop it and load the
 * real data again ("drop-and-reload"). Leaving it queued would hold back
 * every fresh load for good, and the next edit would be built on stale
 * data. Otherwise there is nothing to drop: only hide the banner.
 */
export function dismissFailedSave(q: SaveQueueState): "drop-and-reload" | "hide" {
  return q.blocked && !q.running ? "drop-and-reload" : "hide";
}
