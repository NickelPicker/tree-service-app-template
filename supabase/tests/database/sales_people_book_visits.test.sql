-- The "sales people book visits" rules: a crew login
-- whose job title is Sales reads customers and estimates, adds
-- customers, adds and changes DRAFT estimates (book/move the visit,
-- write the quote). A Groundsman still can't; nothing else widens.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(31);

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
\set other '''eeeeeeee-0000-4000-8000-0000000e0002'''
\set pat  '''eeeeeeee-1111-4000-8000-0000000e0001'''
\set gus '''eeeeeeee-1111-4000-8000-0000000e0002'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Sales Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:pat::uuid, 'pat-sales-test@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-sales-test@example.com');
DELETE FROM public.company_members WHERE user_id IN (:pat::uuid, :gus::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:pat::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'e-pat', company_id = :co::uuid, status = 'active', role = 'sales ' WHERE auth_user_id = :pat::uuid;
UPDATE public.crew SET id = 'e-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('e-c1', :co::uuid, 'Ann', 'Smith'),
  ('e-x1', :other::uuid, 'Xavier', 'Other');
INSERT INTO public.customer_addresses (id, company_id, customer_id, label, street, is_primary)
  VALUES ('e-a1', :co::uuid, 'e-c1', 'Home', '1 Elm St', true);
INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date) VALUES
  ('e-draft', :co::uuid, 'e-c1', 'Oak removal', 'draft', '2026-11-10'),
  ('e-sent', :co::uuid, 'e-c1', 'Hedge', 'sent', '2026-11-01'),
  ('e-x', :other::uuid, 'e-x1', 'Other co', 'draft', '2026-11-01');
INSERT INTO public.invoices (id, company_id, customer_id, number, issued_date, due_date, status)
  VALUES ('e-inv', :co::uuid, 'e-c1', 'INV-E1', '2026-11-01', '2026-11-30', 'unpaid');

-- ---- Pat (crew login, job title Sales) ----
SELECT pg_temp.act_as(:pat::uuid);
SELECT ok(public.is_sales_person(:co::uuid), 'a crew login titled Sales (any case, spaces) is a Sales person');
SELECT ok(NOT public.is_sales_person(:other::uuid), 'only in their own company');
SELECT is((SELECT count(*)::int FROM public.customers), 1, 'Sales sees the company''s customers, not another company''s');
SELECT is((SELECT count(*)::int FROM public.customer_addresses), 1, 'and their addresses');
SELECT is((SELECT count(*)::int FROM public.estimates), 2, 'and every estimate of the company''s residential customers (the "sales access refine" rules)');
SELECT is((SELECT count(*)::int FROM public.invoices), 0, 'but no invoices');

-- The app saves new rows with an upsert.
SELECT lives_ok($$INSERT INTO public.customers (id, company_id, first_name, last_name, phone)
  VALUES ('e-new', 'eeeeeeee-0000-4000-8000-0000000e0001', 'Ben', 'New', '555-555-0100')
  ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name$$,
  'Sales adds a customer');
SELECT lives_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, visit_date, visit_time)
  VALUES ('e-new-est', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-new', 'Maple prune', 'draft', '2026-11-16', '2026-11-17', '09:30')
  ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title$$,
  'Sales adds a draft estimate with a visit');
SELECT throws_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date)
  VALUES ('e-acc', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-new', 'x', 'accepted', '2026-11-16')$$,
  '42501', NULL, 'but not an accepted one');
SELECT throws_ok($$INSERT INTO public.customers (id, company_id, first_name)
  VALUES ('e-new2', 'eeeeeeee-0000-4000-8000-0000000e0002', 'Wrong co')$$,
  '42501', NULL, 'and not into another company');

SELECT lives_ok($$UPDATE public.estimates SET visit_date = '2026-11-18', visit_time = '13:00' WHERE id = 'e-draft'$$,
  'Sales moves a visit');
SELECT lives_ok($$UPDATE public.estimates SET lines = '[{"id":"l1","description":"Remove oak","quantity":1,"unitPrice":1200}]'::jsonb WHERE id = 'e-draft'$$,
  'and writes the draft estimate');
SELECT throws_ok($$UPDATE public.estimates SET status = 'accepted' WHERE id = 'e-draft'$$,
  '42501', NULL, 'but cannot mark it accepted');
SELECT is_empty($$UPDATE public.estimates SET visit_date = '2026-11-20' WHERE id = 'e-sent' RETURNING 1$$,
  'nor change an estimate that is no longer a draft');
SELECT is_empty($$DELETE FROM public.estimates WHERE id = 'e-draft' RETURNING 1$$,
  'nor delete estimates');
SELECT is_empty($$UPDATE public.customers SET phone = '000' WHERE id = 'e-c1' RETURNING 1$$,
  'nor change existing customers');
SELECT is_empty($$DELETE FROM public.customers WHERE id = 'e-c1' RETURNING 1$$,
  'nor delete customers');
SELECT throws_ok($$UPDATE public.estimates SET email_queued_at = '2026-11-16T10:00:00Z' WHERE id = 'e-draft'$$,
  '42501', NULL, 'nor queue a draft for emailing');
SELECT throws_ok($$UPDATE public.estimates SET job_id = 'any-job' WHERE id = 'e-draft'$$,
  '42501', NULL, 'nor link a draft to a job');
SELECT throws_ok($$UPDATE public.estimates SET customer_id = 'e-x1' WHERE id = 'e-draft'$$,
  '42501', NULL, 'nor point a draft at another customer');
SELECT throws_ok($$UPDATE public.estimates SET company_id = 'eeeeeeee-0000-4000-8000-0000000e0002' WHERE id = 'e-draft'$$,
  '42501', NULL, 'nor move a draft to another company');
SELECT throws_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date)
  VALUES ('e-cross', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-x1', 'x', 'draft', '2026-11-16')$$,
  '42501', NULL, 'nor add an estimate for another company''s customer');
SELECT throws_ok($$UPDATE public.crew SET role = 'Groundsman' WHERE id = 'e-pat'$$,
  '42501', NULL, 'and a crew login still cannot change its own job title');
SELECT pg_temp.as_db();
SELECT is((SELECT visit_date || ' ' || visit_time FROM public.estimates WHERE id = 'e-draft'), '2026-11-18 13:00',
  'the move saved');
SELECT is((SELECT status FROM public.estimates WHERE id = 'e-draft'), 'draft', 'still a draft');

-- ---- An inactive Sales person loses it ----
UPDATE public.crew SET status = 'inactive' WHERE id = 'e-pat';
SELECT pg_temp.act_as(:pat::uuid);
SELECT ok(NOT public.is_sales_person(:co::uuid), 'a Sales person marked inactive is no longer a Sales person');
SELECT is((SELECT count(*)::int FROM public.estimates), 0, 'and no longer sees estimates');
SELECT pg_temp.as_db();
UPDATE public.crew SET status = 'active' WHERE id = 'e-pat';

-- ---- Gus (crew login, Groundsman): unchanged ----
SELECT pg_temp.act_as(:gus::uuid);
SELECT ok(NOT public.is_sales_person(:co::uuid), 'a Groundsman is not a Sales person');
SELECT is((SELECT count(*)::int FROM public.customers) + (SELECT count(*)::int FROM public.estimates), 0,
  'a Groundsman (no jobs, no switches) sees no customers or estimates');
SELECT throws_ok($$INSERT INTO public.customers (id, company_id, first_name)
  VALUES ('e-gus-c', 'eeeeeeee-0000-4000-8000-0000000e0001', 'Nope')$$,
  '42501', NULL, 'a Groundsman cannot add customers');
SELECT throws_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date)
  VALUES ('e-gus-e', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-c1', 'Nope', 'draft', '2026-11-16')$$,
  '42501', NULL, 'nor estimates');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
