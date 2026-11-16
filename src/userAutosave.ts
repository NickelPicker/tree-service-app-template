import type { CrewMember } from "./types";

/**
 * Whether a user form is valid enough to save. This is the same rule
 * the old explicit Save button enforced (a name is required) —
 * autosave must never write a nameless row, and it must never
 * overwrite a good row with a blanked-out name. A form that fails
 * this check is kept local only until the name is filled in again.
 * (Logins are real Supabase accounts; there is no app username.)
 */
export function isUserAutosaveReady(form: Pick<CrewMember, "name">): boolean {
  return form.name.trim() !== "";
}
