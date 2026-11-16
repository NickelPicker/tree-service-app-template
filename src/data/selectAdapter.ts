import type { DataAdapter } from "./adapter";
import { adapter as mockAdapter } from "./mockAdapter";
import { SupabaseAdapter } from "./supabaseAdapter";
import { supabaseConfigured } from "../config";

/**
 * Adapter selector. The app keeps using the local mock adapter (an
 * empty starting state, localStorage) whenever src/config.ts still
 * holds its PLACEHOLDER values, so the phone preview runs with no
 * data by default. Once a real project URL and anon key are filled
 * in, the app switches to the Supabase adapter with no other code
 * change.
 */
export const adapter: DataAdapter = supabaseConfigured
  ? new SupabaseAdapter()
  : mockAdapter;
