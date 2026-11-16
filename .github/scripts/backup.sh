#!/usr/bin/env bash
# Make one encrypted backup of the database: logins, structure and all data.
#
# Usage: BACKUP_PASSPHRASE=... .github/scripts/backup.sh <output-file.tar.gz.gpg>
#
#   BACKUP_TARGET=remote   dump the LINKED live project (only the Daily
#                          backup workflow sets this; run `supabase link`
#                          first). Anything else, or unset: the local
#                          Supabase on this machine.
#   SUPABASE_DB_PASSWORD   optional, live only, as in deploy.yml.
#
# What it writes: one file, encrypted with AES-256 using BACKUP_PASSPHRASE.
# Inside is a folder `backup/` with roles.sql, schema.sql, data.sql,
# auth_triggers.sql and history.json (the same files the deploy's rehearsal
# restores). The unencrypted files only ever exist in a private temporary
# folder, and are deleted as soon as the encrypted file is made, or when the
# script stops for any reason.
#
# Only reads the database. The log shows sizes, table names and row counts,
# never any data.
set -euo pipefail

OUT=${1:?usage: backup.sh <output-file>}
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "::error::BACKUP_PASSPHRASE is empty: refusing to make an unencrypted backup."
  exit 1
fi

umask 077
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/backup.XXXXXX")
# A throwaway gpg home with a short path (gpg-agent's socket path must be
# short), so nothing is kept in the runner's own keyring.
GNUPGHOME=$(mktemp -d /tmp/gpg.XXXXXX)
export GNUPGHOME
D="$WORK/backup"
mkdir -p "$D"
cleanup() {
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$WORK" "$GNUPGHOME"
}
trap cleanup EXIT

T=()
PW=()
if [ "${BACKUP_TARGET:-local}" = "remote" ]; then
  T=(--remote)
  [ -n "${SUPABASE_DB_PASSWORD:-}" ] && PW=(--password "$SUPABASE_DB_PASSWORD")
  echo "Target: the linked live project (read-only)"
else
  echo "Target: the local Supabase"
fi

# The deploy keeps up to 5 copies of every table inside the database
# (backup_<date> schemas). Their data is left out: it would make the file
# about 6 times bigger, and the newest real data is already in it. Their
# (empty) structure stays, so the restore matches the live database.
supabase db query "${T[@]}" --read-only --output-format json \
  "select coalesce(string_agg(format('%s.%s', schemaname, tablename), ',' order by 1), '') as t
   from pg_tables where schemaname ~ '^backup_[0-9]{8}_[0-9]{6}\$'" \
  | jq -r '[.. | objects | select(has("t")) | .t] | first // empty' > "$WORK/skip.txt"
SKIP=()
if [ -s "$WORK/skip.txt" ]; then
  SKIP=(-x "$(cat "$WORK/skip.txt")")
  echo "Data left out of the in-database backup copies: $(tr ',' '\n' < "$WORK/skip.txt" | cut -d. -f1 | sort -u | wc -l) schema(s), $(tr ',' '\n' < "$WORK/skip.txt" | wc -l) table(s)"
fi

supabase migration list "${T[@]}" --output-format json "${PW[@]}" > "$D/history.json"
supabase db dump "${T[@]}" "${PW[@]}" --role-only -f "$D/roles.sql"
supabase db dump "${T[@]}" "${PW[@]}" -f "$D/schema.sql"
supabase db dump "${T[@]}" "${PW[@]}" --data-only --use-copy "${SKIP[@]}" -f "$D/data.sql"
# Triggers on auth.users live outside the schema dump (as in deploy.yml).
supabase db query "${T[@]}" --read-only --output-format json \
  "select coalesce(string_agg(pg_get_triggerdef(t.oid) || ';', E'\n'), '') as ddl from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal" \
  | jq -r '[.. | objects | select(has("ddl")) | .ddl] | first // empty' > "$D/auth_triggers.sql"

for f in roles.sql schema.sql data.sql history.json; do
  [ -s "$D/$f" ] || { echo "::error::$f is empty: the backup is not complete."; exit 1; }
done

# Rows per table, counted from the COPY blocks of the dump (one line per row).
# Prints table names and numbers only.
echo "== Rows per table (tables with rows)"
awk '/^COPY /{t=$2; n=0; next}
     /^\\\.$/ {if (t != "" && n > 0) printf "%-55s %8d\n", t, n; t=""; next}
     t != "" {n++}' "$D/data.sql" | tr -d '"'
echo "== Totals"
awk '/^COPY /{t=1; tables++; next} /^\\\.$/{t=0; next} t{rows++} END{printf "tables: %d, rows: %d\n", tables, rows}' "$D/data.sql"
echo "== Files (unencrypted sizes)"
(cd "$D" && du -h -- * | sort -k2)

# Encrypt. The passphrase reaches gpg on file descriptor 3 from a shell
# builtin (never on a command line, never in the log). tar's output goes
# straight into gpg, so no unencrypted archive is ever written.
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
tar -C "$WORK" -czf - backup \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
        --symmetric --cipher-algo AES256 --compress-algo none \
        --output "$OUT" 3< <(printf '%s' "$BACKUP_PASSPHRASE")
rm -rf "$D"

# Prove the file opens with the passphrase: list the file names inside only.
echo "== Check: the encrypted file opens and holds"
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$OUT" \
    3< <(printf '%s' "$BACKUP_PASSPHRASE") | tar -tzf - | sort
echo "Encrypted backup: $(du -h "$OUT" | cut -f1)"
