-- Optional two-step login (the "two step login" rules).
-- Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(21);

-- ---------- helpers ----------
CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, now(), '{}'::jsonb);
$$;
-- Sign in as a login, with the session's assurance level: 'aal1' is
-- password only, 'aal2' is password plus a two-step code.
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
CREATE FUNCTION pg_temp.factor(p_user uuid, p_status text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  VALUES (gen_random_uuid(), p_user, 'Authenticator app ' || p_status, 'totp',
          p_status::auth.factor_status, now(), now());
$$;

\set co '''11111111-1111-4111-8111-111111111111'''
\set owner   '''dddddddd-0000-4000-8000-000000000001'''
\set owner2  '''dddddddd-0000-4000-8000-000000000002'''
\set manager '''dddddddd-0000-4000-8000-000000000003'''
\set crew    '''dddddddd-0000-4000-8000-000000000004'''
\set crew2   '''dddddddd-0000-4000-8000-000000000005'''

-- ---------- seed (as the database owner) ----------
SELECT pg_temp.signup(:owner::uuid, 'owner@example.com');
SELECT pg_temp.signup(:owner2::uuid, 'owner2@example.com');
SELECT pg_temp.signup(:manager::uuid, 'manager@example.com');
SELECT pg_temp.signup(:crew::uuid, 'crew@example.com');
SELECT pg_temp.signup(:crew2::uuid, 'crew2@example.com');
UPDATE public.crew SET status = 'active' WHERE company_id = :co::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:owner2::uuid, :co::uuid, 'owner'),
  (:manager::uuid, :co::uuid, 'manager'),
  (:crew::uuid, :co::uuid, 'crew'),
  (:crew2::uuid, :co::uuid, 'crew');
INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('c1', :co::uuid, 'Mia', 'Mine');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids) VALUES
  ('j1', :co::uuid, 'c1', 'Removal', 'Oak', '2026-12-01', 'scheduled', ARRAY[:crew, :crew2]);

-- ---------- nobody has two-step login on: nothing changes ----------
SELECT pg_temp.act_as(:crew::uuid);
SELECT ok(public.mfa_satisfied(), 'without two-step login, a password session is enough');
SELECT is((SELECT count(*)::int FROM public.jobs), 1, 'crew without two-step login see their job');
SELECT pg_temp.as_db();

-- ---------- crew turns it on: a password-only session sees nothing ----------
SELECT pg_temp.factor(:crew::uuid, 'verified');
SELECT pg_temp.act_as(:crew::uuid, 'aal1');
SELECT ok(NOT public.mfa_satisfied(), 'with two-step login on, a password-only session is not enough');
SELECT ok(NOT public.is_company_member(:co::uuid), 'a password-only session is not a team member');
SELECT is((SELECT count(*)::int FROM public.jobs), 0, 'a password-only session sees no jobs');
SELECT is((SELECT count(*)::int FROM public.customers), 0, 'a password-only session sees no customers');
SELECT is(public.current_crew_id(:co::uuid), NULL, 'a password-only session has no roster card');
SELECT throws_ok(
  $$INSERT INTO public.timesheets (id, company_id, crew_id, date, hours)
    VALUES ('ts1', '11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000004', '2026-11-13', 8)$$,
  '42501', NULL, 'a password-only session cannot add time');
SELECT is((SELECT count(*)::int FROM public.crew_directory(:co::uuid)), 0,
  'a password-only session cannot list the team');
SELECT pg_temp.as_db();

SELECT pg_temp.act_as(:crew::uuid, 'aal2');
SELECT is((SELECT count(*)::int FROM public.jobs), 1, 'after the code (aal2) the job is visible again');
SELECT pg_temp.as_db();

-- An enrollment that was started but never confirmed does not count.
SELECT pg_temp.factor(:crew2::uuid, 'unverified');
SELECT pg_temp.act_as(:crew2::uuid, 'aal1');
SELECT is((SELECT count(*)::int FROM public.jobs), 1, 'an unfinished enrollment does not lock anyone out');
SELECT pg_temp.as_db();

-- ---------- an admin with two-step login on needs the code too ----------
SELECT pg_temp.factor(:manager::uuid, 'verified');
SELECT pg_temp.act_as(:manager::uuid, 'aal1');
SELECT ok(NOT public.is_company_admin(:co::uuid), 'a manager''s password-only session is not an admin');
SELECT throws_ok($$SELECT public.reset_two_step_login('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000004')$$,
  '42501', NULL, 'a manager''s password-only session cannot reset anyone');
SELECT pg_temp.as_db();

-- ---------- who has it on (owners and managers only) ----------
SELECT pg_temp.act_as(:manager::uuid, 'aal2');
SELECT set_eq($$SELECT user_id FROM public.two_step_logins('11111111-1111-4111-8111-111111111111')$$,
  ARRAY['dddddddd-0000-4000-8000-000000000003'::uuid, 'dddddddd-0000-4000-8000-000000000004'::uuid],
  'a manager sees who has two-step login on (not unfinished ones)');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:crew2::uuid);
SELECT is((SELECT count(*)::int FROM public.two_step_logins(:co::uuid)), 0, 'crew cannot see who has it on');

-- ---------- resetting (lost phone) ----------
SELECT throws_ok($$SELECT public.reset_two_step_login('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000004')$$,
  '42501', NULL, 'crew cannot reset anyone''s two-step login');
SELECT pg_temp.as_db();

SELECT pg_temp.act_as(:manager::uuid, 'aal2');
SELECT is(public.reset_two_step_login(:co::uuid, :crew::uuid), 1, 'a manager resets a crew member''s two-step login');
SELECT throws_ok($$SELECT public.reset_two_step_login('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000002')$$,
  '42501', NULL, 'a manager cannot reset an owner''s two-step login');
SELECT throws_ok($$SELECT public.reset_two_step_login('11111111-1111-4111-8111-111111111111', 'dddddddd-0000-4000-8000-000000000003')$$,
  '42501', NULL, 'nobody resets their own here (they turn it off in the app)');
SELECT pg_temp.as_db();

SELECT pg_temp.act_as(:crew::uuid, 'aal1');
SELECT is((SELECT count(*)::int FROM public.jobs), 1, 'after the reset, the password is enough again');
SELECT pg_temp.as_db();

SELECT pg_temp.factor(:owner2::uuid, 'verified');
SELECT pg_temp.act_as(:owner::uuid);
SELECT is(public.reset_two_step_login(:co::uuid, :owner2::uuid), 1, 'an owner can reset another owner''s two-step login');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
