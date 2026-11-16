-- The "climber price change notes" rules: a Climber
-- sees the prices (not the costs or office notes) of the jobs he can
-- see; he changes a price only through change_job_price, with a reason,
-- on a job he is on; each change is logged in job_price_changes and the
-- change history; the office reads the changes and marks them seen;
-- nobody writes the table directly; companies stay apart.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(46);

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

\set co   '''abababab-0000-4000-8000-0000000a0001'''
\set co2  '''abababab-0000-4000-8000-0000000a0002'''
\set cal  '''abababab-1111-4000-8000-0000000a0001'''
\set sid  '''abababab-1111-4000-8000-0000000a0002'''
\set gus  '''abababab-1111-4000-8000-0000000a0003'''
\set desk '''abababab-1111-4000-8000-0000000a0004'''
\set bea  '''abababab-1111-4000-8000-0000000a0005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Note Co'), (:co2::uuid, 'Other Co');
SELECT pg_temp.signup(:cal::uuid, 'cal-note@example.com');
SELECT pg_temp.signup(:sid::uuid, 'sid-note@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-note@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-note@example.com');
SELECT pg_temp.signup(:bea::uuid, 'bea-note@example.com');
DELETE FROM public.company_members WHERE user_id IN (:cal::uuid, :sid::uuid, :gus::uuid, :desk::uuid, :bea::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:cal::uuid, :co::uuid, 'crew'), (:sid::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'),
  (:desk::uuid, :co::uuid, 'office'), (:bea::uuid, :co2::uuid, 'office');
-- Cal: Climber on q-j1, no "see money". Sid: Climber working the same
-- day on q-j2 (sees q-j1 as crew, is not on it). Gus: groundsman on
-- q-j1. Desk: the office. Bea: the office of another company.
UPDATE public.crew SET id = 'q-cal', name = 'Cal Climb', company_id = :co::uuid, status = 'active', role = 'Climber',
  permissions = '{}'::jsonb WHERE auth_user_id = :cal::uuid;
UPDATE public.crew SET id = 'q-sid', name = 'Sid Climb', company_id = :co::uuid, status = 'active', role = 'Climber',
  permissions = '{}'::jsonb WHERE auth_user_id = :sid::uuid;
UPDATE public.crew SET id = 'q-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{}'::jsonb WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'q-desk', name = 'Dee Desk', company_id = :co::uuid, status = 'active', role = 'Office'
  WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'q-bea', name = 'Bea Other', company_id = :co2::uuid, status = 'active', role = 'Office'
  WHERE auth_user_id = :bea::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('q-c1', :co::uuid, 'Ann', 'A'), ('q-c2', :co::uuid, 'Ben', 'B'), ('q-cx', :co2::uuid, 'Xia', 'X');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids,
                         value, hourly_rate, billing_type, labor_rate, materials_cost, other_cost, office_notes) VALUES
  ('q-j1', :co::uuid, 'q-c1', 'Removal', 'Big oak', '2026-12-14', 'scheduled', ARRAY['q-cal', 'q-gus'],
   900, 90, 'flat', 30, 50, 10, 'He haggles'),
  ('q-j2', :co::uuid, 'q-c2', 'Trimming', 'Elm trim', '2026-12-14', 'scheduled', ARRAY['q-sid'],
   400, NULL, 'flat', NULL, NULL, NULL, ''),
  ('q-jx', :co2::uuid, 'q-cx', 'Trimming', 'Elsewhere', '2026-12-14', 'scheduled', ARRAY['q-bea'],
   700, NULL, 'flat', NULL, NULL, NULL, 'Other office');

-- ---------- 1-7: reading the price ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT results_eq(
  $$SELECT value, hourly_rate, billing_type FROM public.app_jobs('abababab-0000-4000-8000-0000000a0001') WHERE id = 'q-j1'$$,
  $$VALUES (900::numeric, 90::numeric, 'flat'::text)$$,
  'a Climber without see money reads his job''s value, hourly rate and billing');
SELECT results_eq(
  $$SELECT labor_rate, materials_cost, other_cost, office_notes FROM public.app_jobs('abababab-0000-4000-8000-0000000a0001') WHERE id = 'q-j1'$$,
  $$VALUES (NULL::numeric, NULL::numeric, NULL::numeric, NULL::text)$$,
  'but not its costs or office notes');
SELECT ok(NOT public.job_money_visible(:co::uuid, ARRAY['q-cal'], '2026-12-14', NULL, NULL),
  'he still does not "see money" (estimates, invoices, costs)');
SELECT is((SELECT count(*)::int FROM public.estimates) + (SELECT count(*)::int FROM public.invoices), 0,
  'and reads no estimates or invoices');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:sid::uuid);
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'q-j1'), 900::numeric,
  'a Climber who sees the job as crew (same work day) reads its price');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.app_jobs(:co::uuid)
            WHERE coalesce(value, hourly_rate, labor_rate, materials_cost, other_cost) IS NOT NULL), 0,
  'a groundsman without see money still reads no dollar amounts');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:bea::uuid);
SELECT is((SELECT count(*)::int FROM public.app_jobs(:co::uuid)), 0,
  'another company''s office reads none of these jobs');
SELECT pg_temp.as_db();

-- ---------- 8-12: no direct price change by a Climber ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$UPDATE public.jobs SET value = 950 WHERE id = 'q-j1'$$, '42501',
  'A price change needs a reason: use "Change the price" on the job.',
  'a Climber cannot change the job value straight in the table');
SELECT throws_ok($$UPDATE public.jobs SET hourly_rate = 95 WHERE id = 'q-j1'$$, '42501', NULL,
  'nor the hourly rate');
SELECT throws_ok($$UPDATE public.jobs SET billing_type = 'hourly' WHERE id = 'q-j1'$$, '42501', NULL,
  'nor the billing');
SELECT lives_ok($$UPDATE public.jobs SET title = 'Big oak, stump too', value = 900, hourly_rate = 90 WHERE id = 'q-j1'$$,
  'a save that sends the prices unchanged still works (the app sends whole rows)');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'q-cal';
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$UPDATE public.jobs SET value = 950 WHERE id = 'q-j1'$$, '42501', NULL,
  'with see money too, the price needs a reason');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = 'q-cal';

-- ---------- 13-26: change_job_price by the Climber on the job ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 950, 90, 'flat', NULL)$$, '22023',
  'Say why the price changed (at least 3 characters).', 'without a reason it is refused');
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 950, 90, 'flat', '  ok  ')$$, '22023', NULL,
  'a reason shorter than 3 characters is refused');
SELECT throws_ok(format($$SELECT public.change_job_price('q-j1', 950, 90, 'flat', %L)$$, repeat('x', 1001)), '22023', NULL,
  'a reason longer than 1000 characters is refused');
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 900, 90, 'flat', 'No change at all')$$, '22023', NULL,
  'a "change" to the same price is refused');
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 950, 90, 'weekly', 'Odd billing')$$, '22023', NULL,
  'billing other than flat or hourly is refused');
SELECT lives_ok($$SELECT public.change_job_price('q-j1', 1100, 90, 'flat', 'Second stump found on site')$$,
  'with a reason a Climber on the job changes the price');
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'q-j1'), 1100::numeric,
  'and sees the new price');
SELECT results_eq(
  $$SELECT changed_by, changed_by_name, by_office, old_value, new_value, old_billing_type, new_billing_type, reason, seen_at
      FROM public.job_price_changes$$,
  $$VALUES ('q-cal'::text, 'Cal Climb'::text, false, 900::numeric, 1100::numeric, 'flat'::text, 'flat'::text,
            'Second stump found on site'::text, NULL::timestamptz)$$,
  'he reads the logged change: who (set by the database), old and new, the reason, not seen yet');
SELECT throws_ok(format($$INSERT INTO public.job_price_changes (company_id, job_id, reason) VALUES (%L, 'q-j1', 'fake')$$, :co),
  '42501', NULL, 'he cannot add a price change row directly');
SELECT throws_ok($$UPDATE public.job_price_changes SET reason = 'edited'$$, '42501', NULL,
  'nor change one');
SELECT throws_ok($$DELETE FROM public.job_price_changes$$, '42501', NULL,
  'nor delete one');
SELECT throws_ok($$SELECT public.mark_job_price_change_seen((SELECT id FROM public.job_price_changes LIMIT 1))$$, '42501', NULL,
  'nor mark it seen (the office does)');
SELECT throws_ok($$SELECT public.change_job_price('q-jx', 1, NULL, 'flat', 'Not my company')$$, '42501', NULL,
  'he cannot change the price of another company''s job');
SELECT pg_temp.as_db();
SELECT results_eq(
  $$SELECT actor, field, old_value, new_value, job_id FROM public.audit_log WHERE job_id = 'q-j1' AND entity = 'Job' ORDER BY field$$,
  $$VALUES ('Cal Climb'::text, 'value'::text, '900'::text, '1100'::text, 'q-j1'::text)$$,
  'the change history has the price change, by him, like any job edit');

-- ---------- 27-30: groundsman and a Climber not on the job ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 1200, 90, 'flat', 'I think it is more')$$, '42501', NULL,
  'a groundsman on the job cannot call change_job_price');
SELECT is((SELECT count(*)::int FROM public.job_price_changes), 0, 'nor read the price changes');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:sid::uuid);
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 1200, 90, 'flat', 'Saw it, looks bigger')$$, '42501',
  'Only a Climber on this job or the office can change its price.',
  'a Climber not on the job cannot change its price (seeing it is not enough)');
SELECT is((SELECT count(*)::int FROM public.job_price_changes), 0, 'nor read its price changes');
SELECT pg_temp.as_db();

-- ---------- 31-40: the office ----------
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.job_price_changes WHERE seen_at IS NULL), 1,
  'the office reads the unseen crew change');
SELECT lives_ok($$SELECT public.mark_job_price_change_seen((SELECT id FROM public.job_price_changes LIMIT 1))$$,
  'and marks it seen');
SELECT results_eq($$SELECT seen_by, seen_at IS NOT NULL FROM public.job_price_changes$$,
  $$VALUES ('Dee Desk'::text, true)$$, 'seen by whom and when');
SELECT lives_ok($$SELECT public.mark_job_price_change_seen((SELECT id FROM public.job_price_changes LIMIT 1))$$,
  'marking it seen again changes nothing');
SELECT lives_ok($$SELECT public.change_job_price('q-j1', NULL, 100, 'hourly', NULL)$$,
  'the office changes a price through the function without a reason');
SELECT results_eq(
  $$SELECT by_office, seen_at IS NOT NULL, new_billing_type FROM public.job_price_changes WHERE changed_by = 'q-desk'$$,
  $$VALUES (true, true, 'hourly'::text)$$,
  'its own change is logged as the office''s and already seen');
SELECT lives_ok($$UPDATE public.jobs SET value = 1500, billing_type = 'flat' WHERE id = 'q-j1'$$,
  'the office still changes prices straight in the job editor');
SELECT throws_ok($$UPDATE public.job_price_changes SET seen_at = NULL$$, '42501', NULL,
  'the office does not write the table directly either');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE job_id = 'q-j1' AND entity = 'Job' AND actor = 'Dee Desk'), 3,
  'the office''s function change wrote value, billing and hourly rate to the history');
SELECT pg_temp.act_as(:cal::uuid);
SELECT is((SELECT count(*)::int FROM public.job_price_changes), 2,
  'the Climber on the job reads every price change of it, the office''s too');
SELECT pg_temp.as_db();

-- ---------- 41-46: another company ----------
SELECT id AS cal_change FROM public.job_price_changes WHERE changed_by = 'q-cal' \gset
SELECT pg_temp.act_as(:bea::uuid);
SELECT is((SELECT count(*)::int FROM public.job_price_changes), 0,
  'another company''s office reads none of these price changes');
SELECT throws_ok($$SELECT public.change_job_price('q-j1', 1, NULL, 'flat', 'Not ours')$$, '42501', NULL,
  'nor changes this company''s job price');
SELECT throws_ok(format($$SELECT public.mark_job_price_change_seen(%L)$$, :'cal_change'),
  '42501', NULL, 'nor marks its changes seen');
SELECT lives_ok($$SELECT public.change_job_price('q-jx', 750, NULL, 'flat', NULL)$$,
  'it changes its own job''s price');
SELECT is((SELECT count(*)::int FROM public.job_price_changes), 1, 'and reads only its own change');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.job_price_changes), 2, 'the first office still reads only its own two');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
