-- Crew deletes the app offers, and "own row" rules for people removed
-- from the team (the "crew own deletes" rules).
-- Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(19);
-- A fixed daytime clock (the 8 PM rule, the "crew day and 8pm clockout" rules).
SELECT set_config('app.clock_now_for_tests', '2026-11-18 10:00:00-07', true);

-- ---------- helpers (same as role_based_rls.test.sql) ----------
CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, now(), '{}'::jsonb);
$$;
CREATE FUNCTION pg_temp.act_as(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE FUNCTION pg_temp.as_db()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
CREATE FUNCTION pg_temp.affected(p_sql text)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

\set co '''11111111-1111-4111-8111-111111111111'''
\set owner  '''cccccccc-0000-4000-8000-000000000001'''
\set office '''cccccccc-0000-4000-8000-000000000002'''
\set ground '''cccccccc-0000-4000-8000-000000000003'''
\set other  '''cccccccc-0000-4000-8000-000000000004'''
\set gone   '''cccccccc-0000-4000-8000-000000000005'''

-- ---------- seed (as the database owner) ----------
SELECT pg_temp.signup(:owner::uuid, 'owner@example.com');
SELECT pg_temp.signup(:office::uuid, 'office@example.com');
SELECT pg_temp.signup(:ground::uuid, 'ground@example.com');
SELECT pg_temp.signup(:other::uuid, 'other@example.com');
SELECT pg_temp.signup(:gone::uuid, 'gone@example.com');
-- Signups made pending roster rows (id = auth user id). Approve them.
UPDATE public.crew SET status = 'active' WHERE company_id = :co::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:office::uuid, :co::uuid, 'office'),
  (:ground::uuid, :co::uuid, 'crew'),
  (:other::uuid, :co::uuid, 'crew'),
  (:gone::uuid, :co::uuid, 'crew');

INSERT INTO public.time_off_requests (id, company_id, crew_id, start_date, end_date, status, requested_at) VALUES
  ('t-own-pending', :co::uuid, :ground, '2026-12-10', '2026-12-11', 'pending', '2026-11-13'),
  ('t-own-approved', :co::uuid, :ground, '2026-12-20', '2026-12-21', 'approved', '2026-11-13'),
  ('t-other-pending', :co::uuid, :other, '2026-12-10', '2026-12-11', 'pending', '2026-11-13'),
  ('t-other-pending-2', :co::uuid, :other, '2026-12-12', '2026-12-12', 'pending', '2026-11-13'),
  ('t-gone-pending', :co::uuid, :gone, '2026-12-10', '2026-12-11', 'pending', '2026-11-13');
INSERT INTO public.equipment_notes (id, company_id, equipment_id, author_id, author_name, text) VALUES
  ('n-own', :co::uuid, 'chipper', :ground, 'Ground', 'Belt squeals'),
  ('n-own-2', :co::uuid, 'chipper', :ground, 'Ground', 'Low on oil'),
  ('n-other', :co::uuid, 'chipper', :other, 'Other', 'Blade dull'),
  ('n-gone', :co::uuid, 'chipper', :gone, 'Gone', 'Tire low');
INSERT INTO public.timesheets (id, company_id, crew_id, date, hours) VALUES
  ('ts-gone', :co::uuid, :gone, '2026-11-12', 8);

-- ---------- crew: withdraw their own pending time-off request ----------
SELECT pg_temp.act_as(:ground::uuid);
SELECT is(pg_temp.affected($$DELETE FROM public.time_off_requests WHERE id = 't-own-pending'$$), 1,
  'crew can withdraw their own pending time-off request');
SELECT is(pg_temp.affected($$DELETE FROM public.time_off_requests WHERE id = 't-own-approved'$$), 0,
  'crew cannot delete their own approved time-off request');
SELECT is(pg_temp.affected($$DELETE FROM public.time_off_requests WHERE id = 't-other-pending'$$), 0,
  'crew cannot delete someone else''s time-off request');

-- ---------- crew: delete the equipment notes they wrote ----------
SELECT is(pg_temp.affected($$DELETE FROM public.equipment_notes WHERE id = 'n-own'$$), 1,
  'crew can delete an equipment note they wrote');
SELECT is(pg_temp.affected($$DELETE FROM public.equipment_notes WHERE id = 'n-other'$$), 0,
  'crew cannot delete someone else''s equipment note');
SELECT is(pg_temp.affected($$UPDATE public.equipment_notes SET text = 'edited' WHERE id = 'n-own-2'$$), 0,
  'crew still cannot edit equipment notes, even their own');

-- ---------- crew: unchanged limits ----------
SELECT lives_ok(
  $$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
    VALUES ('ts-ground', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000003',
      to_char(public.clock_now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD'), to_char(public.clock_now() AT TIME ZONE public.business_time_zone(), 'HH24:MI'))$$,
  'a team member can still add their own time entry (a live clock-in; typed hours need "May enter hours by hand" since the "manager pay and live clock-in" rules)');
SELECT is(pg_temp.affected($$DELETE FROM public.timesheets WHERE id = 'ts-ground'$$), 0,
  'crew still cannot delete time entries, even their own');
SELECT is((SELECT count(*)::int FROM public.timesheets), 1,
  'a team member sees only their own time entries');
SELECT pg_temp.as_db();

-- ---------- staff keep their delete rights ----------
SELECT pg_temp.act_as(:office::uuid);
SELECT is(pg_temp.affected($$DELETE FROM public.time_off_requests WHERE id = 't-other-pending-2'$$), 1,
  'office staff can delete anyone''s time-off request');
SELECT is(pg_temp.affected($$DELETE FROM public.equipment_notes WHERE id = 'n-other'$$), 1,
  'office staff can delete anyone''s equipment note');
SELECT pg_temp.as_db();

-- ---------- a person removed from the team ----------
-- What revoking access does in the app: the membership goes, the
-- roster card stays linked to the login with status 'revoked'.
DELETE FROM public.company_members WHERE user_id = :gone::uuid;
UPDATE public.crew SET status = 'revoked' WHERE auth_user_id = :gone::uuid;

SELECT pg_temp.act_as(:gone::uuid);
SELECT is(public.current_crew_id(:co::uuid), NULL,
  'a removed person no longer counts as their roster card');
SELECT is(public.current_crew_name(:co::uuid), NULL,
  'a removed person no longer has a crew name');
SELECT is((SELECT count(*)::int FROM public.timesheets), 0,
  'a removed person cannot read their old time entries');
SELECT throws_ok(
  $$INSERT INTO public.timesheets (id, company_id, crew_id, date, hours)
    VALUES ('ts-gone-new', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000005', '2026-11-13', 12)$$,
  '42501', NULL,
  'a removed person cannot add time to their own timesheet');
SELECT is(pg_temp.affected($$UPDATE public.timesheets SET hours = 20 WHERE id = 'ts-gone'$$), 0,
  'a removed person cannot change their old time entries');
SELECT throws_ok(
  $$INSERT INTO public.time_off_requests (id, company_id, crew_id, start_date, end_date, status, requested_at)
    VALUES ('t-gone-new', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000005', '2027-01-05', '2027-01-06', 'pending', '2026-11-13')$$,
  '42501', NULL,
  'a removed person cannot ask for time off');
SELECT is(pg_temp.affected($$DELETE FROM public.time_off_requests WHERE id = 't-gone-pending'$$), 0,
  'a removed person cannot withdraw a time-off request');
SELECT is(pg_temp.affected($$DELETE FROM public.equipment_notes WHERE id = 'n-gone'$$), 0,
  'a removed person cannot delete their old equipment notes');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
