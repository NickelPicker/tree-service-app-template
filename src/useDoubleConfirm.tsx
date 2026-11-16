import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import DoubleConfirm from "./components/DoubleConfirm";
import { massEmailTexts, needsDoubleConfirm, type DoubleConfirmTexts } from "./doubleConfirm";

/**
 * Promise-based double confirm. Render `dialog` somewhere in the
 * component (it portals to the page body), then:
 *
 *   if (!(await confirmEmails(n, "Each person gets their day."))) return;
 *
 * confirmEmails resolves true at once for 3 emails or fewer (the
 * owner's rule starts above 3), otherwise only when both dialogs were
 * confirmed. `ask` always shows both dialogs.
 */
export function useDoubleConfirm(): {
  ask: (texts: DoubleConfirmTexts) => Promise<boolean>;
  confirmEmails: (count: number, what?: string) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [texts, setTexts] = useState<DoubleConfirmTexts | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [round, setRound] = useState(0);

  const finish = useCallback((ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    setTexts(null);
    r?.(ok);
  }, []);

  // Leaving the screen with a dialog open counts as Cancel.
  useEffect(() => () => resolver.current?.(false), []);

  const ask = useCallback((t: DoubleConfirmTexts) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setRound((n) => n + 1);
      setTexts(t);
    });
  }, []);

  const confirmEmails = useCallback(
    (count: number, what = "") =>
      needsDoubleConfirm(count) ? ask(massEmailTexts(count, what)) : Promise.resolve(true),
    [ask],
  );

  const dialog = texts ? <DoubleConfirm key={round} texts={texts} onDone={finish} /> : null;
  return { ask, confirmEmails, dialog };
}
