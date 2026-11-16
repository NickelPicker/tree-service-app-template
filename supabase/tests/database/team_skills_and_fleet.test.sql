-- The "team skills and fleet" rules: skills, driving
-- and fleet details exist, and only owners/managers (people) or staff
-- (equipment) can change them. Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(16);

CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, now(), '{}'::jsonb);
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

\set co '''11111111-1111-4111-8111-111111111111'''
\set manager '''ffffffff-0000-4000-8000-000000000003'''
\set office  '''ffffffff-0000-4000-8000-000000000006'''
\set crew    '''ffffffff-0000-4000-8000-000000000004'''

SELECT pg_temp.signup(:manager::uuid, 'manager-skills@example.com');
SELECT pg_temp.signup(:office::uuid, 'office-skills@example.com');
SELECT pg_temp.signup(:crew::uuid, 'crew-skills@example.com');
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:manager::uuid, :co::uuid, 'manager'),
  (:office::uuid, :co::uuid, 'office'),
  (:crew::uuid, :co::uuid, 'crew')
ON CONFLICT DO NOTHING;
INSERT INTO public.crew (id, company_id, name, role, phone, color, app_role, email, auth_user_id, status, message_intro)
VALUES ('sk-crew', :co::uuid, 'Sam Skills', 'Climber', '', '#000', 'crew', '', :crew::uuid, 'active', '');
INSERT INTO public.equipment (id, company_id, name, kind, details, status)
VALUES ('sk-truck', :co::uuid, 'Big Truck', 'Truck', '', 'available');

-- ---------- the columns, with safe defaults ----------
SELECT is((SELECT skills FROM public.crew WHERE id = 'sk-crew'), '{}'::text[], 'skills default to none');
SELECT is((SELECT driver_licensed OR company_insured OR last_resort OR prefers_own_truck FROM public.crew WHERE id = 'sk-crew'),
  false, 'driving and last-resort flags default to off');
SELECT is((SELECT cdl_class FROM public.crew WHERE id = 'sk-crew'), 'none', 'CDL defaults to none');
SELECT throws_ok($$UPDATE public.crew SET cdl_class = 'C' WHERE id = 'sk-crew'$$,
  '23514', NULL, 'only none / B / A are valid CDL classes');
SELECT throws_ok($$UPDATE public.equipment SET seats = -1 WHERE id = 'sk-truck'$$,
  '23514', NULL, 'seats cannot be negative');
SELECT has_column('public', 'settings', 'planner', 'settings has the planner column');

-- ---------- a crew login cannot change its own skills or driving ----------
SELECT pg_temp.act_as(:crew::uuid);
SELECT throws_ok($$UPDATE public.crew SET skills = ARRAY['climbing'] WHERE id = 'sk-crew'$$,
  '42501', NULL, 'crew cannot give themselves skills');
SELECT throws_ok($$UPDATE public.crew SET driver_licensed = true, company_insured = true WHERE id = 'sk-crew'$$,
  '42501', NULL, 'crew cannot make themselves a driver');
SELECT throws_ok($$UPDATE public.crew SET last_resort = false, cdl_class = 'A' WHERE id = 'sk-crew'$$,
  '42501', NULL, 'crew cannot change their CDL or last-resort flag');
SELECT is_empty($$UPDATE public.equipment SET weekly_driver_limit = 5 WHERE id = 'sk-truck' RETURNING 1$$,
  'crew cannot change a vehicle''s weekly driver limit');
SELECT is_empty($$UPDATE public.settings SET planner = '{"skillCatalog": []}'::jsonb
  WHERE company_id = '11111111-1111-4111-8111-111111111111' RETURNING 1$$, 'crew cannot change the skill list');
SELECT pg_temp.as_db();

-- ---------- office (staff) can change vehicles, not people ----------
SELECT pg_temp.act_as(:office::uuid);
SELECT isnt_empty($$UPDATE public.equipment SET weekly_driver_limit = 1, seats = 3, tows = ARRAY['chip1']
  WHERE id = 'sk-truck' RETURNING 1$$, 'office can set a vehicle''s seats, towing and weekly limit');
SELECT pg_temp.as_db();

-- ---------- managers set skills and driving ----------
SELECT pg_temp.act_as(:manager::uuid);
SELECT lives_ok($$UPDATE public.crew SET skills = ARRAY['climbing', 'rigging'], driver_licensed = true,
  company_insured = true, cdl_class = 'B' WHERE id = 'sk-crew'$$, 'a manager sets skills and driving');
SELECT pg_temp.as_db();
SELECT is((SELECT skills FROM public.crew WHERE id = 'sk-crew'), ARRAY['climbing', 'rigging'], 'the skills were saved');

-- ---------- the team list never shows skills or driving ----------
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
  WHERE p.proname = 'crew_directory' AND a IN ('skills', 'driver_licensed', 'company_insured', 'cdl_class', 'last_resort')),
  'crew_directory() does not return skills or driving details');
SELECT is((SELECT weekly_driver_limit FROM public.equipment WHERE id = 'sk-truck'), 1, 'the weekly limit was saved');

SELECT * FROM finish();
ROLLBACK;
