-- The "equipment problems" rules: anyone on the team
-- reports an equipment problem (text + optional photo); the office
-- reads every report and marks it fixed or sends the machine to the
-- shop; crew read only their own reports.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(40);

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

\set co    '''eeeeeeee-0000-4000-8000-0000000e0001'''
\set other '''eeeeeeee-0000-4000-8000-0000000e0002'''
\set gus   '''eeeeeeee-1111-4000-8000-0000000e0001'''
\set ann   '''eeeeeeee-1111-4000-8000-0000000e0002'''
\set sam  '''eeeeeeee-1111-4000-8000-0000000e0003'''
\set xs    '''eeeeeeee-1111-4000-8000-0000000e0004'''
\set p1    '''eeeeeeee-2222-4000-8000-0000000e0001'''
\set p2    '''eeeeeeee-2222-4000-8000-0000000e0002'''
\set p3    '''eeeeeeee-2222-4000-8000-0000000e0003'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Problem Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:gus::uuid, 'gus-problem-test@example.com');
SELECT pg_temp.signup(:ann::uuid, 'ann-problem-test@example.com');
SELECT pg_temp.signup(:sam::uuid, 'sam-problem-test@example.com');
SELECT pg_temp.signup(:xs::uuid, 'xs-problem-test@example.com');
DELETE FROM public.company_members WHERE user_id IN (:gus::uuid, :ann::uuid, :sam::uuid, :xs::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:gus::uuid, :co::uuid, 'crew'), (:ann::uuid, :co::uuid, 'crew'), (:sam::uuid, :co::uuid, 'office'),
  (:xs::uuid, :other::uuid, 'crew');
UPDATE public.crew SET id = 'e-gus', name = 'Gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'e-ann', name = 'Ann', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :ann::uuid;
UPDATE public.crew SET id = 'e-sam', name = 'Sam', company_id = :co::uuid, status = 'active', role = 'Office manager' WHERE auth_user_id = :sam::uuid;
UPDATE public.crew SET id = 'e-xs', name = 'Xena', company_id = :other::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :xs::uuid;

INSERT INTO public.equipment (id, company_id, name, kind, status, down) VALUES
  ('e-chip', :co::uuid, 'Chipper', 'Chipper', 'available', true),
  ('e-truck', :co::uuid, 'Truck 1', 'Truck', 'available', NULL),
  ('e-xchip', :other::uuid, 'Other chipper', 'Chipper', 'available', NULL);

-- ---- Gus (crew) reports ----
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$INSERT INTO public.equipment_problems (id, company_id, equipment_id, note, reported_name, reported_by)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0001', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-chip',
          'Feed roller jams', 'Somebody else', 'e-sam')$$,
  'crew report a problem');
SELECT is((SELECT reported_by || '/' || reported_name || '/' || (reported_user = auth.uid())::text
           FROM public.equipment_problems WHERE id = 'eeeeeeee-2222-4000-8000-0000000e0001'),
  'e-gus/Gus/true', 'who reported it is set by the database');
SELECT is((SELECT status FROM public.equipment_problems WHERE id = 'eeeeeeee-2222-4000-8000-0000000e0001'),
  'open', 'a new report is open');
SELECT throws_ok($$INSERT INTO public.equipment_problems (company_id, equipment_id, note, status)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-chip', 'x', 'fixed')$$,
  '42501', NULL, 'only as open');
SELECT throws_ok($$INSERT INTO public.equipment_problems (company_id, equipment_id, note)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0002', 'e-xchip', 'x')$$,
  '42501', NULL, 'not for another company');
SELECT throws_ok($$INSERT INTO public.equipment_problems (company_id, equipment_id, note)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-xchip', 'x')$$,
  '42501', NULL, 'nor another company''s machine filed under this company');
SELECT throws_ok($$INSERT INTO public.equipment_problems (company_id, equipment_id, note)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-chip', '   ')$$,
  '23514', NULL, 'a report needs some text');
SELECT throws_ok($$INSERT INTO public.equipment_problems (company_id, equipment_id, note)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-chip', repeat('x', 1001))$$,
  '23514', NULL, 'and at most 1000 characters');
SELECT lives_ok($$INSERT INTO public.equipment_problem_photos (problem_id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0001', 'eeeeeeee-0000-4000-8000-0000000e0001', 'image/jpeg', 3, '/9j/')$$,
  'the reporter adds a photo');
SELECT is((SELECT has_photo FROM public.equipment_problems WHERE id = 'eeeeeeee-2222-4000-8000-0000000e0001'),
  true, 'the report knows it has a photo');
SELECT is((SELECT count(*)::int FROM public.equipment_problem_photos), 1, 'and the reporter reads it back');
SELECT throws_ok($$UPDATE public.equipment_problems SET note = 'changed'$$,
  '42501', NULL, 'crew cannot change the text');
SELECT is_empty($$UPDATE public.equipment_problems SET status = 'fixed' RETURNING 1$$,
  'nor close their own report');
SELECT throws_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0001', 'fixed')$$,
  '42501', NULL, 'nor mark it fixed');
SELECT throws_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0001', 'shop')$$,
  '42501', NULL, 'nor send it to the shop');
SELECT is_empty($$DELETE FROM public.equipment_problems RETURNING 1$$, 'nor delete it');
SELECT pg_temp.as_db();

-- ---- Ann (crew) ----
SELECT pg_temp.act_as(:ann::uuid);
SELECT is((SELECT count(*)::int FROM public.equipment_problems), 0, 'crew do not see other people''s reports');
SELECT is((SELECT count(*)::int FROM public.equipment_problem_photos), 0, 'nor their photos');
SELECT throws_ok($$INSERT INTO public.equipment_problem_photos (problem_id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0001', 'eeeeeeee-0000-4000-8000-0000000e0001', 'image/png', 3, '/9j/')$$,
  '42501', NULL, 'nor add a photo to someone else''s report');
SELECT lives_ok($$INSERT INTO public.equipment_problems (id, company_id, equipment_id, note)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0002', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-chip', 'Belt squeals')$$,
  'a second report on the same machine');
SELECT lives_ok($$INSERT INTO public.equipment_problems (id, company_id, equipment_id, note)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0003', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-truck', 'Flat tyre')$$,
  'and one on the truck');
SELECT throws_ok($$INSERT INTO public.equipment_problem_photos (problem_id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0002', 'eeeeeeee-0000-4000-8000-0000000e0001', 'image/png', 3, '/9j/')$$,
  '23514', NULL, 'a photo must be what its type says');
SELECT throws_ok($$INSERT INTO public.equipment_problem_photos (problem_id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('eeeeeeee-2222-4000-8000-0000000e0002', 'eeeeeeee-0000-4000-8000-0000000e0001', 'image/jpeg', 2097153, '/9j/')$$,
  '23514', NULL, 'and at most 2 MB');
SELECT is((SELECT count(*)::int FROM public.equipment_problems), 2, 'Ann reads her own two reports');
SELECT pg_temp.as_db();

-- ---- Another company ----
SELECT pg_temp.act_as(:xs::uuid);
SELECT is((SELECT count(*)::int FROM public.equipment_problems), 0, 'another company sees no reports');
SELECT throws_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0003', 'fixed')$$,
  '42501', NULL, 'and cannot close one');
SELECT pg_temp.as_db();

-- ---- Signed out ----
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT count(*) FROM public.equipment_problems$$, '42501', NULL, 'signed-out visitors read nothing');
RESET ROLE;

-- ---- Sam (office) ----
SELECT pg_temp.act_as(:sam::uuid);
SELECT is((SELECT count(*)::int FROM public.equipment_problems), 3, 'the office reads every report');
SELECT is((SELECT count(*)::int FROM public.equipment_problem_photos), 1, 'and every photo');
SELECT throws_ok($$UPDATE public.equipment_problems SET note = 'changed'$$,
  '42501', NULL, 'the office cannot change what was reported');
SELECT lives_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0001', 'shop')$$,
  'the office sends a machine to the shop');
SELECT is((SELECT status || '/' || status_by_name FROM public.equipment_problems WHERE id = 'eeeeeeee-2222-4000-8000-0000000e0001'),
  'in_shop/Sam', 'the report is in the shop, by Sam');
SELECT is((SELECT status FROM public.equipment WHERE id = 'e-chip'), 'in_shop', 'and so is the machine');
SELECT lives_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0001', 'fixed')$$,
  'marks it fixed');
SELECT is((SELECT status FROM public.equipment WHERE id = 'e-chip'), 'in_shop',
  'the machine stays in the shop while another problem on it is open');
SELECT lives_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0002', 'fixed')$$,
  'marks the other one fixed');
SELECT is((SELECT status || '/' || coalesce(down::text, 'null') FROM public.equipment WHERE id = 'e-chip'),
  'available/false', 'then the machine is back: available and not down');
SELECT throws_ok($$SELECT public.resolve_equipment_problem('eeeeeeee-2222-4000-8000-0000000e0003', 'retire')$$,
  '22023', NULL, 'only fixed or shop');
SELECT lives_ok($$DELETE FROM public.equipment_problems WHERE id = 'eeeeeeee-2222-4000-8000-0000000e0001'$$,
  'the office deletes a report');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.equipment_problem_photos), 0, 'and its photo goes with it');

SELECT * FROM finish();
ROLLBACK;
