/**
 * Maps a missing column/table name from a PostgREST schema-cache
 * error to the migration that adds it, so the save-error banner can
 * tell the owner exactly what to run instead of showing a bare
 * schema error (e.g. "Could not find the 'available_weekdays'
 * column of 'crew' in the schema cache" means migration 020 never
 * ran). Unknown names return null and the original message is shown
 * unchanged.
 */
export const MIGRATION_FOR_MISSING: Record<string, string> = {
  // Migration 020 — crew suggestion fields.
  available_weekdays: "020",
  can_drive_equipment: "020",
  works_well_with: "020",
  permissions: "020",
  // Migration 021 — named day crews.
  day_crews: "021",
  // Migration 022 — on-demand location + hourly billing.
  location_requests: "022",
  crew_locations: "022",
  billing_type: "022",
  hourly_rate: "022",
  // Migration 023 — equipment down flag.
  down: "023",
  // Migration 024 — estimate visit date/time.
  visit_date: "024",
  visit_time: "024",
  // Migration 026 — crew unavailability spans.
  crew_unavailability: "026",
  // Migration 027 — invoice payment method.
  payment_method: "027",
};

/**
 * Returns a "Run migration 0XX…" hint for a schema-cache error, or
 * null when the error is not a missing column/table we know about.
 * Handles both PostgREST phrasings:
 * - "Could not find the '<column>' column of '<table>' in the schema cache"
 * - "Could not find the table 'public.<table>' in the schema cache"
 */
export function migrationHintForSaveError(message: string): string | null {
  const column = message.match(
    /Could not find the '([^']+)' column of '([^']+)' in the schema cache/i,
  );
  if (column) {
    const migration = MIGRATION_FOR_MISSING[column[1]];
    if (!migration) return null;
    return `The database is missing the ${column[1]} column (migration ${migration}). Run "supabase db push --remote" to apply the latest migrations.`;
  }
  const table = message.match(
    /Could not find the table 'public\.([^']+)' in the schema cache/i,
  );
  if (table) {
    const migration = MIGRATION_FOR_MISSING[table[1]];
    if (!migration) return null;
    return `The database is missing the ${table[1]} table (migration ${migration}). Run "supabase db push --remote" to apply the latest migrations.`;
  }
  return null;
}
