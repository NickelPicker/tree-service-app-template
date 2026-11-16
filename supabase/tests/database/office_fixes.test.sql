-- The "office fixes" rules: approve_timesheet_week
-- replaces a week's approval in one transaction, for owners and
-- managers only.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(13);

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

\set co    '''aaaaaaaa-0000-4000-8000-0000000af001'''
\set other '''aaaaaaaa-0000-4000-8000-0000000af002'''
\set boss  '''bbbbbbbb-0000-4000-8000-0000000af001'''
\set desk  '''bbbbbbbb-0000-4000-8000-0000000af002'''
\set gus   '''bbbbbbbb-0000-4000-8000-0000000af003'''
\set far   '''bbbbbbbb-0000-4000-8000-0000000af004'''
\set own   '''bbbbbbbb-0000-4000-8000-0000000af005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Office Fix Co'), (:other::uuid, 'Other Fix Co');
SELECT pg_temp.signup(:boss::uuid, 'boss-of@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-of@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-of@example.com');
SELECT pg_temp.signup(:far::uuid, 'far-of@example.com');
SELECT pg_temp.signup(:own::uuid, 'own-of@example.com');
DELETE FROM public.company_members WHERE user_id IN (:boss::uuid, :desk::uuid, :gus::uuid, :far::uuid, :own::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:boss::uuid, :co::uuid, 'manager'), (:desk::uuid, :co::uuid, 'office'),
  (:gus::uuid, :co::uuid, 'crew'), (:far::uuid, :other::uuid, 'owner'),
  (:own::uuid, :co::uuid, 'owner');
UPDATE public.crew SET id = 'of-boss', name = 'Bo Boss', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :boss::uuid;
UPDATE public.crew SET id = 'of-desk', name = 'Olive Office', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'of-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'of-own', name = 'Ona Owner', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :own::uuid;
UPDATE public.crew SET id = 'of-far', name = 'Far Away', company_id = :other::uuid, status = 'active' WHERE auth_user_id = :far::uuid;

-- 1-2: who may call it
SELECT is(has_function_privilege('anon', 'public.approve_timesheet_week(uuid, date, numeric)', 'EXECUTE'), false,
  'signed-out visitors cannot call approve_timesheet_week');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.approve_timesheet_week(uuid, date, numeric)'::regprocedure), false,
  'it runs with the caller''s own rights (row-level security applies)');

-- 3-6: a manager approves, then approves again
SELECT pg_temp.act_as(:boss::uuid);
SELECT is((SELECT (approved_by, total_hours)::text FROM public.approve_timesheet_week(:co::uuid, '2026-11-09', 40)),
  '("Bo Boss",40.00)', 'a manager approves a week, stamped with their name');
SELECT is((SELECT total_hours FROM public.approve_timesheet_week(:co::uuid, '2026-11-09', 42.456)), 42.46::numeric,
  'approving again replaces the old approval');
SELECT is((SELECT count(*)::int FROM public.timesheet_week_approvals WHERE company_id = :co::uuid AND week_start = '2026-11-09'), 1,
  'one approval per week, never two');
SELECT throws_ok($$SELECT public.approve_timesheet_week('aaaaaaaa-0000-4000-8000-0000000af001', '2026-11-10', 1)$$,
  '23514', NULL, 'a week still starts on a Monday');

-- 7: a failed insert keeps the old approval (one transaction)
SELECT throws_ok($$SELECT public.approve_timesheet_week('aaaaaaaa-0000-4000-8000-0000000af001', '2026-11-09', -5)$$,
  '23514', NULL, 'bad hours are refused');
SELECT pg_temp.as_db();
SELECT is((SELECT total_hours FROM public.timesheet_week_approvals WHERE company_id = :co::uuid AND week_start = '2026-11-09'), 42.46::numeric,
  'after a refused re-approval the old approval is still there');

-- 9-10: an owner approves too (and replaces the manager's approval)
SELECT pg_temp.act_as(:own::uuid);
SELECT is((SELECT (approved_by, total_hours)::text FROM public.approve_timesheet_week(:co::uuid, '2026-11-16', 38)),
  '("Ona Owner",38.00)', 'an owner approves a week, stamped with their name');
SELECT is((SELECT approved_by FROM public.approve_timesheet_week(:co::uuid, '2026-11-09', 41)), 'Ona Owner',
  'an owner can replace a manager''s approval');

-- 11-13: nobody else
SELECT pg_temp.act_as(:desk::uuid);
SELECT throws_ok($$SELECT public.approve_timesheet_week('aaaaaaaa-0000-4000-8000-0000000af001', '2026-11-02', 1)$$,
  '42501', NULL, 'office cannot approve a week');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$SELECT public.approve_timesheet_week('aaaaaaaa-0000-4000-8000-0000000af001', '2026-11-09', 1)$$,
  '42501', NULL, 'crew cannot approve or replace an approval');
SELECT pg_temp.act_as(:far::uuid);
SELECT throws_ok($$SELECT public.approve_timesheet_week('aaaaaaaa-0000-4000-8000-0000000af001', '2026-11-09', 1)$$,
  '42501', NULL, 'another company''s owner cannot touch this company''s weeks');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
