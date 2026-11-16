/**
 * Open phones and tabs pick up a new deploy by themselves.
 *
 * An installed phone app left open all day never navigates, so it keeps
 * running the build it started with, even after a deploy changes what
 * the database allows (a build too old for the database can no longer
 * read or save some data). Each build knows its own id
 * (import.meta.env.VITE_BUILD_ID, set in vite.config.ts) and the site
 * serves the newest one at /version.json. The app checks when it comes
 * back to the screen, every few minutes, and after a load or save error,
 * and reloads once it is on an older build and nothing unsaved would be
 * lost (field taps are kept on the phone and survive a reload).
 */

/** This build's id; "dev" outside a production build (no checks then). */
export const BUILD_ID: string = (import.meta.env.VITE_BUILD_ID as string | undefined) ?? "dev";

export const BUILD_CHECK_EVERY_MS = 5 * 60 * 1000;

/** The newest build's id from /version.json, or null (no signal, dev server, bad file). */
export async function latestBuildId(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body?.build === "string" && body.build ? body.build : null;
  } catch {
    return null;
  }
}

/**
 * What to do with the newest build id: "reload" onto it, "wait" until
 * this screen's own changes are saved, or nothing ("current").
 */
export function buildAction(
  mine: string,
  latest: string | null,
  hasUnsavedChange: boolean,
): "current" | "wait" | "reload" {
  if (mine === "dev" || !latest || latest === mine) return "current";
  return hasUnsavedChange ? "wait" : "reload";
}

const RELOAD_KEY = "treeapp:build-reload";

/**
 * May the app reload onto `target` now? Not when it already reloaded for
 * that same build in the last 10 minutes and still runs the old one (a
 * cache somewhere), so it can never reload over and over.
 */
export function reloadAllowed(target: string, lastTry: string | null, now = Date.now()): boolean {
  if (!lastTry) return true;
  const [build, at] = lastTry.split("@");
  return build !== target || !(now - Number(at) < 10 * 60 * 1000);
}

/** Reload onto the newest build: let the service worker update first, then reload. */
export async function reloadToNewBuild(target: string): Promise<void> {
  let lastTry: string | null = null;
  try {
    lastTry = sessionStorage.getItem(RELOAD_KEY);
  } catch {
    // No storage: the time check below is skipped.
  }
  if (!reloadAllowed(target, lastTry)) return;
  try {
    sessionStorage.setItem(RELOAD_KEY, `${target}@${Date.now()}`);
  } catch {
    // Still reload.
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    // No service worker: a plain reload still fetches the new page.
  }
  window.location.reload();
}
