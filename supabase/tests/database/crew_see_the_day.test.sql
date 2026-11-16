-- The "crew see the whole work day" rules: on a day a
-- crew member works they see every job of that day; they still change
-- only the jobs they are assigned to.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(16);

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

\set co '''11111111-1111-4111-8111-111111111111'''
\set amy  '''bbbbbbbb-0000-4000-8000-000000000001'''
\set bo   '''bbbbbbbb-0000-4000-8000-000000000002'''
\set cy   '''bbbbbbbb-0000-4000-8000-000000000003'''
\set dee  '''bbbbbbbb-0000-4000-8000-000000000004'''

SELECT pg_temp.signup(:amy::uuid, 'amy-day@example.com');
SELECT pg_temp.signup(:bo::uuid, 'bo-day@example.com');
SELECT pg_temp.signup(:cy::uuid, 'cy-day@example.com');
SELECT pg_temp.signup(:dee::uuid, 'dee-day@example.com');
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:amy::uuid, :co::uuid, 'crew'), (:bo::uuid, :co::uuid, 'crew'),
  (:cy::uuid, :co::uuid, 'crew'), (:dee::uuid, :co::uuid, 'crew');
-- Signing up creates each login's roster card; give them readable ids.
UPDATE public.crew SET id = 'amy', status = 'active', role = 'Climber' WHERE auth_user_id = :amy::uuid;
UPDATE public.crew SET id = 'bo', status = 'active', role = 'Groundsman' WHERE auth_user_id = :bo::uuid;
UPDATE public.crew SET id = 'cy', status = 'active', role = 'Climber' WHERE auth_user_id = :cy::uuid;
UPDATE public.crew SET id = 'dee', status = 'active', role = 'Groundsman' WHERE auth_user_id = :dee::uuid;
INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('ca', :co::uuid, 'Ann', 'A'), ('cb', :co::uuid, 'Ben', 'B'), ('cc', :co::uuid, 'Cal', 'C');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids) VALUES
  ('mon-amy', :co::uuid, 'ca', 'Removal', 'Amy Monday', '2026-12-07', 'scheduled', ARRAY['amy']),
  ('mon-bo',  :co::uuid, 'cb', 'Removal', 'Bo Monday',  '2026-12-07', 'scheduled', ARRAY['bo']),
  ('tue-bo',  :co::uuid, 'cc', 'Trimming', 'Bo Tuesday', '2026-12-08', 'scheduled', ARRAY['bo']);
-- Dee is on Tuesday's day crew but on no job.
INSERT INTO public.day_crews (id, company_id, date, name, member_ids) VALUES
  ('dc-tue', :co::uuid, '2026-12-08', 'Crew 1', ARRAY['dee']);

-- Amy works Monday: she sees both Monday jobs, but not Tuesday.
SELECT pg_temp.act_as(:amy::uuid);
SELECT set_eq($$SELECT id FROM public.jobs$$, ARRAY['mon-amy', 'mon-bo'], 'Amy sees every job on Monday, the day she works');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = 'tue-bo'), 'Amy does not see Tuesday (she is not working)');
SELECT is((SELECT count(*)::int FROM public.customers WHERE id IN ('ca', 'cb')), 2, 'Amy sees the customers of both Monday jobs');
SELECT is((SELECT count(*)::int FROM public.customers WHERE id = 'cc'), 0, 'but not the Tuesday customer');
-- She can change her own job, not Bo's.
SELECT isnt_empty($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'mon-amy' RETURNING 1$$, 'Amy can update her own job');
SELECT is_empty($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'mon-bo' RETURNING 1$$, 'Amy cannot change Bo''s job, though she can see it');
SELECT ok(public.job_row_visible(:co::uuid, ARRAY['bo'], '2026-12-07'), 'visible: same work day');
SELECT ok(NOT public.job_row_assigned(:co::uuid, ARRAY['bo'], '2026-12-07'), 'not assigned: someone else''s job');
SELECT pg_temp.as_db();

-- Cy has no job anywhere: sees nothing.
SELECT pg_temp.act_as(:cy::uuid);
SELECT is((SELECT count(*)::int FROM public.jobs), 0, 'Cy works no day and sees no jobs');
SELECT pg_temp.as_db();

-- Dee is on Tuesday's day crew only: sees Tuesday's job.
SELECT pg_temp.act_as(:dee::uuid);
SELECT set_eq($$SELECT id FROM public.jobs$$, ARRAY['tue-bo'], 'Dee (on Tuesday''s crew) sees Tuesday''s jobs');
SELECT is_empty($$UPDATE public.jobs SET status = 'done' WHERE id = 'tue-bo' RETURNING 1$$, 'and cannot change a job she is not on');
SELECT pg_temp.as_db();

-- Prices stay hidden: crew without see-money read no invoices.
SELECT pg_temp.act_as(:amy::uuid);
SELECT is((SELECT count(*)::int FROM public.invoices), 0, 'Amy still sees no invoices (prices stay behind see-money)');
SELECT pg_temp.as_db();

-- Two-step login still applies: a password-only session of a login with it on sees nothing.
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
VALUES (gen_random_uuid(), :amy::uuid, 'app', 'totp', 'verified', now(), now());
SELECT pg_temp.act_as(:amy::uuid, 'aal1');
SELECT is((SELECT count(*)::int FROM public.jobs), 0, 'password-only session with two-step on sees no jobs');
SELECT pg_temp.as_db();

-- Removed from the team: sees nothing.
DELETE FROM public.company_members WHERE user_id = :bo::uuid;
SELECT pg_temp.act_as(:bo::uuid);
SELECT is((SELECT count(*)::int FROM public.jobs), 0, 'a removed person sees no jobs');
SELECT pg_temp.as_db();

SELECT policies_are('public', 'jobs',
  ARRAY['read jobs', 'staff insert jobs', 'update assigned jobs', 'staff delete jobs'],
  'jobs policies: read (whole work day), update (assigned only)');
SELECT has_index('public', 'jobs', 'idx_jobs_company_date', 'jobs have a (company, date) index for the work-day check');

SELECT * FROM finish();
ROLLBACK;
