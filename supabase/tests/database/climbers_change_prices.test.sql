-- The "climbers change prices" rules: a Climber on the
-- job changes its prices (value, hourly rate, billing) without "see
-- money"; its costs (labor rate, materials, other costs) still need
-- "see money"; groundsmen still change nothing but the status.
-- Since the "climber price change notes" rules a Climber sees the prices and changes them only
-- with a reason, through change_job_price (direct updates of the price
-- are refused; tested further in climber_price_change_notes.test.sql).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(19);

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

\set co  '''eeeeeeee-0000-4000-8000-0000000e0001'''
\set cal '''eeeeeeee-1111-4000-8000-0000000e0001'''
\set gus '''eeeeeeee-1111-4000-8000-0000000e0002'''
\set mo  '''eeeeeeee-1111-4000-8000-0000000e0003'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Price Co');
SELECT pg_temp.signup(:cal::uuid, 'cal-price@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-price@example.com');
SELECT pg_temp.signup(:mo::uuid, 'mo-price@example.com');
DELETE FROM public.company_members WHERE user_id IN (:cal::uuid, :gus::uuid, :mo::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:cal::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'), (:mo::uuid, :co::uuid, 'crew');
-- Cal is a Climber without "see money"; Gus a groundsman without it;
-- Mo a groundsman with it.
UPDATE public.crew SET id = 'p-cal', company_id = :co::uuid, status = 'active', role = 'Climber',
  permissions = '{}'::jsonb WHERE auth_user_id = :cal::uuid;
UPDATE public.crew SET id = 'p-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{}'::jsonb WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'p-mo', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{"seeMoney": true}'::jsonb WHERE auth_user_id = :mo::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('p-c1', :co::uuid, 'Ann', 'A'), ('p-c2', :co::uuid, 'Ben', 'B');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids,
                         value, hourly_rate, billing_type, labor_rate, materials_cost, other_cost) VALUES
  ('p-j1', :co::uuid, 'p-c1', 'Removal', 'Big oak', '2026-12-14', 'scheduled', ARRAY['p-cal', 'p-gus', 'p-mo'],
   900, NULL, 'flat', 30, 50, 10),
  -- Same day, Cal is not on it.
  ('p-j2', :co::uuid, 'p-c2', 'Trimming', 'Elm trim', '2026-12-14', 'scheduled', ARRAY['p-gus'],
   400, NULL, 'flat', NULL, NULL, NULL);

-- ---------- 1-12: Climber without "see money" ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$SELECT public.change_job_price('p-j1', 950, 95, 'flat', 'Customer added a stump')$$,
  'a Climber without see money changes the job value and hourly rate (with a reason)');
SELECT lives_ok($$SELECT public.change_job_price('p-j1', 950, 95, 'hourly', 'Bigger than quoted, bill by the hour')$$,
  'and switches the job to hourly billing');
SELECT throws_ok($$UPDATE public.jobs SET labor_rate = 35 WHERE id = 'p-j1'$$, '42501',
  'Only people who can see money can change a job''s costs.',
  'but not the labor rate (a cost)');
SELECT throws_ok($$UPDATE public.jobs SET materials_cost = 60 WHERE id = 'p-j1'$$, '42501', NULL,
  'nor the materials cost');
SELECT throws_ok($$UPDATE public.jobs SET other_cost = 20 WHERE id = 'p-j1'$$, '42501', NULL,
  'nor other costs');
SELECT throws_ok($$UPDATE public.jobs SET value = 1000, labor_rate = 35 WHERE id = 'p-j1'$$, '42501', NULL,
  'a price change together with a cost change is refused as a whole');
SELECT is((SELECT value::text || ' ' || coalesce(labor_rate::text, '-') FROM public.app_jobs(:co::uuid) WHERE id = 'p-j1'),
  '950 -', 'he sees the job''s price (the "climber price change notes" rules) but not its costs');
-- Not on p-j2: the update reaches nothing, and the function refuses.
UPDATE public.jobs SET value = 1 WHERE id = 'p-j2';
SELECT pg_temp.as_db();
SELECT is((SELECT value FROM public.jobs WHERE id = 'p-j1'), 950::numeric, 'the new value saved');
SELECT is((SELECT hourly_rate FROM public.jobs WHERE id = 'p-j1'), 95::numeric, 'the new hourly rate saved');
SELECT is((SELECT billing_type FROM public.jobs WHERE id = 'p-j1'), 'hourly', 'the billing saved');
SELECT is((SELECT labor_rate::text || ' ' || materials_cost || ' ' || other_cost FROM public.jobs WHERE id = 'p-j1'),
  '30 50 10', 'the costs did not change');
SELECT is((SELECT value FROM public.jobs WHERE id = 'p-j2'), 400::numeric,
  'a Climber cannot change the price of a job he is not on');

-- ---------- 13-14: Climber with "see money" changes costs too ----------
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'p-cal';
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$UPDATE public.jobs SET labor_rate = 35, materials_cost = 60, other_cost = 20 WHERE id = 'p-j1'$$,
  'with see money a Climber changes the costs');
SELECT pg_temp.as_db();
SELECT is((SELECT labor_rate FROM public.jobs WHERE id = 'p-j1'), 35::numeric, 'and they saved');

-- ---------- 15-19: groundsmen still cannot change prices ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$UPDATE public.jobs SET value = 1200 WHERE id = 'p-j1'$$, '42501',
  'Crew can only change the status of a job.',
  'a Groundsman cannot change the job value');
SELECT throws_ok($$UPDATE public.jobs SET hourly_rate = 70 WHERE id = 'p-j1'$$, '42501', NULL,
  'nor the hourly rate');
SELECT throws_ok($$UPDATE public.jobs SET billing_type = 'flat' WHERE id = 'p-j1'$$, '42501', NULL,
  'nor the billing');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:mo::uuid);
SELECT throws_ok($$UPDATE public.jobs SET value = 1200 WHERE id = 'p-j1'$$, '42501', NULL,
  'a Groundsman with see money cannot change the job value either');
SELECT pg_temp.as_db();
SELECT is((SELECT value FROM public.jobs WHERE id = 'p-j1'), 950::numeric, 'the value is unchanged');

SELECT * FROM finish();
ROLLBACK;
