-- The "manager pay and live clock-in" rules:
-- 1. a manager (Sam) runs weekly pay (reads pay and every timesheet),
--    approves weeks and decides time off; crew cannot;
-- 2. crew clock in and out live only, unless "May enter hours by hand"
--    is on for them; staff may type any entry.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(50);
-- A fixed clock (2026-11-18 14:00 Denver), so the 8 PM rule of
-- the "crew day and 8pm clockout" rules does not depend on when the tests run.
SELECT set_config('app.clock_now_for_tests', '2026-11-18 14:00:00-07', true);

CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, now(), '{}'::jsonb);
$$;
CREATE FUNCTION pg_temp.act_as(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
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
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
-- Denver date and 'HH:MM' this many minutes from now.
CREATE FUNCTION pg_temp.d(p_min int DEFAULT 0) RETURNS text LANGUAGE sql AS $$
  SELECT to_char((public.clock_now() + make_interval(mins => p_min)) AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD') $$;
CREATE FUNCTION pg_temp.t(p_min int DEFAULT 0) RETURNS text LANGUAGE sql AS $$
  SELECT to_char((public.clock_now() + make_interval(mins => p_min)) AT TIME ZONE public.business_time_zone(), 'HH24:MI') $$;
GRANT EXECUTE ON FUNCTION pg_temp.d(int), pg_temp.t(int) TO authenticated;

\set co    '''dddddddd-0000-4000-8000-0000000da001'''
\set sam  '''dddddddd-1111-4000-8000-0000000da001'''
\set desk  '''dddddddd-1111-4000-8000-0000000da002'''
\set gus   '''dddddddd-1111-4000-8000-0000000da003'''
\set hank  '''dddddddd-1111-4000-8000-0000000da004'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Sam Co');
SELECT pg_temp.signup(:sam::uuid, 'sam-dp@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-dp@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-dp@example.com');
SELECT pg_temp.signup(:hank::uuid, 'hank-dp@example.com');
DELETE FROM public.company_members WHERE user_id IN (:sam::uuid, :desk::uuid, :gus::uuid, :hank::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:sam::uuid, :co::uuid, 'manager'), (:desk::uuid, :co::uuid, 'office'),
  (:gus::uuid, :co::uuid, 'crew'), (:hank::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'dp-sam', name = 'Sam Manager', company_id = :co::uuid, status = 'active', role = 'Office',
  pay_type = 'hourly', pay_amount = 30 WHERE auth_user_id = :sam::uuid;
UPDATE public.crew SET id = 'dp-desk', name = 'Olive Office', company_id = :co::uuid, status = 'active', role = 'Office'
  WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'dp-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  pay_type = 'hourly', pay_amount = 22 WHERE auth_user_id = :gus::uuid;
-- Hank may enter hours by hand.
UPDATE public.crew SET id = 'dp-hank', name = 'Hank Hand', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{"canManualClockIn": true}'::jsonb WHERE auth_user_id = :hank::uuid;

INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out) VALUES
  ('dp-old', :co::uuid, 'dp-gus', '2026-11-09', '07:00', '15:30');
INSERT INTO public.time_off_requests (id, company_id, crew_id, start_date, end_date, status, requested_at) VALUES
  ('dp-to1', :co::uuid, 'dp-gus', '2026-12-01', '2026-12-02', 'pending', '2026-11-15'),
  ('dp-to2', :co::uuid, 'dp-gus', '2026-12-08', '2026-12-08', 'pending', '2026-11-15'),
  ('dp-to3', :co::uuid, 'dp-gus', '2026-12-15', '2026-12-15', 'pending', '2026-11-15');

-- ---------- 1. Sam (manager): weekly pay, approve week, time off ----------
SELECT pg_temp.act_as(:sam::uuid);
SELECT is((SELECT pay_amount FROM public.crew WHERE id = 'dp-gus'), 22::numeric, 'a manager reads crew pay (weekly pay)');
SELECT is((SELECT count(*)::int FROM public.timesheets WHERE id = 'dp-old'), 1, 'a manager reads every timesheet (weekly pay)');
SELECT lives_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start, total_hours)
  VALUES ('dddddddd-0000-4000-8000-0000000da001', '2026-11-09', 8.5)$$, 'a manager approves a week');
SELECT is((SELECT approved_by FROM public.timesheet_week_approvals WHERE week_start = '2026-11-09'), 'Sam Manager',
  'the approval is stamped with the manager''s name');
SELECT is(pg_temp.affected($$DELETE FROM public.timesheet_week_approvals WHERE week_start = '2026-11-09'$$), 1,
  'a manager takes an approval back');
SELECT lives_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start, total_hours)
  VALUES ('dddddddd-0000-4000-8000-0000000da001', '2026-11-09', 8.5)$$, 'and approves it again');
SELECT is(pg_temp.affected($$UPDATE public.time_off_requests SET status = 'approved', decided_by = 'Sam Manager', decided_at = '2026-11-15' WHERE id = 'dp-to1'$$), 1,
  'a manager approves a time-off request');
SELECT is(pg_temp.affected($$UPDATE public.time_off_requests SET status = 'denied', decided_by = 'Sam Manager', decided_at = '2026-11-15' WHERE id = 'dp-to2'$$), 1,
  'a manager denies a time-off request');
SELECT lives_ok($$UPDATE public.timesheets SET clock_in = '06:30' WHERE id = 'dp-old'$$, 'a manager fixes a past clock time');
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, hours)
  VALUES ('dp-mgr-hours', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', '2026-11-10', 8)$$, 'a manager types hours for crew');
SELECT pg_temp.as_db();
SELECT is((SELECT status FROM public.time_off_requests WHERE id = 'dp-to1'), 'approved', 'the approval saved');
SELECT is((SELECT status FROM public.time_off_requests WHERE id = 'dp-to2'), 'denied', 'the denial saved');

-- ---------- 1. crew cannot ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.timesheet_week_approvals), 0, 'crew cannot read week approvals');
SELECT throws_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start, total_hours)
  VALUES ('dddddddd-0000-4000-8000-0000000da001', '2026-11-16', 1)$$, '42501', NULL, 'crew cannot approve a week');
SELECT is(pg_temp.affected($$DELETE FROM public.timesheet_week_approvals$$), 0, 'crew cannot undo an approval');
SELECT is((SELECT count(*)::int FROM public.crew WHERE id = 'dp-sam'), 0, 'crew cannot read someone else''s pay');
SELECT throws_ok($$UPDATE public.time_off_requests SET status = 'approved', decided_by = 'Gus Ground' WHERE id = 'dp-to3'$$,
  '42501', NULL, 'crew cannot approve their own time off');
SELECT is(pg_temp.affected($$UPDATE public.time_off_requests SET status = 'pending' WHERE id = 'dp-to2'$$), 0,
  'crew cannot undo a denial');
SELECT pg_temp.as_db();
SELECT is((SELECT status FROM public.time_off_requests WHERE id = 'dp-to3'), 'pending', 'the request is still pending');

-- ---------- 2. crew: live taps only ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('dp-queued', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', pg_temp.d(-600), pg_temp.t(-600))$$,
  'a tap queued on the phone 10 hours ago (no signal) still saves');
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('dp-live', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', pg_temp.d(), pg_temp.t())$$,
  'crew clock in live (now)');
SELECT lives_ok($$UPDATE public.timesheets SET notes = 'chipper', location = 'Shop' WHERE id = 'dp-live'$$,
  'crew still fix notes and location');
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('dp-stale', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', pg_temp.d(-780), pg_temp.t(-780))$$,
  'CT001', NULL, 'a clock-in 13 hours ago is refused as too old (its own code)');
SELECT throws_like($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('dp-stale', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', pg_temp.d(-780), pg_temp.t(-780))$$,
  'This tap was made more than 12 hours ago and couldn''t be saved. Tell the office the time you tapped: % at %.',
  'the too-old message gives the tapped time for the office');
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('dp-future', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', pg_temp.d(30), pg_temp.t(30))$$,
  '42501', NULL, 'a clock-in in the future is refused');
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, hours)
  VALUES ('dp-typed', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', pg_temp.d(), 8)$$,
  '42501', NULL, 'crew cannot type hours');
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('dp-pastday', 'dddddddd-0000-4000-8000-0000000da001', 'dp-gus', '2026-11-02', '07:00', '17:00')$$,
  'CT001', NULL, 'crew cannot type a past day''s clock times (refused as too old)');
SELECT throws_ok($$UPDATE public.timesheets SET clock_in = pg_temp.t(-120) WHERE id = 'dp-live'$$,
  '42501', NULL, 'crew cannot change a clock-in after the fact, even to a recent time');
SELECT throws_ok($$UPDATE public.timesheets SET clock_out = '18:00' WHERE id = 'dp-old'$$,
  '42501', NULL, 'crew cannot change an old entry''s clock-out');
SELECT throws_ok($$UPDATE public.timesheets SET date = '2026-11-10' WHERE id = 'dp-old'$$,
  '42501', NULL, 'crew cannot move an entry to another day');
SELECT throws_ok($$UPDATE public.timesheets SET hours = 9 WHERE id = 'dp-old'$$,
  '42501', NULL, 'crew cannot change hours');
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = pg_temp.t() WHERE id = 'dp-live'$$,
  'crew clock out live');
SELECT throws_ok($$UPDATE public.timesheets SET clock_out = NULL WHERE id = 'dp-live'$$,
  '42501', NULL, 'crew cannot clear a clock-out (reopen the clock)');
-- Upsert of an existing row, unchanged (the app's fallback save): fine.
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  SELECT id, company_id, crew_id, date, clock_in, clock_out FROM public.timesheets WHERE id = 'dp-old'
  ON CONFLICT (id) DO UPDATE SET clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out$$,
  'an upsert that changes nothing on an old entry saves');
SELECT pg_temp.as_db();

-- ---------- 2. clock-outs (no overnight shifts since the "crew day and 8pm clockout" rules) ----------
-- An entry from two days ago: a crew clock-out now closes it at 8 PM.
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('dp-forgot', :co::uuid, 'dp-gus', '2026-11-16', '08:00');
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = pg_temp.t() WHERE id = 'dp-forgot'$$,
  'a forgotten entry from an earlier day is closed by a crew clock-out');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'dp-forgot'), '20:00 true',
  'at 8 PM on its own day, marked closed automatically');
-- The rule with a fixed clock (2026-11-16, Denver MST).
SELECT is(public.timesheet_clock_out_check('2026-11-15', '02:00', '22:00', '2026-11-16 02:05-07'), 'bad',
  'no overnight: an entry clocked in at 22:00 is the office''s');
SELECT is(public.timesheet_clock_out_check('2026-11-15', '17:30', '07:00', '2026-11-16 02:05-07'), 'ok',
  'yesterday''s real clock-out tap, sent late, is kept');
SELECT is(public.timesheet_clock_out_check('2026-11-15', '02:00', '07:00', '2026-11-16 02:05-07'), 'cap',
  'yesterday''s entry clocked out this morning ends at 8 PM yesterday');
SELECT is(public.timesheet_clock_out_check('2026-11-16', '10:00', '07:00', '2026-11-16 10:01-07'), 'ok',
  'today''s entry clocks out live');
SELECT is(public.timesheet_clock_out_check('2026-11-16', '10:30', '07:00', '2026-11-16 10:01-07'), 'bad',
  'a clock-out half an hour ahead is refused');

-- ---------- 2. the night the clocks go back (2026-11-01) ----------
SELECT is((SELECT count(*)::int FROM public.timesheet_tap_moments('2026-11-01 01:30')), 2,
  '1:30 am on the first Sunday of November has two readings (MDT and MST)');
SELECT is(public.timesheet_tap_check('2026-11-01', '01:30', NULL, interval '12 hours', '2026-11-01 01:40-06'), 'ok',
  'a tap in the first (MDT) 1 am hour is accepted');
SELECT is(public.timesheet_tap_check('2026-11-01', '01:30', NULL, interval '12 hours', '2026-11-01 01:40-07'), 'ok',
  'a tap in the second (MST) 1 am hour is accepted');
SELECT is(public.timesheet_tap_check('2026-11-01', '01:30', NULL, interval '12 hours', '2026-11-01 01:00-06'), 'bad',
  'a 1:30 tap half an hour ahead of the first 1 am is still refused');
SELECT is(public.timesheet_tap_check('2026-11-01', '00:30', '23:00', interval '12 hours', '2026-11-02 08:00-07'), 'ok',
  'the tap check still reads a time before the clock-in as the next day (office-typed overnight entries)');

-- ---------- 2. "May enter hours by hand", and the office ----------
SELECT pg_temp.act_as(:hank::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('dp-hank', 'dddddddd-0000-4000-8000-0000000da001', 'dp-hank', '2026-11-02', '07:00', '17:00')$$,
  'with "May enter hours by hand", crew type past clock times');
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, hours)
  VALUES ('dp-hank-h', 'dddddddd-0000-4000-8000-0000000da001', 'dp-hank', '2026-11-03', 6)$$,
  'and hours');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$UPDATE public.crew SET permissions = '{"canManualClockIn": true}'::jsonb WHERE id = 'dp-gus'$$,
  '42501', NULL, 'crew cannot turn on "May enter hours by hand" for themselves');
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '16:00' WHERE id = 'dp-old'$$, 'the office fixes a crew entry');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
