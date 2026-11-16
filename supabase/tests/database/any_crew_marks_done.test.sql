-- The "any crew marks done" rules: anyone on the job
-- (groundsmen included) marks it done or takes Done off it; crew not on
-- the job cannot; groundsmen still change nothing but the status.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(10);

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

\set co  '''dddddddd-0000-4000-8000-0000000d0001'''
\set gus '''dddddddd-1111-4000-8000-0000000d0001'''
\set otto '''dddddddd-1111-4000-8000-0000000d0002'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Done Co');
SELECT pg_temp.signup(:gus::uuid, 'gus-done@example.com');
SELECT pg_temp.signup(:otto::uuid, 'otto-done@example.com');
DELETE FROM public.company_members WHERE user_id IN (:gus::uuid, :otto::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:gus::uuid, :co::uuid, 'crew'), (:otto::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'd-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'd-otto', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :otto::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES ('d-c1', :co::uuid, 'Ann', 'A');
-- Gus works both jobs that day; Otto is on the stump job only, so he
-- can see the maple (same work day) but is not on it.
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids) VALUES
  ('d-maple', :co::uuid, 'd-c1', 'Removal', 'Silver maple', '2026-12-15', 'in_progress', ARRAY['d-gus']),
  ('d-stump', :co::uuid, 'd-c1', 'Stump Grinding', 'Stumps', '2026-12-15', 'scheduled', ARRAY['d-gus', 'd-otto']);

SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'd-maple'$$,
  'a Groundsman on the job marks it done');
SELECT pg_temp.as_db();
SELECT is((SELECT status FROM public.jobs WHERE id = 'd-maple'), 'done', 'the Done saved');

SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'd-maple'$$,
  'and can undo it');
SELECT pg_temp.as_db();
SELECT is((SELECT status FROM public.jobs WHERE id = 'd-maple'), 'in_progress', 'the undo saved');

SELECT pg_temp.act_as(:otto::uuid);
SELECT is((SELECT count(*)::int FROM public.jobs WHERE id = 'd-maple'), 1,
  'Otto can see the maple job (same work day)');
SELECT is_empty($$UPDATE public.jobs SET status = 'done' WHERE id = 'd-maple' RETURNING 1$$,
  'crew not on the job cannot mark it done');
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'd-stump'$$,
  'a Groundsman marks his own job done straight from scheduled');
SELECT throws_ok($$UPDATE public.jobs SET title = 'Renamed' WHERE id = 'd-stump'$$, '42501',
  'Crew can only change the status of a job.', 'groundsmen still change nothing but the status');
SELECT throws_ok($$UPDATE public.jobs SET status = 'in_progress', date = '2026-12-16' WHERE id = 'd-stump'$$, '42501',
  NULL, 'not even together with a status change');
SELECT pg_temp.as_db();
SELECT is((SELECT status FROM public.jobs WHERE id = 'd-maple'), 'in_progress', 'the maple is unchanged by Otto');

SELECT * FROM finish();
ROLLBACK;
