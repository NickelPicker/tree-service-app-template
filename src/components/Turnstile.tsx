import { useEffect, useRef } from "react";
import { supabaseConfig, turnstileConfigured } from "../config";

/**
 * Cloudflare Turnstile spam check. Renders the widget and reports a
 * token (or null when it expires or fails). The token is checked on
 * the server: by the book-estimate Edge Function for bookings, and by
 * Supabase Auth for sign-in / sign-up when CAPTCHA is turned on there.
 * With no site key configured it renders nothing and reports null.
 */
type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("Could not load the spam check."));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export default function Turnstile({
  onToken,
  resetKey = 0,
}: {
  onToken: (token: string | null) => void;
  /** Change this number to get a fresh token (tokens are single-use). */
  resetKey?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  });

  useEffect(() => {
    if (!turnstileConfigured) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(box.current, {
          sitekey: supabaseConfig.turnstileSiteKey,
          callback: (t: string) => onTokenRef.current(t),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  useEffect(() => {
    if (resetKey === 0 || !widgetId.current || !window.turnstile) return;
    onTokenRef.current(null);
    window.turnstile.reset(widgetId.current);
  }, [resetKey]);

  if (!turnstileConfigured) return null;
  return <div ref={box} className="min-h-[65px]" />;
}
