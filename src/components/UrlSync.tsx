import { useEffect, useRef } from "react";
import { useStore, type View } from "../store";
import { newJobDate } from "../jobForm";
import {
  addressWrite,
  formatRoute,
  mergeDrawers,
  parseRoute,
  sameDrawers,
} from "../route";
import { todayStr } from "../utils";

/**
 * Keeps the web address in step with the screen (src/route.ts): every
 * tab and open panel gets its own address, so Back goes to the previous
 * screen or closes the top panel instead of leaving the app, and an
 * address opened from a link shows that screen. Rendered only inside
 * the signed-in app, so sign-in links and the public pages keep their
 * own addresses. Renders nothing.
 */
export default function UrlSync({
  activeView,
  allowed,
  onView,
}: {
  /** The screen actually shown (after the role's allowed list). */
  activeView: View;
  /** Screens this person may open; an address naming another one is ignored. */
  allowed: readonly View[];
  onView: (v: View) => void;
}) {
  const { state, drawerStack, replaceDrawers } = useStore();
  // Set while the screen is catching up with an address (first load,
  // Back, Forward): the next address write replaces instead of adding
  // a history entry.
  const replaceNext = useRef(false);
  const firstRun = useRef(true);
  // The screen the address was last written for.
  const shown = useRef({ view: activeView as string, drawers: drawerStack });
  const latest = useRef({ activeView, drawerStack, state });
  const allowedRef = useRef(allowed);
  useEffect(() => {
    latest.current = { activeView, drawerStack, state };
    allowedRef.current = allowed;
  });

  useEffect(() => {
    const apply = () => {
      const cur = latest.current;
      const route = parseRoute(
        window.location.hash,
        newJobDate(null, todayStr(), cur.state?.closedDays ?? []),
      );
      if (!route) return;
      if (!allowedRef.current.includes(route.view)) route.view = cur.activeView;
      const drawers = mergeDrawers(cur.drawerStack, route.drawers);
      const changes =
        route.view !== cur.activeView || !sameDrawers(cur.drawerStack, drawers);
      if (!changes) return;
      replaceNext.current = true;
      if (route.view !== cur.activeView) onView(route.view);
      if (!sameDrawers(cur.drawerStack, drawers)) replaceDrawers(drawers);
    };
    apply();
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
    // Once: the handler reads the latest screen from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prev = shown.current;
    shown.current = { view: activeView, drawers: drawerStack };
    // The first run sees the screen from before the address was read.
    if (firstRun.current) {
      firstRun.current = false;
      if (replaceNext.current) return;
    }
    const want = formatRoute(activeView, drawerStack);
    if (window.location.hash === want) {
      replaceNext.current = false;
      return;
    }
    const url = `${window.location.pathname}${window.location.search}${want}`;
    const here = window.history.state as { d?: unknown } | null;
    const depth = typeof here?.d === "number" ? here.d : 0;
    if (replaceNext.current || !window.location.hash.startsWith("#/")) {
      window.history.replaceState(window.history.state, "", url);
    } else {
      // Closing a panel steps back in history instead of adding an
      // entry, so Back does not open the closed panel again.
      const w = addressWrite(prev, { view: activeView, drawers: drawerStack }, depth);
      if (w.kind === "back") {
        // The popstate that follows finds the screen already matching.
        window.history.go(-w.steps);
      } else if (w.kind === "replace") {
        window.history.replaceState({ d: 0 }, "", url);
      } else {
        window.history.pushState({ d: w.depth }, "", url);
      }
    }
    replaceNext.current = false;
  }, [activeView, drawerStack]);

  return null;
}
