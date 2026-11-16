-- The "crew day and 8pm clockout" rules:
-- no crew clock-in after 8 PM, no overnight crew shifts, every open
-- entry closed at 8 PM on its own day (auto_closed), and a live-only
-- crew login cannot add overlapping entries (paid twice).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(47);

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
CREATE FUNCTION pg_temp.at(p_when text)
RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.clock_now_for_tests', p_when, true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.at(text) TO authenticated;

\set co    '''eeeeeeee-0000-4000-8000-00000000e801'''
\set co2   '''eeeeeeee-0000-4000-8000-00000000e802'''
\set desk  '''eeeeeeee-1111-4000-8000-00000000e801'''
\set gus   '''eeeeeeee-1111-4000-8000-00000000e802'''
\set hank  '''eeeeeeee-1111-4000-8000-00000000e803'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Eight Co'), (:co2::uuid, 'Other Co');
SELECT pg_temp.signup(:desk::uuid, 'desk-e8@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-e8@example.com');
SELECT pg_temp.signup(:hank::uuid, 'hank-e8@example.com');
DELETE FROM public.company_members WHERE user_id IN (:desk::uuid, :gus::uuid, :hank::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:desk::uuid, :co::uuid, 'office'), (:gus::uuid, :co::uuid, 'crew'), (:hank::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'e8-desk', name = 'Olive Office', company_id = :co::uuid, status = 'active', role = 'Office'
  WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'e8-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Groundsman'
  WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'e8-hank', name = 'Hank Hand', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{"canManualClockIn": true}'::jsonb WHERE auth_user_id = :hank::uuid;

-- ---------- 1. no clock-in after 8 PM ----------
SELECT pg_temp.at('2026-11-17 20:10:00-07');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-late', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-17', '20:05')$$,
  'CT001', NULL, 'crew cannot clock in after 8 PM (kept on the phone)');
SELECT throws_like($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-late', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-17', '20:05')$$,
  'After 8 PM the office enters hours.%Tell the office the time you tapped: 2026-11-17 at 20:05.',
  'with a plain message and the tapped time');
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-queued', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-17', '19:30')$$,
  'a tap made before 8 PM and sent after it still saves');

-- ---------- 2. a clock-out after 8 PM is saved as 8 PM ----------
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '20:10' WHERE id = 'e8-queued'$$,
  'crew clock out after 8 PM');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-queued'), '20:00 true',
  'the clock-out is saved as 8 PM, marked closed automatically');

-- ---------- 3. no overnight shifts ----------
SELECT pg_temp.at('2026-11-18 10:00:00-07');
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('e8-day', :co::uuid, 'e8-gus', '2026-11-18', '09:00');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$UPDATE public.timesheets SET clock_out = '08:30' WHERE id = 'e8-day'$$,
  'CT001', NULL, 'a clock-out earlier than the clock-in is refused');
SELECT lives_ok($$UPDATE public.timesheets SET notes = 'chipper', auto_closed = true WHERE id = 'e8-day'$$,
  'crew still fix notes');
SELECT pg_temp.as_db();
SELECT is((SELECT auto_closed FROM public.timesheets WHERE id = 'e8-day'), false,
  'crew cannot mark an entry closed automatically');

-- ---------- 4. paid twice: overlapping crew entries ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('e8-dup', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-18', '08:00', '09:30')$$,
  'CT001', NULL, 'crew cannot add a finished entry that runs into the open one');
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-early', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-18', '08:00')$$,
  'CT001', NULL, 'crew cannot open an earlier entry next to the live one');
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('e8-both', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-18', '09:40', '09:55')$$,
  'both taps saved at once (no signal) after the open entry are fine');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-day'), '09:40',
  'and close the open entry at the new clock-in');
SELECT throws_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('e8-dup2', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-18', '09:00', '09:50')$$,
  'CT001', NULL, 'crew cannot add the same hours again');
SELECT throws_like($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('e8-dup2', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-18', '09:00', '09:50')$$,
  'These hours overlap another of your time entries%', 'with a plain message');
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-now', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-18', '10:00')$$,
  'a live clock-in after the finished entries saves');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.timesheets WHERE crew_id = 'e8-gus' AND date = '2026-11-18'), 3,
  'only the real entries are there');
SELECT pg_temp.act_as(:hank::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('e8-hank', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-hank', '2026-11-17', '22:00', '23:30')$$,
  '"May enter hours by hand": past 8 PM can still be typed');
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in, clock_out)
  VALUES ('e8-office', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-16', '18:00', '22:00')$$,
  'the office types hours past 8 PM');
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '19:15' WHERE id = 'e8-queued'$$,
  'the office fixes an entry closed at 8 PM');
SELECT pg_temp.as_db();
SELECT is((SELECT auto_closed FROM public.timesheets WHERE id = 'e8-queued'), false,
  'a changed clock-out is no longer marked closed automatically');

-- ---------- 5. open entries are closed at 8 PM ----------
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('e8-old', :co::uuid, 'e8-hank', '2026-11-16', '07:00'),
  ('e8-office-late', :co::uuid, 'e8-desk', '2026-11-16', '21:00'),
  ('e8-other', :co2::uuid, 'x-crew', '2026-11-16', '07:00');
SELECT pg_temp.at('2026-11-18 19:00:00-07');
SELECT is(public.close_open_clocks_at_8pm(:co::uuid), 1, 'before 8 PM only earlier days are closed');
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-old'), '20:00 true',
  'an open entry from an earlier day is closed at 8 PM of its day');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-now'), NULL, 'today''s open entry stays open before 8 PM');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-office-late'), NULL,
  'an open entry clocked in after 8 PM (the office''s) is left alone');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-other'), NULL, 'another company is not touched');
SELECT pg_temp.at('2026-11-18 20:17:00-07');
SELECT pg_temp.act_as(:gus::uuid);
SELECT is(public.close_open_clocks_at_8pm('eeeeeeee-0000-4000-8000-00000000e801'), 1,
  'a team member runs the 8 PM close for their company');
SELECT throws_ok($$SELECT public.close_open_clocks_at_8pm('eeeeeeee-0000-4000-8000-00000000e802')$$,
  '42501', NULL, 'not for another company');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-now'), '20:00 true',
  'after 8 PM today''s open entry is closed at 8 PM');
SELECT is(public.close_open_clocks_at_8pm(NULL), 1, 'the hourly run closes every company''s');
SELECT ok(NOT has_function_privilege('anon', 'public.close_open_clocks_at_8pm(uuid)', 'EXECUTE'),
  'signed-out visitors cannot run it');

-- ---------- 6. clocking in closes yesterday's open clock ----------
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('e8-forgot', :co::uuid, 'e8-gus', '2026-11-18', '15:00');
SELECT pg_temp.at('2026-11-19 07:05:00-07');
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-next', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-19', '07:00')$$,
  'crew clock in the next morning');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-forgot'), '20:00 true',
  'yesterday''s open clock is closed at 8 PM yesterday');

-- ---------- 7. a clock-out tap that arrives after the 8 PM close ----------
SELECT pg_temp.at('2026-11-20 08:00:00-07');
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('e8-q', :co::uuid, 'e8-gus', '2026-11-20', '08:00');
SELECT pg_temp.at('2026-11-20 20:17:00-07');
SELECT public.close_open_clocks_at_8pm(NULL);
SELECT pg_temp.at('2026-11-20 21:00:00-07');
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '17:00' WHERE id = 'e8-q'$$,
  'a 5 PM clock-out sent at 9 PM (no signal) is saved after the 8 PM close');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-q'), '17:00 false',
  'the real tap replaces 8 PM and is no longer marked closed automatically');
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '20:30' WHERE id = 'e8-next'$$,
  'a tap at 8 PM or later on a closed entry is not refused');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-next'), '20:00 true',
  'and changes nothing');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$UPDATE public.timesheets SET clock_out = '10:00' WHERE id = 'e8-next'$$,
  'CT001', NULL, 'a tap more than 24 hours old is refused and kept on the phone');
SELECT pg_temp.as_db();
-- The next morning's clock-in arrives before the queued clock-out.
SELECT pg_temp.at('2026-11-21 08:00:00-07');
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('e8-r', :co::uuid, 'e8-gus', '2026-11-21', '08:00');
SELECT pg_temp.at('2026-11-22 07:05:00-07');
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-r2', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-22', '07:00')$$,
  'clock in the next morning (closes yesterday''s at 8 PM)');
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '16:00' WHERE id = 'e8-r'$$,
  'then yesterday''s queued clock-out arrives and is saved');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-r'), '16:00 false',
  'with the tapped time');

-- ---------- 8. old entries and approved weeks are left for the office ----------
INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in) VALUES
  ('e8-ancient', :co::uuid, 'e8-gus', '2026-11-01', '07:00'),
  ('e8-recent', :co::uuid, 'e8-hank', '2026-11-23', '07:00');
INSERT INTO public.timesheet_week_approvals (company_id, week_start) VALUES (:co::uuid, '2026-11-16');
SELECT pg_temp.at('2026-11-23 07:10:00-07');
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$INSERT INTO public.timesheets (id, company_id, crew_id, date, clock_in)
  VALUES ('e8-mon', 'eeeeeeee-0000-4000-8000-00000000e801', 'e8-gus', '2026-11-23', '07:05')$$,
  'crew clock in on Monday');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-ancient'), NULL,
  'an open entry from weeks ago is not closed by a clock-in');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-r2'), NULL,
  'nor one in an approved week');
SELECT pg_temp.at('2026-11-23 20:17:00-07');
SELECT is(public.close_open_clocks_at_8pm(:co::uuid), 2, 'the hourly close takes only recent days of weeks not approved');
SELECT is((SELECT clock_out || ' ' || auto_closed FROM public.timesheets WHERE id = 'e8-recent'), '20:00 true',
  'today''s open entry is closed at 8 PM');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'e8-ancient'), NULL,
  'the old open entry is still left for the office');

-- ---------- 9. two requests at the same time ----------
SELECT ok(pg_get_functiondef('public.limit_crew_clock_times()'::regprocedure) ~ 'pg_advisory_xact_lock',
  'crew clock checks take a lock per person, so two requests sent together are checked one after the other');

SELECT * FROM finish();
ROLLBACK;
