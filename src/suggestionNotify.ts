/**
 * After a Sales login sends a suggested customer change, the app asks
 * the notify-suggestion edge function (as that login) to email the
 * business Gmail once. The suggestion is already saved: whatever
 * happens here (Gmail off, offline, limits, errors) never undoes it
 * and never shows an error to the Sales person.
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";

export async function notifySuggestion(requestId: string): Promise<void> {
  if (!supabase || !requestId) return;
  try {
    await supabase.functions.invoke("notify-suggestion", {
      body: { companyId: supabaseConfig.companyId, requestId },
    });
  } catch {
    /* the email is best-effort; the suggestion stands */
  }
}
