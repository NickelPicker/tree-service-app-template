-- A Sales login sees a job's money unless the job is commercial (or its
-- customer row is missing) and its estimate is not his; everyone else is
-- unchanged.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(17);

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

\set co    '''b7b7b7b7-0000-4000-8000-0000000b0001'''
\set two   '''b7b7b7b7-0000-4000-8000-0000000b0002'''
\set pat    '''b7b7b7b7-1111-4000-8000-0000000b0001'''
\set gus   '''b7b7b7b7-1111-4000-8000-0000000b0002'''
\set desk  '''b7b7b7b7-1111-4000-8000-0000000b0003'''
\set cal   '''b7b7b7b7-1111-4000-8000-0000000b0004'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Sales Money Co'), (:two::uuid, 'Two Sales Co');
SELECT pg_temp.signup(:pat::uuid, 'pat-salesmoney@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-salesmoney@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-salesmoney@example.com');
SELECT pg_temp.signup(:cal::uuid, 'cal-salesmoney@example.com');
DELETE FROM public.company_members WHERE user_id IN (:pat::uuid, :gus::uuid, :desk::uuid, :cal::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:pat::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'),
  (:desk::uuid, :co::uuid, 'office'), (:cal::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'b-pat', company_id = :co::uuid, status = 'active', role = ' sales ' WHERE auth_user_id = :pat::uuid;
UPDATE public.crew SET id = 'b-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'b-desk', company_id = :co::uuid, status = 'active', role = 'Office' WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'b-cal', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :cal::uuid;
-- Pat's old card (inactive Groundsman) and a former Sales person
-- (inactive): neither counts as the company's Sales card.
INSERT INTO public.crew (id, company_id, auth_user_id, name, role, status) VALUES
  ('b-a-pat-old', :co::uuid, :pat::uuid, 'Pat (old card)', 'Groundsman', 'inactive'),
  ('b-ex-sales', :co::uuid, NULL, 'Former seller', 'Sales', 'inactive'),
  ('b-sam', :co::uuid, NULL, 'Office person', 'Office', 'active'),
  ('t-s1', :two::uuid, NULL, 'Seller one', 'Sales', 'active'),
  ('t-s2', :two::uuid, NULL, 'Seller two', 'SALES', 'active');

INSERT INTO public.customers (id, company_id, first_name, last_name, customer_type) VALUES
  ('b-res', :co::uuid, 'Ann', 'Home', 'residential'),
  ('b-res2', :co::uuid, 'Bea', 'House', ' Residential '),
  ('b-com', :co::uuid, 'Build', 'Corp', 'commercial'),
  ('b-com2', :co::uuid, 'Mall', 'Inc', 'Commercial'),
  ('t-res', :two::uuid, 'Tom', 'Two', 'residential');
INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, created_by_crew_id) VALUES
  ('b-e-after', :co::uuid, 'b-res', 'Residential after', 'sent', '2026-09-11', NULL),
  ('b-e-after2', :co::uuid, 'b-res2', 'Residential after (type in odd case)', 'closed', '2026-11-01', NULL),
  ('b-e-on', :co::uuid, 'b-res', 'Residential on Sept 10', 'sent', '2026-09-10', NULL),
  ('b-e-before', :co::uuid, 'b-res', 'Residential before', 'accepted', '2026-08-01', NULL),
  ('b-e-com', :co::uuid, 'b-com', 'Commercial after', 'sent', '2026-10-01', NULL),
  ('b-e-com2', :co::uuid, 'b-com2', 'Commercial after (capital C)', 'sent', '2026-10-02', NULL),
  ('b-e-sam', :co::uuid, 'b-res', 'Residential by the office', 'sent', '2026-10-03', 'b-sam'),
  ('b-e-ghost', :co::uuid, 'b-nobody', 'Customer row missing', 'sent', '2026-10-04', NULL),
  ('b-e-baddate', :co::uuid, 'b-res', 'Odd date', 'sent', 'soon', NULL),
  ('b-e-jpcom', :co::uuid, 'b-com', 'Commercial bid Pat wrote', 'accepted', '2026-10-05', 'b-a-pat-old'),
  ('t-e-after', :two::uuid, 't-res', 'Two sellers, residential after', 'sent', '2026-10-01', NULL);
-- A customer's open accept link on one of the estimates.
INSERT INTO public.estimate_accept_links (company_id, estimate_id, token_hash, content_hash)
  SELECT :co::uuid, 'b-e-after', repeat('ab', 32), public.estimate_content_hash(e)
    FROM public.estimates e WHERE e.id = 'b-e-after';

-- Residential estimates the Sales person wrote.
UPDATE public.estimates SET created_by_crew_id = 'b-pat' WHERE id IN ('b-e-after', 'b-e-after2');

-- ---- jobs from those estimates ----
INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, created_by_crew_id) VALUES
  ('b-e-comsam', :co::uuid, 'b-com', 'Commercial bid by the office', 'accepted', '2026-10-06', 'b-sam');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids,
                         value, hourly_rate, estimate_id) VALUES
  ('b-j-his', :co::uuid, 'b-res', 'Removal', 'Residential, from his bid', '2026-12-14', 'scheduled',
   ARRAY['b-gus', 'b-cal', 'b-pat'], 1500, 90, 'b-e-after'),
  ('b-j-old', :co::uuid, 'b-com', 'Trimming', 'Commercial, from his old card''s bid', '2026-12-15', 'scheduled',
   ARRAY['b-x'], 9000, NULL, 'b-e-jpcom'),
  ('b-j-sam', :co::uuid, 'b-res', 'Removal', 'Residential, from the office''s bid', '2026-12-16', 'scheduled',
   ARRAY['b-pat', 'b-cal'], 800, NULL, 'b-e-sam'),
  ('b-j-com', :co::uuid, 'b-com', 'Trimming', 'Commercial, from an unattributed bid', '2026-12-17', 'scheduled',
   ARRAY['b-pat'], 5000, NULL, 'b-e-com'),
  ('b-j-comsam', :co::uuid, 'b-com', 'Trimming', 'Commercial, from the office''s bid', '2026-12-19', 'scheduled',
   ARRAY['b-x'], 7000, NULL, 'b-e-comsam'),
  ('b-j-comnone', :co::uuid, 'b-com2', 'Trimming', 'Commercial, no estimate', '2026-12-20', 'scheduled',
   ARRAY['b-x'], 4000, NULL, NULL),
  ('b-j-ghost', :co::uuid, 'b-nobody', 'Trimming', 'Customer row missing, no estimate', '2026-12-21', 'scheduled',
   ARRAY['b-x'], 600, NULL, NULL),
  ('b-j-none', :co::uuid, 'b-res', 'Removal', 'Residential, no estimate', '2026-12-18', 'scheduled',
   ARRAY['b-x'], 300, NULL, NULL);
INSERT INTO public.audit_log (id, company_id, timestamp, entity, entity_id, field, old_value, new_value, job_id) VALUES
  ('b-al-his', :co::uuid, '2026-11-01', 'Job', 'b-j-his', 'value', '1400', '1500', 'b-j-his'),
  ('b-al-sam', :co::uuid, '2026-11-01', 'Job', 'b-j-sam', 'value', '700', '800', 'b-j-sam'),
  ('b-al-sam-t', :co::uuid, '2026-11-01', 'Job', 'b-j-sam', 'title', 'a', 'b', 'b-j-sam'),
  ('b-al-com', :co::uuid, '2026-11-01', 'Job', 'b-j-com', 'value', '4000', '5000', 'b-j-com'),
  ('b-al-com-t', :co::uuid, '2026-11-01', 'Job', 'b-j-com', 'title', 'a', 'b', 'b-j-com');

-- ---- Pat (crew login, job title Sales) ----
SELECT pg_temp.act_as(:pat::uuid);
SELECT results_eq(
  $$SELECT id, value, hourly_rate FROM public.app_jobs('b7b7b7b7-0000-4000-8000-0000000b0001') ORDER BY id$$,
  $$VALUES ('b-j-com'::text, NULL::numeric, NULL::numeric), ('b-j-comnone', NULL, NULL),
           ('b-j-comsam', NULL, NULL), ('b-j-ghost', NULL, NULL), ('b-j-his', 1500, 90),
           ('b-j-none', 300, NULL), ('b-j-old', 9000, NULL), ('b-j-sam', 800, NULL)$$,
  'Sales gets every job; money on residential ones, and on commercial ones only from his own estimates');
SELECT ok(public.job_money_visible('b7b7b7b7-0000-4000-8000-0000000b0001', ARRAY['b-x'], '2026-12-16', 'b-e-sam', 'b-res'),
  'job money: residential job, someone else''s estimate -> shown');
SELECT ok(public.job_money_visible('b7b7b7b7-0000-4000-8000-0000000b0001', ARRAY['b-x'], '2026-12-18', NULL, 'b-res'),
  'job money: residential job, no estimate -> shown');
SELECT ok(public.job_money_visible('b7b7b7b7-0000-4000-8000-0000000b0001', ARRAY['b-x'], '2026-12-15', 'b-e-jpcom', 'b-com'),
  'job money: commercial job from his estimate (old card) -> shown');
SELECT ok(NOT public.job_money_visible('b7b7b7b7-0000-4000-8000-0000000b0001', ARRAY['b-x'], '2026-12-19', 'b-e-comsam', 'b-com'),
  'job money: commercial job from someone else''s estimate -> hidden');
SELECT ok(NOT public.job_money_visible('b7b7b7b7-0000-4000-8000-0000000b0001', ARRAY['b-x'], '2026-12-20', NULL, 'b-com2'),
  'job money: commercial job with no estimate -> hidden');
SELECT ok(NOT public.job_money_visible('b7b7b7b7-0000-4000-8000-0000000b0001', ARRAY['b-x'], '2026-12-21', NULL, 'b-nobody'),
  'job money: customer row missing counts as commercial -> hidden');
SELECT results_eq($$SELECT id FROM public.audit_log WHERE id LIKE 'b-al-%' ORDER BY id$$,
  $$VALUES ('b-al-com-t'::text), ('b-al-his'), ('b-al-sam'), ('b-al-sam-t')$$,
  'history of his jobs: price changes except on the commercial job he did not estimate');
SELECT pg_temp.as_db();

-- ---- Pat with "see money": the same line ----
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'b-pat';
SELECT pg_temp.act_as(:pat::uuid);
SELECT is((SELECT count(*)::int FROM public.app_jobs('b7b7b7b7-0000-4000-8000-0000000b0001') WHERE value IS NOT NULL), 4,
  'the "see money" switch does not widen it for a Sales person');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = 'b-pat';

-- ---- The office: every job with money ----
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.app_jobs('b7b7b7b7-0000-4000-8000-0000000b0001') WHERE value IS NOT NULL), 8,
  'the office sees every job''s money');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE id LIKE 'b-al-%'), 5, 'and all their history');
SELECT pg_temp.as_db();

-- ---- Gus (Groundsman): unchanged ----
SELECT pg_temp.act_as(:gus::uuid);
SELECT results_eq($$SELECT id, value FROM public.app_jobs('b7b7b7b7-0000-4000-8000-0000000b0001')$$,
  $$VALUES ('b-j-his'::text, NULL::numeric)$$, 'a Groundsman: his job, no money');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'b-gus';
SELECT pg_temp.act_as(:gus::uuid);
SELECT results_eq($$SELECT id, value FROM public.app_jobs('b7b7b7b7-0000-4000-8000-0000000b0001')$$,
  $$VALUES ('b-j-his'::text, 1500::numeric)$$, 'with "see money": his job with its money');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = 'b-gus';

-- ---- Cal (Climber): as the "climber price change notes" rules has it, cost edits still checked ----
SELECT pg_temp.act_as(:cal::uuid);
SELECT results_eq($$SELECT id, value, labor_rate FROM public.app_jobs('b7b7b7b7-0000-4000-8000-0000000b0001') ORDER BY id$$,
  $$VALUES ('b-j-his'::text, 1500::numeric, NULL::numeric), ('b-j-sam', 800, NULL)$$,
  'a Climber without "see money": his jobs with their prices, not their costs');
SELECT throws_ok($$UPDATE public.jobs SET labor_rate = 30 WHERE id = 'b-j-his'$$, '42501',
  'Only people who can see money can change a job''s costs.', 'a Climber without "see money" cannot change costs');
SELECT lives_ok($$SELECT public.change_job_price('b-j-his', 1600, 90, NULL, 'Extra limb')$$,
  'he still changes the price, with a reason');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'b-cal';
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$UPDATE public.jobs SET labor_rate = 30 WHERE id = 'b-j-his'$$, 'with "see money" he changes costs');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
