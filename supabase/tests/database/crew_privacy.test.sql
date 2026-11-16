-- The "crew privacy notes prices and dates" rules:
-- the app loads jobs through app_jobs: crew never get office notes; job
-- prices and the change history follow the "see money" switch; a
-- Climber changes a job's costs only with "see money" (since
-- the "climbers change prices" rules he changes its prices without it, and since
-- the "climber price change notes" rules he sees them and changes them only with a reason,
-- through change_job_price: tested in climbers_change_prices and
-- climber_price_change_notes);
-- Climbers cannot move a job to another day or swap its customer,
-- address or estimate. The office keeps doing everything.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(48);

CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, now(), '{}'::jsonb);
$$;
CREATE FUNCTION pg_temp.act_as(p_id uuid, p_aal text DEFAULT 'aal1')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated', 'aal', p_aal)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE FUNCTION pg_temp.as_db()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

\set co   '''dddddddd-0000-4000-8000-0000000d0001'''
\set cal  '''dddddddd-1111-4000-8000-0000000d0001'''
\set gus  '''dddddddd-1111-4000-8000-0000000d0002'''
\set mo   '''dddddddd-1111-4000-8000-0000000d0003'''
\set desk '''dddddddd-1111-4000-8000-0000000d0004'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Privacy Co');
SELECT pg_temp.signup(:cal::uuid, 'cal-priv@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-priv@example.com');
SELECT pg_temp.signup(:mo::uuid, 'mo-priv@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-priv@example.com');
DELETE FROM public.company_members WHERE user_id IN (:cal::uuid, :gus::uuid, :mo::uuid, :desk::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:cal::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'),
  (:mo::uuid, :co::uuid, 'crew'), (:desk::uuid, :co::uuid, 'office');
UPDATE public.crew SET id = 'v-cal', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :cal::uuid;
UPDATE public.crew SET id = 'v-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
-- Mo is a groundsman with the "see money" switch on.
UPDATE public.crew SET id = 'v-mo', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{"seeMoney": true}'::jsonb WHERE auth_user_id = :mo::uuid;
UPDATE public.crew SET id = 'v-desk', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :desk::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('v-c1', :co::uuid, 'Ann', 'A'), ('v-c2', :co::uuid, 'Ben', 'B'), ('v-c3', :co::uuid, 'Cat', 'C');
INSERT INTO public.customer_addresses (id, company_id, customer_id, label, street) VALUES
  ('v-a1', :co::uuid, 'v-c1', 'Home', '1 Oak St'), ('v-a2', :co::uuid, 'v-c1', 'Rental', '2 Elm St');
INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date) VALUES
  ('v-e1', :co::uuid, 'v-c1', 'Oak', 'accepted', '2026-11-01'),
  ('v-e3', :co::uuid, 'v-c3', 'Far', 'accepted', '2026-11-01');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids,
                         value, hourly_rate, labor_rate, materials_cost, other_cost, office_notes, estimate_id, address_id) VALUES
  ('v-j1', :co::uuid, 'v-c1', 'Removal', 'Big oak', '2026-12-14', 'scheduled', ARRAY['v-cal'],
   900, NULL, 30, 50, 10, 'Price is soft, he haggles', 'v-e1', 'v-a1'),
  ('v-j2', :co::uuid, 'v-c2', 'Trimming', 'Elm trim', '2026-12-14', 'scheduled', ARRAY['v-gus', 'v-mo'],
   400, 80, NULL, NULL, NULL, 'Owes us from last year', NULL, NULL),
  -- Another day nobody here works.
  ('v-j3', :co::uuid, 'v-c3', 'Trimming', 'Far away', '2026-12-20', 'scheduled', ARRAY['v-x'],
   5000, NULL, NULL, NULL, NULL, 'VIP', 'v-e3', NULL);
INSERT INTO public.timesheets (id, company_id, crew_id, job_id, date) VALUES
  ('v-ts-gus', :co::uuid, 'v-gus', 'v-j2', '2026-12-14'),
  ('v-ts-mo', :co::uuid, 'v-mo', 'v-j2', '2026-12-14');
INSERT INTO public.audit_log (id, company_id, timestamp, entity, entity_id, field, old_value, new_value, job_id) VALUES
  ('v-a-title', :co::uuid, '2026-11-01', 'Job', 'v-j1', 'title', 'Oak', 'Big oak', 'v-j1'),
  ('v-a-value', :co::uuid, '2026-11-01', 'Job', 'v-j1', 'value', '800', '900', 'v-j1'),
  ('v-a-rate', :co::uuid, '2026-11-01', 'Job', 'v-j2', 'hourlyRate', '70', '80', 'v-j2'),
  ('v-a-office', :co::uuid, '2026-11-01', 'Job', 'v-j2', 'officeNotes', '', 'Owes us', 'v-j2'),
  ('v-a-est', :co::uuid, '2026-11-01', 'Estimate', 'v-e1', '(line added)', '', 'Remove oak × 1 @ 2400', 'v-j1'),
  ('v-a-inv', :co::uuid, '2026-11-01', 'Invoice', 'v-i2', 'discountValue', '0', '50', 'v-j2'),
  ('v-a-ts-gus', :co::uuid, '2026-11-01', 'Timesheet', 'v-ts-gus', 'clockIn', '', '08:00', 'v-j2'),
  ('v-a-ts-mo', :co::uuid, '2026-11-01', 'Timesheet', 'v-ts-mo', 'clockIn', '', '07:00', 'v-j2'),
  ('v-a-msg', :co::uuid, '2026-11-01', 'Message', 'v-m1', '(created)', '', 'On our way', 'v-j2'),
  ('v-a-far', :co::uuid, '2026-11-01', 'Job', 'v-j3', 'title', '', 'Far away', 'v-j3'),
  ('v-a-user', :co::uuid, '2026-11-01', 'User', 'v-gus', 'payAmount', '20', '25', NULL);

-- ---------- 1-2: the table itself ----------
-- Reading the private columns straight from the table is closed in a
-- later migration, once no phone runs a build that reads jobs with
-- select * (see the header of the "crew privacy notes prices and dates" rules).
SELECT ok(has_table_privilege('authenticated', 'public.jobs', 'SELECT'),
  'old builds still read jobs from the table until every phone has the new build');
SELECT ok(has_table_privilege('authenticated', 'public.jobs', 'UPDATE')
      AND has_table_privilege('authenticated', 'public.jobs', 'INSERT'),
  'the office can still write every column (RLS decides who)');

-- ---------- 3-9: groundsman without "see money" ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.jobs), 2, 'he still reads the day''s jobs');
SELECT set_eq($$SELECT id FROM public.app_jobs('dddddddd-0000-4000-8000-0000000d0001')$$,
  ARRAY['v-j1', 'v-j2'], 'app_jobs gives him the same jobs as before (his work day)');
SELECT is((SELECT count(*)::int FROM public.app_jobs(:co::uuid) WHERE office_notes IS NOT NULL), 0,
  'app_jobs: no office notes');
SELECT is((SELECT count(*)::int FROM public.app_jobs(:co::uuid)
            WHERE coalesce(value, hourly_rate, labor_rate, materials_cost, other_cost) IS NOT NULL), 0,
  'app_jobs: no dollar amounts');
SELECT is((SELECT title FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), 'Big oak',
  'app_jobs: everything else is there');
SELECT set_eq($$SELECT id FROM public.audit_log$$,
  ARRAY['v-a-title', 'v-a-ts-gus', 'v-a-msg'],
  'change history: job and message entries and his own time only (no prices, office notes, estimates, invoices or others'' hours)');
SELECT lives_ok($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'v-j2'$$,
  'he can still tap Arrived');
SELECT pg_temp.as_db();

-- ---------- 10-13: groundsman with "see money" ----------
SELECT pg_temp.act_as(:mo::uuid);
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j2'), 400::numeric,
  'with see money: the price of his job');
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), 900::numeric,
  'with see money: prices of the other jobs that day');
SELECT is((SELECT count(*)::int FROM public.app_jobs(:co::uuid) WHERE office_notes IS NOT NULL), 0,
  'with see money: still no office notes');
SELECT set_eq($$SELECT id FROM public.audit_log$$,
  ARRAY['v-a-title', 'v-a-value', 'v-a-rate', 'v-a-est', 'v-a-inv', 'v-a-ts-mo', 'v-a-msg'],
  'with see money: price, estimate and invoice history too, but never office notes or another person''s hours');
SELECT pg_temp.as_db();

-- ---------- 14-36: Climber (sees prices since the "climber price change notes" rules; costs only with "see money") ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), 900::numeric,
  'a Climber without see money gets the price of a job he is on (the "climber price change notes" rules)');
SELECT is((SELECT labor_rate FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), NULL,
  'but not its costs');
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j2'), 400::numeric,
  'and the price of another job that day he can see as crew');
SELECT is((SELECT office_notes FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), NULL,
  'and never the office notes, even on his own job');
SELECT set_eq($$SELECT id FROM public.audit_log$$,
  ARRAY['v-a-title', 'v-a-msg'],
  'Climber history: job and message entries, no price changes, estimates or invoices');
SELECT throws_ok($$UPDATE public.jobs SET labor_rate = 35 WHERE id = 'v-j1'$$, '42501',
  'Only people who can see money can change a job''s costs.',
  'a Climber without see money cannot change the labor rate');
SELECT throws_ok($$UPDATE public.jobs SET materials_cost = 60 WHERE id = 'v-j1'$$, '42501', NULL,
  'nor the materials cost');
SELECT throws_ok($$UPDATE public.jobs SET other_cost = 20 WHERE id = 'v-j1'$$, '42501', NULL,
  'nor other costs');
SELECT throws_ok($$UPDATE public.jobs SET date = '2026-12-20' WHERE id = 'v-j1'$$, '42501',
  'Only the office can change a job''s date, customer, address or estimate.',
  'a Climber cannot move his job to another day');
SELECT throws_ok($$UPDATE public.jobs SET end_date = '2026-12-20' WHERE id = 'v-j1'$$, '42501', NULL,
  'nor stretch it over more days');
SELECT throws_ok($$UPDATE public.jobs SET customer_id = 'v-c3' WHERE id = 'v-j1'$$, '42501', NULL,
  'nor give it to another customer');
SELECT throws_ok($$UPDATE public.jobs SET address_id = 'v-a2' WHERE id = 'v-j1'$$, '42501', NULL,
  'nor change its address');
SELECT throws_ok($$UPDATE public.jobs SET estimate_id = 'v-e3' WHERE id = 'v-j1'$$, '42501', NULL,
  'nor link another estimate');
SELECT throws_ok($$UPDATE public.jobs SET office_notes = 'x' WHERE id = 'v-j1'$$, '42501', NULL,
  'nor write office notes');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.app_jobs(:co::uuid) WHERE id = 'v-j3')
      AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = 'v-c3'),
  'so the other day''s job and customer stay out of reach');
SELECT lives_ok($$UPDATE public.jobs SET title = 'Big oak, two stumps', start_time = '09:00',
                  notes = 'bring the grinder' WHERE id = 'v-j1'$$,
  'a Climber still edits the work on his job');
SELECT is((SELECT title FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), 'Big oak, two stumps', 'and it saved');
-- With "see money" a Climber sets the price of his job.
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'v-cal';
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$UPDATE public.jobs SET value = 950, hourly_rate = 95, billing_type = 'hourly' WHERE id = 'v-j1'$$,
  '42501', NULL,
  'even with see money a Climber changes prices only with a reason (change_job_price, the "climber price change notes" rules)');
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j1'), 900::numeric, 'and sees the price unchanged');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = 'v-cal';
SELECT pg_temp.act_as(:cal::uuid);
SELECT is((SELECT count(*)::int FROM public.jobs WHERE id = 'v-j1' AND date = '2026-12-14' AND customer_id = 'v-c1'), 1,
  'the date and customer did not change');
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'v-j1'$$, 'a Climber can still mark it done');
SELECT is(pg_temp.as_db()::text, '', 'back to the database role');
-- Not on v-j2: the update reaches nothing (as before).
SELECT pg_temp.act_as(:cal::uuid);
UPDATE public.jobs SET value = 1 WHERE id = 'v-j2';
SELECT pg_temp.as_db();
SELECT is((SELECT value FROM public.jobs WHERE id = 'v-j2'), 400::numeric, 'a Climber cannot change another job''s price');

-- ---------- 37-48: the office keeps everything ----------
SELECT pg_temp.act_as(:desk::uuid);
SELECT set_eq($$SELECT id FROM public.app_jobs('dddddddd-0000-4000-8000-0000000d0001')$$,
  ARRAY['v-j1', 'v-j2', 'v-j3'], 'the office loads every job');
SELECT is((SELECT office_notes FROM public.app_jobs(:co::uuid) WHERE id = 'v-j3'), 'VIP',
  'with office notes');
SELECT is((SELECT value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j3'), 5000::numeric,
  'and prices');
SELECT is((SELECT count(*)::int FROM public.audit_log), 11, 'the office reads the whole change history');
SELECT lives_ok($$UPDATE public.jobs SET date = '2026-12-21', end_date = '2026-12-22', customer_id = 'v-c2',
                  estimate_id = NULL, address_id = NULL, office_notes = 'moved', value = 4800
                  WHERE id = 'v-j3'$$,
  'the office changes date, customer, estimate, notes and price');
SELECT is((SELECT office_notes || ' ' || value || ' ' || date FROM public.app_jobs(:co::uuid) WHERE id = 'v-j3'),
  'moved 4800 2026-12-21', 'and it saved');
-- An upsert that copies a hidden column from EXCLUDED needs SELECT on
-- it, so the app saves jobs with a plain insert, and an update when the
-- job already exists (src/data/supabaseAdapter.ts insertOrUpdateJobs).
SELECT throws_ok(format($$INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status)
                  VALUES ('v-j3', %L, 'v-c3', 'Trimming', 'Far away', '2026-12-20', 'scheduled')$$, :co),
  '23505', NULL, 'inserting a job that exists says "already there" (the app then updates it)');
SELECT lives_ok($$UPDATE public.jobs SET office_notes = 'upserted', value = 4700 WHERE id = 'v-j3'$$,
  'and the update of notes and price works');
SELECT lives_ok(format($$INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, office_notes, value)
                  VALUES ('v-j9', %L, 'v-c1', 'Trimming', 'New', '2026-12-23', 'scheduled', 'new note', 100)$$, :co),
  'the office creates a job with notes and price');
SELECT lives_ok($$WITH u AS (UPDATE public.jobs SET title = 'New job', value = 120 WHERE id = 'v-j9' RETURNING id) SELECT id FROM u$$,
  'an update that returns the id (what the app sends) works');
SELECT is((SELECT title || ' ' || value FROM public.app_jobs(:co::uuid) WHERE id = 'v-j9'), 'New job 120', 'and it saved');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.app_jobs('dddddddd-0000-4000-8000-0000000d0099')), 0,
  'app_jobs gives nothing for a company you are not in');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
