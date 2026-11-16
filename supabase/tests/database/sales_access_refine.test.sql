-- The "sales access refine" rules: a Sales login reads
-- residential estimates by anyone and commercial ones only when he
-- wrote them; nobody can forge who wrote an estimate; he sees every
-- job (office notes blank; no money on commercial jobs he did not estimate, the "sales job money" rules) through app_jobs, no
-- invoices, and changes no more jobs than before. A Groundsman and
-- another company are unchanged.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(43);

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

\set co    '''f5f5f5f5-0000-4000-8000-0000000f0001'''
\set other '''f5f5f5f5-0000-4000-8000-0000000f0002'''
\set pat    '''f5f5f5f5-1111-4000-8000-0000000f0001'''
\set gus   '''f5f5f5f5-1111-4000-8000-0000000f0002'''
\set desk  '''f5f5f5f5-1111-4000-8000-0000000f0003'''
\set xjp   '''f5f5f5f5-1111-4000-8000-0000000f0004'''
\set cal   '''f5f5f5f5-1111-4000-8000-0000000f0005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Refine Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:pat::uuid, 'pat-refine@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-refine@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-refine@example.com');
SELECT pg_temp.signup(:xjp::uuid, 'xjp-refine@example.com');
SELECT pg_temp.signup(:cal::uuid, 'cal-refine@example.com');
DELETE FROM public.company_members WHERE user_id IN (:pat::uuid, :gus::uuid, :desk::uuid, :xjp::uuid, :cal::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:pat::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'),
  (:desk::uuid, :co::uuid, 'office'), (:xjp::uuid, :other::uuid, 'crew'),
  (:cal::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 'r-pat', company_id = :co::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :pat::uuid;
UPDATE public.crew SET id = 'r-gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'r-desk', company_id = :co::uuid, status = 'active', role = 'Office' WHERE auth_user_id = :desk::uuid;
-- A Sales person of the other company.
UPDATE public.crew SET id = 'r-xjp', company_id = :other::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :xjp::uuid;
UPDATE public.crew SET id = 'r-cal', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :cal::uuid;
-- Pat's login also has an old, inactive Groundsman card (lower id): the
-- author is always his active Sales card.
INSERT INTO public.crew (id, company_id, auth_user_id, name, role, status)
  VALUES ('r-a-pat-old', :co::uuid, :pat::uuid, 'Pat (old card)', 'Groundsman', 'inactive');

INSERT INTO public.customers (id, company_id, first_name, last_name, customer_type) VALUES
  ('r-res', :co::uuid, 'Ann', 'Home', 'residential'),
  ('r-com', :co::uuid, 'Build', 'Corp', 'commercial'),
  ('r-x', :other::uuid, 'Xavier', 'Other', 'residential');
-- Written as the database: authors as given.
INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, created_by_crew_id) VALUES
  ('r-e-res-sam', :co::uuid, 'r-res', 'Oak by Sam', 'sent', '2026-11-01', 'r-sam'),
  ('r-e-res-old', :co::uuid, 'r-res', 'Old, no author', 'closed', '2026-10-01', NULL),
  ('r-e-com-sam', :co::uuid, 'r-com', 'Commercial bid by Sam', 'sent', '2026-11-01', 'r-sam'),
  ('r-e-com-old', :co::uuid, 'r-com', 'Old commercial bid', 'accepted', '2026-10-01', NULL),
  ('r-e-com-draft', :co::uuid, 'r-com', 'Commercial draft by Sam', 'draft', '2026-11-02', 'r-sam'),
  ('r-e-com-pat', :co::uuid, 'r-com', 'Commercial bid by Pat', 'closed', '2026-11-03', 'r-pat'),
  ('r-e-com-oldcard', :co::uuid, 'r-com', 'Commercial bid from Pat''s old card', 'sent', '2026-09-01', 'r-a-pat-old'),
  ('r-e-ghost', :co::uuid, 'r-nobody', 'Customer row missing', 'sent', '2026-11-01', 'r-sam'),
  ('r-e-x', :other::uuid, 'r-x', 'Other co', 'draft', '2026-11-01', NULL);
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids,
                         value, hourly_rate, office_notes) VALUES
  ('r-j1', :co::uuid, 'r-res', 'Removal', 'Big oak', '2026-12-14', 'scheduled', ARRAY['r-gus', 'r-cal'],
   1500, 90, 'He haggles'),
  ('r-j2', :co::uuid, 'r-com', 'Trimming', 'Site clearing', '2026-12-20', 'scheduled', ARRAY['r-x1'],
   8000, NULL, 'Retainage 10%'),
  -- Pat is on this one (both his cards), so its history reaches him.
  ('r-j3', :co::uuid, 'r-res', 'Removal', 'Pat helps', '2026-12-22', 'scheduled', ARRAY['r-pat', 'r-a-pat-old'],
   700, NULL, ''),
  ('r-jx', :other::uuid, 'r-x', 'Trimming', 'Other co job', '2026-12-14', 'scheduled', '{}',
   300, NULL, '');
INSERT INTO public.invoices (id, company_id, customer_id, number, issued_date, due_date, status)
  VALUES ('r-inv', :co::uuid, 'r-res', 'INV-R1', '2026-11-01', '2026-11-30', 'unpaid');
INSERT INTO public.audit_log (id, company_id, timestamp, entity, entity_id, field, old_value, new_value, job_id) VALUES
  ('r-al-inv', :co::uuid, '2026-11-01', 'Invoice', 'r-inv', 'status', 'unpaid', 'paid', 'r-j3'),
  ('r-al-com', :co::uuid, '2026-11-01', 'Estimate', 'r-e-com-sam', 'title', 'a', 'b', 'r-j3'),
  ('r-al-res', :co::uuid, '2026-11-01', 'Estimate', 'r-e-res-sam', 'title', 'a', 'b', 'r-j3'),
  ('r-al-job', :co::uuid, '2026-11-01', 'Job', 'r-j3', 'value', '600', '700', 'r-j3');

-- ---- Pat (crew login, job title Sales) ----
SELECT pg_temp.act_as(:pat::uuid);
SELECT results_eq(
  $$SELECT id FROM public.estimates ORDER BY id$$,
  $$VALUES ('r-e-com-oldcard'::text), ('r-e-com-pat'), ('r-e-res-old'), ('r-e-res-sam')$$,
  'Sales sees residential estimates by anyone (and old ones), commercial ones only his own (any of his cards)');
SELECT is_empty($$SELECT 1 FROM public.estimates WHERE id IN ('r-e-com-sam', 'r-e-com-old', 'r-e-com-draft')$$,
  'no commercial bid someone else (or nobody known) wrote');
SELECT is_empty($$SELECT 1 FROM public.estimates WHERE id = 'r-e-ghost'$$,
  'nor an estimate whose customer row is missing');
SELECT results_eq($$SELECT id FROM public.audit_log WHERE id LIKE 'r-al-%' ORDER BY id$$,
  $$VALUES ('r-al-job'::text), ('r-al-res')$$,
  'history of his job: the job and residential estimate entries, no commercial bid or invoice entries');
SELECT is((SELECT status FROM public.estimates WHERE id = 'r-e-com-pat'), 'closed',
  'he sees whether his bid was accepted or declined');
SELECT is((SELECT count(*)::int FROM public.customers), 2,
  'customers stay readable (autofill, the Schedule''s customer names), commercial included');
SELECT is((SELECT count(*)::int FROM public.invoices), 0, 'no invoices');
SELECT is_empty($$UPDATE public.estimates SET title = 'mine now' WHERE id = 'r-e-com-draft' RETURNING 1$$,
  'he cannot change a commercial draft someone else wrote');

-- Writing a commercial draft: he is its author whatever the app sends.
SELECT lives_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, created_by_crew_id)
  VALUES ('r-e-new', 'f5f5f5f5-0000-4000-8000-0000000f0001', 'r-com', 'Pat commercial draft', 'draft', '2026-11-17', 'r-sam')
  ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title$$,
  'Sales adds a commercial draft (claiming someone else wrote it)');
SELECT is((SELECT created_by_crew_id FROM public.estimates WHERE id = 'r-e-new'), 'r-pat',
  'the database records him as the author, not the forged one');
SELECT lives_ok($$UPDATE public.estimates SET created_by_crew_id = 'r-sam', title = 'Pat draft v2' WHERE id = 'r-e-new'$$,
  'an edit that tries to change the author saves');
SELECT is((SELECT created_by_crew_id || ' ' || title FROM public.estimates WHERE id = 'r-e-new'), 'r-pat Pat draft v2',
  'but the author stays');
SELECT lives_ok($$UPDATE public.estimates SET created_by_crew_id = 'r-pat' WHERE id = 'r-e-res-old'$$,
  'claiming an old estimate does nothing either');
SELECT is((SELECT count(*)::int FROM public.estimates WHERE created_by_crew_id = 'r-pat'), 2,
  'he still has exactly his two estimates');

-- Jobs: every job of the company; office notes blank. Since
-- the "sales job money" rules no money on a commercial job he did not estimate
-- (pat_estimates_backfill.test.sql covers the rule in full).
SELECT results_eq(
  $$SELECT id, value, hourly_rate, coalesce(office_notes, '') FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0001') ORDER BY id$$,
  $$VALUES ('r-j1'::text, 1500::numeric, 90::numeric, ''::text), ('r-j2', NULL, NULL, ''), ('r-j3', 700, NULL, '')$$,
  'Sales gets every job of the company, without office notes; money except on the commercial job he did not estimate');
SELECT ok(NOT public.job_money_visible('f5f5f5f5-0000-4000-8000-0000000f0001', ARRAY['r-x1'], '2026-12-20', NULL, 'r-com'),
  'no job money for a Sales person on a commercial job without his estimate');
SELECT results_eq($$SELECT id FROM public.jobs$$, $$VALUES ('r-j3'::text)$$,
  'the jobs table itself is not widened: only the job he is on (no office notes from a direct read)');
SELECT is_empty($$UPDATE public.jobs SET status = 'done' WHERE id = 'r-j1' RETURNING 1$$,
  'he cannot change a job he is not on');
SELECT is((SELECT count(*)::int FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0002')), 0,
  'no jobs of another company');
SELECT ok(NOT public.sales_can_read_estimate('f5f5f5f5-0000-4000-8000-0000000f0002', 'r-x', NULL),
  'no estimates of another company');
SELECT pg_temp.as_db();

-- ---- The office: authors recorded and kept for them too ----
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.estimates), 9, 'the office still sees every estimate');
SELECT lives_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, created_by_crew_id)
  VALUES ('r-e-desk', 'f5f5f5f5-0000-4000-8000-0000000f0001', 'r-res', 'Office estimate', 'draft', '2026-11-17', 'r-pat')$$,
  'the office adds an estimate claiming Pat wrote it');
SELECT is((SELECT created_by_crew_id FROM public.estimates WHERE id = 'r-e-desk'), 'r-desk',
  'it is recorded as the office person''s');
SELECT lives_ok($$INSERT INTO public.estimates (id, company_id, customer_id, title, status, created_date, created_by_crew_id)
  VALUES ('r-e-com-pat', 'f5f5f5f5-0000-4000-8000-0000000f0001', 'r-com', 'Commercial bid by Pat', 'closed', '2026-11-03', 'r-desk')
  ON CONFLICT (id) DO UPDATE SET created_by_crew_id = EXCLUDED.created_by_crew_id, title = EXCLUDED.title$$,
  'an office upsert of Pat''s estimate saves');
SELECT is((SELECT created_by_crew_id FROM public.estimates WHERE id = 'r-e-com-pat'), 'r-pat',
  'and Pat stays its author');
SELECT is((SELECT count(*)::int FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0001') WHERE office_notes <> ''), 2,
  'the office still gets office notes');
SELECT pg_temp.as_db();

-- ---- Gus (crew login, Groundsman): unchanged ----
SELECT pg_temp.act_as(:gus::uuid);
SELECT results_eq(
  $$SELECT id, value, coalesce(office_notes, '') FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0001') ORDER BY id$$,
  $$VALUES ('r-j1'::text, NULL::numeric, ''::text)$$,
  'a Groundsman still gets only his own job, without money or office notes');
SELECT ok(NOT public.job_money_visible('f5f5f5f5-0000-4000-8000-0000000f0001', ARRAY['r-gus'], '2026-12-14', NULL, 'r-res'),
  'no job money for a Groundsman');
SELECT is((SELECT count(*)::int FROM public.estimates) + (SELECT count(*)::int FROM public.invoices), 0,
  'a Groundsman sees no estimates or invoices');
SELECT ok(NOT public.sales_can_read_estimate('f5f5f5f5-0000-4000-8000-0000000f0001', 'r-res', NULL),
  'and is not a Sales person');
SELECT pg_temp.as_db();

-- ---- The other company's Sales person ----
SELECT pg_temp.act_as(:xjp::uuid);
SELECT results_eq($$SELECT id FROM public.estimates$$, $$VALUES ('r-e-x'::text)$$,
  'another company''s Sales person sees only his company''s estimates');
SELECT results_eq($$SELECT id FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0002')$$, $$VALUES ('r-jx'::text)$$,
  'and only his company''s jobs');
SELECT is((SELECT count(*)::int FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0001')), 0,
  'none of this company''s');
SELECT pg_temp.as_db();

-- ---- Pat with "see money" and "see all customers" switched on ----
UPDATE public.crew SET permissions = '{"seeMoney": true, "seeAllCustomers": true}'::jsonb WHERE id = 'r-pat';
SELECT pg_temp.act_as(:pat::uuid);
SELECT is_empty($$SELECT 1 FROM public.estimates WHERE id IN ('r-e-com-sam', 'r-e-com-old', 'r-e-com-draft', 'r-e-ghost')$$,
  'with the switches on, still no commercial bids by others');
SELECT is((SELECT count(*)::int FROM public.estimates), 6,
  'he sees the same estimates as without the switches (plus the two new drafts)');
SELECT is((SELECT count(*)::int FROM public.invoices), 0, 'and no invoices whatever his switches');
SELECT results_eq($$SELECT id FROM public.audit_log WHERE id LIKE 'r-al-%' ORDER BY id$$,
  $$VALUES ('r-al-job'::text), ('r-al-res')$$,
  'and no invoice or commercial-bid history');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = 'r-pat';

-- ---- A Groundsman with "see money": the Sales ceiling does not touch him ----
UPDATE public.crew SET permissions = '{"seeMoney": true}'::jsonb WHERE id = 'r-gus';
SELECT pg_temp.act_as(:gus::uuid);
SELECT results_eq($$SELECT id FROM public.invoices$$, $$VALUES ('r-inv'::text)$$,
  'crew with "see money" still see invoices of their jobs'' customers');
SELECT results_eq($$SELECT id FROM public.estimates ORDER BY id$$,
  $$VALUES ('r-e-desk'::text), ('r-e-res-old'), ('r-e-res-sam')$$,
  'and those customers'' estimates');
SELECT pg_temp.as_db();
UPDATE public.crew SET permissions = '{}'::jsonb WHERE id = 'r-gus';

-- ---- A Climber without "see money": his job, with its prices since the "climber price change notes" rules ----
SELECT pg_temp.act_as(:cal::uuid);
SELECT results_eq(
  $$SELECT id, value, hourly_rate FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0001') ORDER BY id$$,
  $$VALUES ('r-j1'::text, 1500::numeric, 90::numeric)$$,
  'a Climber without "see money" gets his job with its prices (not its costs: climber_price_change_notes)');
SELECT is((SELECT count(*)::int FROM public.estimates) + (SELECT count(*)::int FROM public.invoices), 0,
  'and no estimates or invoices');
SELECT ok(NOT public.job_money_visible('f5f5f5f5-0000-4000-8000-0000000f0001', ARRAY['r-cal'], '2026-12-14', NULL, 'r-res'),
  'no job money for him');
SELECT pg_temp.as_db();

-- ---- Pat marked inactive: back to plain crew ----
UPDATE public.crew SET status = 'inactive' WHERE id = 'r-pat';
SELECT pg_temp.act_as(:pat::uuid);
SELECT results_eq($$SELECT id, value FROM public.app_jobs('f5f5f5f5-0000-4000-8000-0000000f0001')$$,
  $$VALUES ('r-j3'::text, NULL::numeric)$$,
  'an inactive Sales person gets only his own job again, without its money');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
