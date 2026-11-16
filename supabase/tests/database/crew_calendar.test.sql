-- The "crew calendar view" rules: every member gets the
-- calendar columns of every job; nothing more, and nobody else does.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(9);

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
\set amy '''cccccccc-0000-4000-8000-000000000001'''
\set out '''cccccccc-0000-4000-8000-000000000009'''
SELECT pg_temp.signup(:amy::uuid, 'amy-cal@example.com');
SELECT pg_temp.signup(:out::uuid, 'outsider-cal@example.com');
INSERT INTO public.company_members (user_id, company_id, role) VALUES (:amy::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'amy', status = 'active' WHERE auth_user_id = :amy::uuid;
INSERT INTO public.customers (id, company_id, first_name, last_name, phone, city) VALUES
  ('cal-c1', :co::uuid, 'Secret', 'Customer', '555-555-0100', 'Riverside');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, value, notes) VALUES
  ('cal-mine', :co::uuid, 'cal-c1', 'Removal', 'Mine', '2026-12-07', 'scheduled', ARRAY['amy'], 900, 'note'),
  ('cal-far',  :co::uuid, 'cal-c1', 'Trimming', 'Far away job', '2027-03-15', 'scheduled', ARRAY['someone'], 5000, 'gate code 1234');

SELECT pg_temp.act_as(:amy::uuid);
SELECT ok(EXISTS (SELECT 1 FROM public.calendar_jobs(:co::uuid) WHERE id = 'cal-far'),
  'crew see a job months out on the calendar');
SELECT is((SELECT area FROM public.calendar_jobs(:co::uuid) WHERE id = 'cal-far'), 'Riverside',
  'the calendar shows the town');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = 'cal-far'),
  'but the full job (customer, notes, price) stays hidden on a day they don''t work');
SELECT is((SELECT count(*)::int FROM public.customers WHERE id = 'cal-c1'), 1,
  '(the customer is readable only through Amy''s own job)');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
  WHERE p.proname = 'calendar_jobs' AND a IN ('customer_id', 'value', 'notes', 'phone', 'address', 'team_notes', 'office_notes')),
  'calendar_jobs returns no customer, notes or price columns');
SELECT pg_temp.as_db();

-- Not on the team: nothing.
SELECT pg_temp.act_as(:out::uuid);
SELECT is((SELECT count(*)::int FROM public.calendar_jobs(:co::uuid)), 0, 'an outsider sees no calendar');
SELECT pg_temp.as_db();

-- Two-step login on, password-only session: nothing.
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
VALUES (gen_random_uuid(), :amy::uuid, 'app', 'totp', 'verified', now(), now());
SELECT pg_temp.act_as(:amy::uuid, 'aal1');
SELECT is((SELECT count(*)::int FROM public.calendar_jobs(:co::uuid)), 0, 'a password-only session with two-step on sees no calendar');
SELECT pg_temp.as_db();

-- Anonymous: not allowed to call it at all.
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.calendar_jobs('11111111-1111-4111-8111-111111111111')$$, '42501', NULL,
  'the public cannot call calendar_jobs');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.calendar_jobs(:co::uuid)), 0,
  'with no signed-in login, the calendar is empty');

SELECT * FROM finish();
ROLLBACK;
