-- The "estimate equipment and crew" rules: equipment
-- and expected crew (counts or names) on estimates. Internal only: not
-- in the customer copy, and changing them does not end an emailed link.
-- Who may read or change an estimate is unchanged.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(22);

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

-- ---------- 1-8: the columns ----------
SELECT has_column('public', 'estimates', 'equipment_ids', 'estimates.equipment_ids exists');
SELECT col_type_is('public', 'estimates', 'equipment_ids', 'text[]', 'equipment_ids is text[] like jobs.equipment_ids');
SELECT col_is_null('public', 'estimates', 'equipment_ids', 'equipment_ids may be null (not set)');
SELECT col_type_is('public', 'estimates', 'expected_climbers', 'integer', 'expected_climbers is an int');
SELECT col_type_is('public', 'estimates', 'expected_groundsmen', 'integer', 'expected_groundsmen is an int');
SELECT col_type_is('public', 'estimates', 'expected_crew_ids', 'text[]', 'expected_crew_ids is text[] like jobs.crew_ids');
SELECT col_is_null('public', 'estimates', 'expected_climbers', 'expected_climbers may be null');
SELECT col_is_null('public', 'estimates', 'expected_crew_ids', 'expected_crew_ids may be null');

\set co   '''eeeeeeee-0000-4000-8000-0000000e0001'''
\set desk '''eeeeeeee-1111-4000-8000-0000000e0001'''
\set gus  '''eeeeeeee-1111-4000-8000-0000000e0002'''
\set mo   '''eeeeeeee-1111-4000-8000-0000000e0003'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Fleet Co');
SELECT pg_temp.signup(:desk::uuid, 'desk-fleet@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-fleet@example.com');
SELECT pg_temp.signup(:mo::uuid, 'mo-fleet@example.com');
DELETE FROM public.company_members WHERE user_id IN (:desk::uuid, :gus::uuid, :mo::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:desk::uuid, :co::uuid, 'office'), (:gus::uuid, :co::uuid, 'crew'), (:mo::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'f-desk', company_id = :co::uuid, status = 'active', role = 'Office' WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'f-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
-- Mo has the "see money" switch on.
UPDATE public.crew SET id = 'f-mo', company_id = :co::uuid, status = 'active', role = 'Climber',
  permissions = '{"seeMoney": true}'::jsonb WHERE auth_user_id = :mo::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES ('f-c1', :co::uuid, 'Ann', 'A');
INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, lines, notes) VALUES
  ('f-e1', :co::uuid, 'f-c1', 'Oak', 'sent', '2026-11-01',
   '[{"id":"l1","description":"Remove oak","quantity":1,"unitPrice":1200}]'::jsonb, 'Gate on the left');
-- Mo works a job for this customer, so with "see money" he may read its estimate.
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids) VALUES
  ('f-j1', :co::uuid, 'f-c1', 'Removal', 'Oak', '2026-12-14', 'scheduled', ARRAY['f-mo', 'f-gus']);

-- ---------- 9-11: the office writes them ----------
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$
  UPDATE public.estimates
     SET equipment_ids = ARRAY['eq-chiptruck', 'eq-chipper'], expected_climbers = 1,
         expected_groundsmen = 2, expected_crew_ids = ARRAY['f-mo'], expected_crew = 1
   WHERE id = 'f-e1' $$, 'the office saves equipment and crew on an estimate');
SELECT is((SELECT expected_climbers + expected_groundsmen FROM public.estimates WHERE id = 'f-e1'), 3,
  'the counts are saved');
SELECT is((SELECT equipment_ids FROM public.estimates WHERE id = 'f-e1'), ARRAY['eq-chiptruck', 'eq-chipper'],
  'the equipment is saved');
SELECT pg_temp.as_db();

-- ---------- 12-14: sensible numbers only ----------
SELECT throws_ok($$ UPDATE public.estimates SET expected_climbers = -1 WHERE id = 'f-e1' $$,
  '23514', NULL, 'no negative climbers');
SELECT throws_ok($$ UPDATE public.estimates SET expected_groundsmen = 51 WHERE id = 'f-e1' $$,
  '23514', NULL, 'no more than 50 groundsmen');
SELECT lives_ok($$ UPDATE public.estimates SET expected_climbers = 0 WHERE id = 'f-e1' $$,
  'zero climbers is fine (groundsmen-only job)');
UPDATE public.estimates SET expected_climbers = 1 WHERE id = 'f-e1';

-- ---------- 15-18: crew rules unchanged ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.estimates WHERE id = 'f-e1'), 0,
  'crew without "see money" still cannot read the estimate (nor its crew and equipment)');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:mo::uuid);
SELECT is((SELECT equipment_ids FROM public.estimates WHERE id = 'f-e1'), ARRAY['eq-chiptruck', 'eq-chipper'],
  'crew with "see money" read it as before');
UPDATE public.estimates SET equipment_ids = NULL, expected_crew_ids = ARRAY['f-gus'] WHERE id = 'f-e1';
SELECT pg_temp.as_db();
SELECT is((SELECT equipment_ids FROM public.estimates WHERE id = 'f-e1'), ARRAY['eq-chiptruck', 'eq-chipper'],
  'crew still cannot change an estimate''s equipment');
SELECT is((SELECT expected_crew_ids FROM public.estimates WHERE id = 'f-e1'), ARRAY['f-mo'],
  'crew still cannot change an estimate''s crew');

-- ---------- 19-22: never shown to the customer ----------
SELECT ok(NOT (public.estimate_for_customer(e) ?| ARRAY['equipment_ids', 'expected_climbers',
             'expected_groundsmen', 'expected_crew_ids', 'expected_crew']),
  'the customer copy has none of the internal crew or equipment fields')
  FROM public.estimates e WHERE e.id = 'f-e1';
SELECT ok(public.estimate_for_customer(e)::text !~* '(chiptruck|chipper|f-mo|climber|groundsm)',
  'nor their values anywhere in it')
  FROM public.estimates e WHERE e.id = 'f-e1';

CREATE TEMP TABLE h AS SELECT public.estimate_content_hash(e) AS before FROM public.estimates e WHERE e.id = 'f-e1';
UPDATE public.estimates
   SET equipment_ids = ARRAY['eq-trailer'], expected_climbers = 2, expected_groundsmen = 3,
       expected_crew_ids = NULL, expected_crew = 5
 WHERE id = 'f-e1';
SELECT is((SELECT public.estimate_content_hash(e) FROM public.estimates e WHERE e.id = 'f-e1'),
  (SELECT before FROM h),
  'changing the crew or equipment does not end a link already emailed');
UPDATE public.estimates SET notes = 'Gate on the right' WHERE id = 'f-e1';
SELECT isnt((SELECT public.estimate_content_hash(e) FROM public.estimates e WHERE e.id = 'f-e1'),
  (SELECT before FROM h),
  'changing what the customer sees still does');

SELECT * FROM finish();
ROLLBACK;
