-- The "crew phone rules" rules (Done rule updated by
-- the "any crew marks done" rules: anyone on the job marks it
-- done); one open clock per person per day; Climbers
-- (and nobody else on the crew) read the accepted option's prices.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(26);

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

\set co    '''cccccccc-0000-4000-8000-0000000c0001'''
\set other '''cccccccc-0000-4000-8000-0000000c0002'''
\set cal   '''cccccccc-1111-4000-8000-0000000c0001'''
\set gus   '''cccccccc-1111-4000-8000-0000000c0002'''
\set desk  '''cccccccc-1111-4000-8000-0000000c0003'''
\set sam   '''cccccccc-1111-4000-8000-0000000c0004'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Phone Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:cal::uuid, 'cal-phone@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-phone@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-phone@example.com');
SELECT pg_temp.signup(:sam::uuid, 'sam-phone@example.com');
DELETE FROM public.company_members WHERE user_id IN (:cal::uuid, :gus::uuid, :desk::uuid, :sam::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:cal::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'),
  (:desk::uuid, :co::uuid, 'office'), (:sam::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'p-cal', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :cal::uuid;
UPDATE public.crew SET id = 'p-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'p-desk', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :desk::uuid;
-- These tests type clock times on a fixed day: since migration
-- the "manager pay and live clock-in" rules crew may only do that with "May enter hours by hand".
UPDATE public.crew SET permissions = '{"canManualClockIn": true}'::jsonb WHERE id IN ('p-cal', 'p-gus');
-- Sam is a Climber who works another day: he sees none of these jobs.
UPDATE public.crew SET id = 'p-sam', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :sam::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('p-c1', :co::uuid, 'Ann', 'A'), ('p-c2', :co::uuid, 'Ben', 'B');
INSERT INTO public.estimates (id, company_id, customer_id, job_id, title, lines, options, accepted_option_id, status, created_date) VALUES
  ('p-e1', :co::uuid, 'p-c1', NULL, 'Oak', '[{"id":"l0","description":"Base","quantity":1,"unitPrice":100}]',
   '[{"id":"good","label":"Good","lines":[{"id":"g1","description":"Prune","quantity":1,"unitPrice":800}]},
     {"id":"best","label":"Best","lines":[{"id":"b1","description":"Remove oak","quantity":1,"unitPrice":1500},
                                         {"id":"b2","description":"Grind stump","quantity":2,"unitPrice":125.5}]}]',
   'best', 'accepted', '2026-11-01'),
  -- Linked by the estimate's job_id only, no options: its own lines.
  ('p-e2', :co::uuid, 'p-c2', 'p-j2', 'Elm', '[{"id":"l1","description":"Trim elm","quantity":1,"unitPrice":400}]',
   NULL, NULL, 'accepted', '2026-11-01'),
  -- Not accepted: never shown.
  ('p-e3', :co::uuid, 'p-c2', 'p-j3', 'Draft', '[{"id":"l1","description":"Maybe","quantity":1,"unitPrice":50}]',
   NULL, NULL, 'sent', '2026-11-01');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id) VALUES
  ('p-j1', :co::uuid, 'p-c1', 'Removal', 'Big oak', '2026-12-14', 'scheduled', ARRAY['p-cal', 'p-gus'], 'p-e1'),
  ('p-j2', :co::uuid, 'p-c2', 'Trimming', 'Elm trim', '2026-12-14', 'scheduled', ARRAY['p-gus'], NULL),
  ('p-j3', :co::uuid, 'p-c2', 'Trimming', 'Draft job', '2026-12-14', 'scheduled', ARRAY['p-gus'], NULL),
  ('p-j4', :co::uuid, 'p-c1', 'Removal', 'Done one', '2026-12-14', 'done', ARRAY['p-gus'], NULL);

-- 1-6: Done
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'p-j2'$$, 'a Groundsman can tap Arrived');
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'p-j2'$$,
  'a Groundsman on the job can mark it done (business rule)');
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'p-j3'$$,
  'also straight from scheduled');
SELECT lives_ok($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'p-j4'$$,
  'and can take Done off a job he is on (Undo)');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'p-j1'$$, 'a Climber can mark his job done');
SELECT lives_ok($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'p-j1'$$, 'and undo it (Mark not done)');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'p-j2'$$, 'the office can mark any job done');
SELECT pg_temp.as_db();
SELECT is((SELECT status FROM public.jobs WHERE id = 'p-j2'), 'done', 'the office''s Done saved');
SELECT is((SELECT status FROM public.jobs WHERE id = 'p-j4'), 'in_progress', 'the Groundsman''s undo saved');

-- 10-16: one open clock per person per day
-- The test clock: the 8 PM close only closes entries of the last 3 days.
SELECT set_config('app.clock_now_for_tests', '2026-12-14 10:00:00-07', true);
SELECT pg_temp.act_as(:gus::uuid);
INSERT INTO public.timesheets (id, company_id, crew_id, job_id, date, clock_in) VALUES
  ('p-t1', :co::uuid, 'p-gus', 'p-j1', '2026-12-14', '07:00');
INSERT INTO public.timesheets (id, company_id, crew_id, job_id, date, clock_in, clock_out) VALUES
  ('p-old', :co::uuid, 'p-gus', NULL, '2026-12-13', '15:00', NULL);
INSERT INTO public.timesheets (id, company_id, crew_id, job_id, date, clock_in) VALUES
  ('p-t2', :co::uuid, 'p-gus', 'p-j2', '2026-12-14', '09:30');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'p-t1'), '09:30',
  'clocking in to the next job closes the open one at the new clock-in time');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'p-t2'), NULL, 'the new entry stays open');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'p-old'), '20:00',
  'an open entry from an earlier day is closed at 8 PM of its day (the "crew day and 8pm clockout" rules)');
SELECT is((SELECT count(*)::int FROM public.timesheets WHERE crew_id = 'p-gus' AND date = '2026-12-14' AND clock_out IS NULL), 1,
  'one open entry for the person that day');
-- The app then writes the same close itself: no conflict.
SELECT lives_ok($$UPDATE public.timesheets SET clock_out = '09:30' WHERE id = 'p-t1'$$, 'the app''s own close still saves');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:cal::uuid);
INSERT INTO public.timesheets (id, company_id, crew_id, job_id, date, clock_in) VALUES
  ('p-t3', :co::uuid, 'p-cal', 'p-j1', '2026-12-14', '10:00');
SELECT pg_temp.as_db();
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'p-t2'), NULL, 'someone else clocking in leaves my clock open');
-- A finished entry typed by hand does not close anything.
INSERT INTO public.timesheets (id, company_id, crew_id, job_id, date, clock_in, clock_out) VALUES
  ('p-t4', :co::uuid, 'p-gus', NULL, '2026-12-14', '12:00', '12:30');
SELECT is((SELECT clock_out FROM public.timesheets WHERE id = 'p-t2'), NULL, 'a closed entry added by hand closes nothing');

-- 17-26: prices for Climbers only
SELECT pg_temp.act_as(:cal::uuid);
SELECT set_eq($$SELECT job_id, line_id, description, price FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001')$$,
  $$VALUES ('p-j1', 'b1', 'Remove oak', 1500.00::numeric), ('p-j1', 'b2', 'Grind stump', 251.00::numeric),
           ('p-j2', 'l1', 'Trim elm', 400.00::numeric)$$,
  'a Climber sees the accepted option''s lines (description + price) of the jobs he can see');
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001') WHERE job_id = 'p-j3'), 0,
  'an estimate not accepted shows no prices');
SELECT is((SELECT count(*)::int FROM public.estimates), 0, 'the Climber still cannot read estimates themselves');
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0002')), 0,
  'nothing from another company');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001')), 0,
  'a Groundsman sees no prices');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:sam::uuid);
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001')), 0,
  'a Climber sees no prices for jobs he cannot see');
SELECT pg_temp.as_db();
-- Two-step login still applies.
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
VALUES (gen_random_uuid(), :cal::uuid, 'app', 'totp', 'verified', now(), now());
SELECT pg_temp.act_as(:cal::uuid, 'aal1');
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001')), 0,
  'a password-only session with two-step on sees no prices');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:cal::uuid, 'aal2');
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001')), 3,
  'with the code entered he does');
SELECT pg_temp.as_db();
-- Removed from the team: nothing.
DELETE FROM public.company_members WHERE user_id = :cal::uuid;
SELECT pg_temp.act_as(:cal::uuid, 'aal2');
SELECT is((SELECT count(*)::int FROM public.crew_job_prices('cccccccc-0000-4000-8000-0000000c0001')), 0,
  'a removed Climber sees no prices');
SELECT pg_temp.as_db();
SELECT is(has_function_privilege('anon', 'public.crew_job_prices(uuid)', 'EXECUTE'), false, 'signed-out visitors cannot call it');

SELECT * FROM finish();
ROLLBACK;
