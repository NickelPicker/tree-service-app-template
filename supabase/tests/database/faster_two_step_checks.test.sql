-- The "faster two step checks" rules: the helpers keep
-- their meaning after the rewrite, and a two-step reset signs the person
-- out on every device. Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(24);

CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, now(), '{}'::jsonb);
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
CREATE FUNCTION pg_temp.factor(p_user uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  VALUES (gen_random_uuid(), p_user, 'Authenticator app', 'totp', 'verified', now(), now());
$$;
-- A signed-in device: a session that entered a code (aal2), with its
-- refresh token and its "password + code" markers.
CREATE FUNCTION pg_temp.device(p_user uuid, p_session uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
    VALUES (p_session, p_user, now(), now(), 'aal2');
  INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
    VALUES (gen_random_uuid(), p_session, now(), now(), 'password'),
           (gen_random_uuid(), p_session, now(), now(), 'totp');
  INSERT INTO auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
    VALUES ('00000000-0000-0000-0000-000000000000', md5(p_session::text), p_user::text, false, now(), now(), p_session);
$$;

\set co '''11111111-1111-4111-8111-111111111111'''
\set owner   '''eeeeeeee-0000-4000-8000-000000000001'''
\set manager '''eeeeeeee-0000-4000-8000-000000000003'''
\set crew    '''eeeeeeee-0000-4000-8000-000000000004'''
\set crew2   '''eeeeeeee-0000-4000-8000-000000000005'''
\set outsider '''eeeeeeee-0000-4000-8000-000000000009'''

SELECT pg_temp.signup(:owner::uuid, 'owner-fast@example.com');
SELECT pg_temp.signup(:manager::uuid, 'manager-fast@example.com');
SELECT pg_temp.signup(:crew::uuid, 'crew-fast@example.com');
SELECT pg_temp.signup(:crew2::uuid, 'crew2-fast@example.com');
SELECT pg_temp.signup(:outsider::uuid, 'outsider-fast@example.com');
UPDATE public.crew SET status = 'active' WHERE company_id = :co::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:owner::uuid, :co::uuid, 'owner'),
  (:manager::uuid, :co::uuid, 'manager'),
  (:crew::uuid, :co::uuid, 'crew'),
  (:crew2::uuid, :co::uuid, 'crew')
ON CONFLICT DO NOTHING;
INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('fc1', :co::uuid, 'Mia', 'Mine'),
  ('fc2', :co::uuid, 'Otto', 'Other');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids) VALUES
  ('fj1', :co::uuid, 'fc1', 'Removal', 'Oak', '2026-12-01', 'scheduled', ARRAY[:crew]);

-- ---------- the helpers mean what they meant ----------
SELECT pg_temp.act_as(:crew::uuid);
SELECT ok(public.is_company_member(:co::uuid), 'crew is a member');
SELECT ok(NOT public.is_company_staff(:co::uuid), 'crew is not staff');
SELECT is(public.current_member_role(:co::uuid), 'crew', 'crew role');
SELECT is(public.current_crew_id(:co::uuid), :crew, 'crew has their roster card');
SELECT ok(public.can_read_customer(:co::uuid, 'fc1'), 'crew reads the customer of their job');
SELECT ok(NOT public.can_read_customer(:co::uuid, 'fc2'), 'crew does not read other customers');
SELECT is((SELECT count(*)::int FROM public.customers WHERE id IN ('fc1', 'fc2')), 1, 'crew sees one of the two customers');
SELECT pg_temp.as_db();

UPDATE public.crew SET permissions = '{"seeAllCustomers": true}'::jsonb WHERE id = :crew;
SELECT pg_temp.act_as(:crew::uuid);
SELECT ok(public.crew_perm(:co::uuid, 'seeAllCustomers'), 'the see-all-customers switch counts');
SELECT ok(public.can_read_customer(:co::uuid, 'fc2'), 'with the switch, crew reads every customer');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = :crew;

SELECT pg_temp.act_as(:manager::uuid);
SELECT ok(public.is_company_admin(:co::uuid) AND NOT public.is_company_owner(:co::uuid), 'a manager is admin, not owner');
SELECT ok(public.can_read_customer(:co::uuid, 'fc2'), 'staff read every customer');
SELECT pg_temp.as_db();

SELECT pg_temp.act_as(:outsider::uuid);
SELECT ok(NOT public.is_company_member(:co::uuid), 'an outsider is not a member');
SELECT ok(NOT public.can_read_customer(:co::uuid, 'fc1'), 'an outsider reads no customer');
SELECT is(public.current_crew_id(:co::uuid), NULL, 'an outsider has no roster card');
SELECT pg_temp.as_db();

-- ---------- two-step login on: password-only sessions are shut out ----------
SELECT pg_temp.factor(:crew::uuid);
UPDATE public.crew SET permissions = '{"seeAllCustomers": true}'::jsonb WHERE id = :crew;
SELECT pg_temp.act_as(:crew::uuid, 'aal1');
SELECT ok(NOT public.crew_perm(:co::uuid, 'seeAllCustomers'), 'password only: switches do not count');
SELECT ok(NOT public.can_read_customer(:co::uuid, 'fc1'), 'password only: no customers');
SELECT is(public.current_crew_name(:co::uuid), NULL, 'password only: no roster name');
SELECT is(public.current_member_role(:co::uuid), NULL, 'password only: no role');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:crew::uuid, 'aal2');
SELECT ok(public.can_read_customer(:co::uuid, 'fc2'), 'with the code: back to normal');
SELECT pg_temp.as_db();

-- ---------- a reset signs the person out everywhere ----------
SELECT pg_temp.device(:crew::uuid, 'aaaaaaaa-0000-4000-8000-00000000000a');
SELECT pg_temp.device(:crew::uuid, 'aaaaaaaa-0000-4000-8000-00000000000b');
SELECT pg_temp.device(:crew2::uuid, 'aaaaaaaa-0000-4000-8000-00000000000c');
SELECT pg_temp.act_as(:manager::uuid, 'aal2');
SELECT is(public.reset_two_step_login(:co::uuid, :crew::uuid), 1, 'the manager resets the crew member''s two-step login');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM auth.sessions WHERE user_id = :crew::uuid), 0,
  'none of their sessions are left (the lost phone is signed out)');
SELECT is((SELECT count(*)::int FROM auth.refresh_tokens WHERE session_id IN
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000b')), 0,
  'their refresh tokens are gone');
SELECT is((SELECT count(*)::int FROM auth.mfa_amr_claims WHERE session_id IN
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000b')), 0,
  'no "entered a code" marker is left');
SELECT is((SELECT count(*)::int FROM auth.sessions WHERE user_id = :crew2::uuid), 1,
  'someone else''s sessions are untouched');

SELECT * FROM finish();
ROLLBACK;
