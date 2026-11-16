-- Phase 2 — owner and signup safety (audit SEC-2, SEC-3, SEC-7).
-- Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(22);

-- ---------- helpers ----------
CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text, p_confirmed boolean)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, CASE WHEN p_confirmed THEN now() END, '{}'::jsonb);
$$;
CREATE FUNCTION pg_temp.confirm(p_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = p_id;
$$;
CREATE FUNCTION pg_temp.member_role(p_id uuid)
RETURNS text LANGUAGE sql AS $$
  SELECT role FROM public.company_members
  WHERE user_id = p_id AND company_id = '11111111-1111-4111-8111-111111111111';
$$;
-- Back to the database owner, with no signed-in user.
CREATE FUNCTION pg_temp.as_owner_db()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
-- Act as a signed-in user (RLS applies).
CREATE FUNCTION pg_temp.act_as(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

\set company '''11111111-1111-4111-8111-111111111111'''
\set owner   '''aaaaaaaa-0000-4000-8000-000000000001'''
\set owner2  '''aaaaaaaa-0000-4000-8000-000000000002'''
\set manager '''aaaaaaaa-0000-4000-8000-000000000003'''
\set crew    '''aaaaaaaa-0000-4000-8000-000000000004'''
\set intrude '''aaaaaaaa-0000-4000-8000-000000000005'''
\set partner '''aaaaaaaa-0000-4000-8000-000000000006'''

-- ---------- app_config is locked ----------
SELECT is(
  (SELECT owner_email FROM public.app_config),
  'owner@example.com',
  'app_config holds the owner email'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.app_config', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.app_config', 'SELECT'),
  'app_config is not readable by anon or authenticated'
);

-- ---------- signup rules ----------
SELECT pg_temp.signup(:owner::uuid, 'Owner@Example.com', false);
SELECT is(pg_temp.member_role(:owner::uuid), NULL,
  'owner email, not confirmed: no membership');
SELECT is((SELECT count(*)::int FROM public.crew WHERE auth_user_id = :owner::uuid), 0,
  'owner email, not confirmed: no roster row');

SELECT pg_temp.confirm(:owner::uuid);
SELECT is(pg_temp.member_role(:owner::uuid), 'owner',
  'owner email, confirmed: owner membership');
SELECT is((SELECT status FROM public.crew WHERE auth_user_id = :owner::uuid), 'active',
  'owner email, confirmed: active roster row');

SELECT pg_temp.signup(:intrude::uuid, 'someone@example.com', true);
SELECT is(pg_temp.member_role(:intrude::uuid), NULL,
  'other email, confirmed: no membership');
SELECT is((SELECT status FROM public.crew WHERE auth_user_id = :intrude::uuid), 'pending',
  'other email, confirmed: pending roster row');

-- A roster row the owner added for a crew member is linked only after
-- the login's email is confirmed (SEC-3).
INSERT INTO public.crew (id, company_id, name, email, status)
VALUES ('crew-pat', :company::uuid, 'Pat', 'pat@example.com', 'active');
SELECT pg_temp.signup(:crew::uuid, 'pat@example.com', false);
SELECT is((SELECT auth_user_id FROM public.crew WHERE id = 'crew-pat'), NULL,
  'unconfirmed signup with a crew email is not linked to that crew row');
SELECT pg_temp.confirm(:crew::uuid);
SELECT is((SELECT auth_user_id FROM public.crew WHERE id = 'crew-pat'), :crew::uuid,
  'confirmed signup is linked to the crew row with that email');
SELECT is(pg_temp.member_role(:crew::uuid), NULL,
  'linking does not grant a membership');

-- Set up a manager and a crew member (as the database owner).
SELECT pg_temp.signup(:manager::uuid, 'manager@example.com', true);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:manager::uuid, :company::uuid, 'manager');
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:crew::uuid, :company::uuid, 'crew');

-- ---------- manager limits ----------
SELECT pg_temp.act_as(:manager::uuid);

UPDATE public.company_members SET role = 'crew' WHERE user_id = :owner::uuid;
DELETE FROM public.company_members WHERE user_id = :owner::uuid;
RESET ROLE;
SELECT is(pg_temp.member_role(:owner::uuid), 'owner',
  'a manager cannot demote or remove the owner');

SELECT pg_temp.act_as(:manager::uuid);
SELECT throws_ok(
  format('INSERT INTO public.company_members (user_id, company_id, role) VALUES (%L, %L, ''owner'')',
         :intrude, :company),
  '42501', NULL,
  'a manager cannot create an owner membership'
);
SELECT throws_ok(
  format('UPDATE public.company_members SET role = ''owner'' WHERE user_id = %L', :crew),
  '42501', NULL,
  'a manager cannot promote anyone to owner'
);
SELECT lives_ok(
  format('INSERT INTO public.company_members (user_id, company_id, role) VALUES (%L, %L, ''crew'')',
         :intrude, :company),
  'a manager can approve a crew member'
);
UPDATE public.company_members SET role = 'manager' WHERE user_id = :intrude::uuid;
RESET ROLE;
SELECT is(pg_temp.member_role(:intrude::uuid), 'manager',
  'a manager can change a crew member to manager');

-- ---------- last owner ----------
SELECT pg_temp.act_as(:owner::uuid);
SELECT throws_ok(
  format('DELETE FROM public.company_members WHERE user_id = %L', :owner),
  '23514', NULL,
  'the last owner cannot be removed'
);
SELECT throws_ok(
  format('UPDATE public.company_members SET role = ''manager'' WHERE user_id = %L', :owner),
  '23514', NULL,
  'the last owner cannot be demoted'
);

-- With a second owner, an owner can step down.
RESET ROLE;
SELECT pg_temp.signup(:owner2::uuid, 'second@example.com', true);
SELECT pg_temp.act_as(:owner::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:owner2::uuid, :company::uuid, 'owner');
UPDATE public.company_members SET role = 'manager' WHERE user_id = :owner::uuid;
RESET ROLE;
SELECT is(pg_temp.member_role(:owner::uuid), 'manager',
  'an owner can step down once another owner exists');

-- ---------- more than one owner email (the "more owners" rules) ----------
SELECT pg_temp.as_owner_db();
UPDATE public.app_config SET extra_owner_emails = ARRAY['partner@example.com'];
SELECT pg_temp.signup(:partner::uuid, 'Partner@Example.com', false);
SELECT is(pg_temp.member_role(:partner::uuid), NULL,
  'extra owner email, not confirmed: no membership');
SELECT pg_temp.confirm(:partner::uuid);
SELECT is(pg_temp.member_role(:partner::uuid), 'owner',
  'extra owner email, confirmed: owner membership');
SELECT ok(NOT has_column_privilege('authenticated', 'public.app_config', 'extra_owner_emails', 'UPDATE'),
  'nobody signed in can change the owner list');

SELECT * FROM finish();
ROLLBACK;
