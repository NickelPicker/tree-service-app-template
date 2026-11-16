#!/usr/bin/env bash
# Rehearse a deploy on a COPY of the live database, on this machine only.
#
# Usage: .github/scripts/rehearse.sh <dump-dir>
#   <dump-dir> holds roles.sql, schema.sql and data.sql from `supabase db dump`,
#   and optionally history.json from `supabase migration list --remote
#   --output-format json` (the live project's applied migrations).
# Needs a running local Supabase whose database is EMPTY (started with
# no migrations). Nothing here connects to the live project.
#
# Fails (non-zero exit) if, after applying the migrations to the copy:
#   - any existing table lost or gained rows,
#   - the number of companies changed,
#   - app_config does not point at the company in src/config.ts,
#   - a confirmed login for the owner email is not the owner,
#   - any other login's role changed,
#   - the structure differs from .github/diagnostics/expected_after_deploy.txt,
#   - a crew login can see more than its own work (simulated with RLS).
set -euo pipefail

DUMP_DIR=$1
DB=${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
SUPER=${LOCAL_SUPER_URL:-postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
q() { psql "$DB" -X -Atq -v ON_ERROR_STOP=1 -c "$1"; }

COUNTS_SQL="select table_name || '=' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text
            from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
# Login ids, not emails, so nothing personal reaches the logs.
MEMBERS_SQL="select m.user_id || ' ' || m.company_id || ' ' || m.role from public.company_members m order by 1"

# Safety: the CLI commands below must target the LOCAL stack, never the
# linked live project (Supabase CLI 3 targets local unless --remote).
if ! (cd "$ROOT" && supabase migration list 2>&1 | grep -q "Target: local stack"); then
  echo "REFUSING: the Supabase CLI is not targeting the local stack"; exit 1
fi

echo "== 1. Restore the copy"
psql "$SUPER" -X -q --single-transaction -v ON_ERROR_STOP=1 \
  -f "$DUMP_DIR/roles.sql" -f "$DUMP_DIR/schema.sql" \
  -c 'SET session_replication_role = replica' -f "$DUMP_DIR/data.sql"
# Triggers on auth.users are not in the public schema dump.
if [ -s "$DUMP_DIR/auth_triggers.sql" ]; then
  psql "$SUPER" -X -q -v ON_ERROR_STOP=1 -f "$DUMP_DIR/auth_triggers.sql"
  echo "auth.users triggers copied: $(grep -c 'CREATE TRIGGER' "$DUMP_DIR/auth_triggers.sql")"
fi
# The very first deploy: the live project has none of the app's tables yet.
FIRST_DEPLOY=0
[ "$(q "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'company_members'")" = "0" ] && FIRST_DEPLOY=1
q "$COUNTS_SQL" > "$WORK/counts_before.txt"
if [ "$FIRST_DEPLOY" = 1 ]; then
  echo "first deploy: the live project has no app tables yet"
  : > "$WORK/members_before.txt"
  COMPANIES_BEFORE=0
else
  q "$MEMBERS_SQL" > "$WORK/members_before.txt"
  COMPANIES_BEFORE=$(q "select count(*) from public.companies")
fi
echo "tables: $(wc -l < "$WORK/counts_before.txt"), logins with access: $(wc -l < "$WORK/members_before.txt"), companies: $COMPANIES_BEFORE"
echo "auth users in the copy: $(q 'select count(*) from auth.users')"

echo "== 2. Apply the migrations to the copy"
# The dump does not carry the migration history, so mark on the copy
# exactly what the live project has applied.
applied=""
if [ -s "$DUMP_DIR/history.json" ]; then
  applied=$(jq -r '[.migrations[] | select((.remote // "") != "") | .remote] | join(" ")' "$DUMP_DIR/history.json")
fi
echo "already applied on live: ${applied:-none}"
if [ -n "$applied" ]; then
  # shellcheck disable=SC2086
  (cd "$ROOT" && supabase migration repair --status applied $applied)
fi
(cd "$ROOT" && supabase db push --yes)

fail=0
bad() { echo "FAIL: $*"; fail=1; }

echo "== 3. Row counts (every existing table must be unchanged)"
q "$COUNTS_SQL" > "$WORK/counts_after.txt"
while IFS= read -r line; do
  grep -qxF "$line" "$WORK/counts_after.txt" || bad "row count changed: before $line, after $(grep "^${line%%=*}=" "$WORK/counts_after.txt" || echo 'table gone')"
done < "$WORK/counts_before.txt"
[ "$fail" = 0 ] && echo "ok: $(wc -l < "$WORK/counts_before.txt") tables, same row counts"

echo "== 4. Company"
if [ "$FIRST_DEPLOY" = 1 ]; then
  echo "first deploy: the baseline creates the company"
else
  [ "$(q 'select count(*) from public.companies')" = "$COMPANIES_BEFORE" ] && echo "ok: no company added" || bad "the number of companies changed"
fi
APP_COMPANY=$(grep -oE 'companyId: "[^"]+"' "$ROOT/src/config.ts" | cut -d'"' -f2)
DB_COMPANY=$(q "select company_id from public.app_config")
echo "app_config company: $DB_COMPANY, src/config.ts company: $APP_COMPANY"
[ "$DB_COMPANY" = "$APP_COMPANY" ] && echo "ok: the app and the database agree" || bad "app_config and src/config.ts point at different companies"

echo "== 5. Logins and roles"
OWNER_EMAIL=$(q "select owner_email from public.app_config")
OWNER_LOGIN=$(q "select count(*) from auth.users where lower(email) = '$OWNER_EMAIL' and email_confirmed_at is not null")
if [ "$OWNER_LOGIN" = "1" ]; then
  role=$(q "select m.role from public.company_members m join auth.users u on u.id = m.user_id where lower(u.email) = '$OWNER_EMAIL' and m.company_id = '$DB_COMPANY'")
  [ "$role" = "owner" ] && echo "ok: the owner email login is the owner" || bad "the owner email login has role '$role', not owner"
else
  echo "note: no confirmed login for the owner email yet; it becomes owner on signup + confirmation"
fi
q "$MEMBERS_SQL" > "$WORK/members_after.txt"
# Every login keeps its role, except: logins on the owner list may become
# owner, and changes listed in .github/diagnostics/expected_role_changes.txt
# ("<login id> <company id> <old role> <new role>") are intended.
OWNER_LIST_UIDS=" $(q "select coalesce(string_agg(id::text, ' '), '') from auth.users where email_confirmed_at is not null and (lower(email) = (select owner_email from public.app_config) or lower(email) = any (coalesce((select extra_owner_emails from public.app_config), '{}')))") "
ALLOWED="$ROOT/.github/diagnostics/expected_role_changes.txt"
roles_ok=1
while read -r uid co role; do
  after=$(awk -v u="$uid" -v c="$co" '$1 == u && $2 == c {print $3}' "$WORK/members_after.txt")
  [ "$after" = "$role" ] && continue
  if [ "$after" = "owner" ] && [[ "$OWNER_LIST_UIDS" == *" $uid "* ]]; then
    echo "expected: login $uid -> owner (on the owner list)"; continue
  fi
  if [ -f "$ALLOWED" ] && grep -qxF "$uid $co $role ${after:-removed}" "$ALLOWED"; then
    echo "expected: login $uid $role -> ${after:-removed} (listed)"; continue
  fi
  bad "login $uid changed role: $role -> ${after:-removed}"; roles_ok=0
done < "$WORK/members_before.txt"
while read -r uid co role; do
  grep -q "^$uid $co " "$WORK/members_before.txt" && continue
  if [ "$role" = "owner" ] && [[ "$OWNER_LIST_UIDS" == *" $uid "* ]]; then
    echo "expected: login $uid added as owner (on the owner list)"; continue
  fi
  bad "login $uid gained access: $role"; roles_ok=0
done < "$WORK/members_after.txt"
[ "$roles_ok" = 1 ] && echo "ok: logins kept their roles (apart from the expected changes)"
echo "roles now: $(q "select string_agg(role || '=' || n, ' ') from (select role, count(*) n from public.company_members group by 1 order by 1) s")"

echo "== 6. Structure"
q "$(cat "$ROOT/.github/diagnostics/structure_fingerprint.sql")" > "$WORK/structure.txt"
diff "$WORK/structure.txt" "$ROOT/.github/diagnostics/expected_after_deploy.txt" \
  | grep -E '^[<>]' \
  > "$WORK/structure_diff.txt" || true
if [ -s "$WORK/structure_diff.txt" ]; then bad "unexpected structure differences:"; cat "$WORK/structure_diff.txt"; else echo "ok: structure matches"; fi

echo "== 7. What each crew login can see (row-level security, simulated)"
crew_logins=$(q "select m.user_id from public.company_members m where m.role = 'crew' and m.company_id = '$DB_COMPANY'")
for uid in $crew_logins; do
  me=$(q "select id from public.crew where auth_user_id = '$uid' and company_id = '$DB_COMPANY' limit 1")
  [ -n "$me" ] || { echo "note: crew login $uid has no roster row"; continue; }
  # Every job on a day they work: a day they are on a job or on the day's crew.
  expected_jobs=$(q "select count(*) from public.jobs j where j.company_id = '$DB_COMPANY' and (exists (select 1 from public.jobs mine where mine.company_id = j.company_id and mine.date = j.date and '$me' = any(mine.crew_ids)) or exists (select 1 from public.day_crews d where d.company_id = j.company_id and d.date = j.date and '$me' = any(d.member_ids)))")
  sees_all_jobs=$(q "select coalesce((permissions ->> 'seeAllJobs') = 'true', false) from public.crew where id = '$me'")
  sees_money=$(q "select coalesce((permissions ->> 'seeMoney') = 'true', false) from public.crew where id = '$me'")
  read -r jobs crew_rows invoices <<<"$( (psql "$DB" -X -Atq -F ' ' -v ON_ERROR_STOP=1 <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub', '$uid', 'role', 'authenticated', 'aal', 'aal2')::text, true);
set local role authenticated;
select (select count(*) from public.jobs), (select count(*) from public.crew), (select count(*) from public.invoices);
rollback;
SQL
) | tail -n 1)"
  echo "crew login: sees $jobs jobs (own: $expected_jobs, see-all switch: $sees_all_jobs), $crew_rows roster rows, $invoices invoices (see-money switch: $sees_money)"
  if [ "$sees_all_jobs" = "f" ] && [ "$jobs" != "$expected_jobs" ]; then bad "crew login sees $jobs jobs, expected $expected_jobs"; fi
  [ "$crew_rows" = "1" ] || bad "crew login sees $crew_rows full roster rows (expected only their own)"
  if [ "$sees_money" = "f" ] && [ "$invoices" != "0" ]; then bad "crew login can read invoices"; fi
done

echo "== 8. What a manager can see"
mgr=$(q "select m.user_id from public.company_members m where m.role in ('manager', 'owner') and m.company_id = '$DB_COMPANY' limit 1")
if [ -n "$mgr" ]; then
  read -r customers total <<<"$( (psql "$DB" -X -Atq -F ' ' -v ON_ERROR_STOP=1 <<SQL
begin;
select set_config('request.jwt.claims', json_build_object('sub', '$mgr', 'role', 'authenticated', 'aal', 'aal2')::text, true);
set local role authenticated;
select (select count(*) from public.customers), (select count(*) from public.customers where company_id = '$DB_COMPANY');
rollback;
SQL
) | tail -n 1)"
  total_real=$(q "select count(*) from public.customers where company_id = '$DB_COMPANY'")
  echo "manager sees $customers customers (company has $total_real)"
  [ "$customers" = "$total_real" ] || bad "a manager does not see every customer"

  echo "== 9. Two-step login: a password-only session of a login with it on sees nothing"
  # Only in this throwaway copy, and rolled back: pretend the manager has
  # two-step login on, then look with a password-only (aal1) session.
  pw_only=$( (psql "$DB" -X -Atq -v ON_ERROR_STOP=1 <<SQL
begin;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), '$mgr', 'rehearsal check', 'totp', 'verified', now(), now());
select set_config('request.jwt.claims', json_build_object('sub', '$mgr', 'role', 'authenticated', 'aal', 'aal1')::text, true);
set local role authenticated;
select count(*) from public.customers;
rollback;
SQL
) | tail -n 1)
  echo "password-only session sees $pw_only customers (expected 0)"
  [ "$pw_only" = "0" ] || bad "a password-only session of a login with two-step login on can read customers"
fi

if [ "$fail" != 0 ]; then echo "REHEARSAL FAILED"; exit 1; fi
echo "REHEARSAL PASSED"
