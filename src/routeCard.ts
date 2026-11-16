/**
 * Where the month view's route card opens: beside the day the mouse is
 * over (right of it, or left when there is no room), kept on screen.
 * No React here, so it is unit tested on its own.
 */
export const ROUTE_CARD_WIDTH = 380;
const GAP = 8;
const EDGE = 16;
const CARD_MAX_HEIGHT = 420;

export function routeCardSpot(
  day: { left: number; right: number; top: number },
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const width = Math.min(ROUTE_CARD_WIDTH, viewportWidth - 2 * EDGE);
  let left = day.right + GAP;
  if (left + width > viewportWidth - EDGE) left = day.left - GAP - width;
  left = Math.max(EDGE, Math.min(left, viewportWidth - EDGE - width));
  const top = Math.max(EDGE, Math.min(day.top, viewportHeight - EDGE - CARD_MAX_HEIGHT));
  return { left, top };
}
