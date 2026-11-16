import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig, supabaseConfigured } from "../config";

/**
 * The one Supabase client for the app, created only once a real project
 * URL and anon key are filled into config.ts. The client stores the
 * session (default localStorage) and refreshes its token itself, so the
 * adapter never touches tokens: every request carries the publishable
 * anon key as `apikey` plus the logged-in user's session JWT as the
 * Authorization bearer, which is what the membership-keyed row-level
 * security policies in supabase/migrations check.
 *
 * With placeholders still in config.ts this is null and the app keeps
 * using the mock adapter (see selectAdapter.ts). Never put the
 * service_role key here; the browser app must never hold it.
 */
/**
 * Every REST request gets a 15-second timeout. The browser fetch()
 * has no timeout of its own, so a single stalled request used to hang
 * the whole save at "Saving…" forever (seen 2026-11-11: 90+ seconds
 * on a computer). With the timeout the request fails fast, the save
 * reports which table it died on, and Retry can re-run it.
 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Uploading or opening a licence/insurance file moves up to ~7 MB, which
 * can take longer than 15 seconds on a phone: those requests get 2 minutes.
 */
const FILE_TIMEOUT_MS = 120000;

function timeoutFor(input: RequestInfo | URL): number {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.includes("/rest/v1/company_document_files") || url.includes("/rest/v1/equipment_problem_photos")
    ? FILE_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
}

function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(input));
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseConfig.url, supabaseConfig.anonKey, {
      global: { fetch: fetchWithTimeout },
    })
  : null;
