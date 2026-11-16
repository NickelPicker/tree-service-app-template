-- The "money fixes" rules: a Climber's price replaces
-- the estimate's. change_job_price keeps the price it replaced
-- (replaced_price, the first one only); the office's changes leave it;
-- a Climber cannot change it directly, the office can clear it; crew
-- without "see money" get it blank; the automatic "Done" invoice bills
-- the Climber's price instead of the estimate's lines.
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

\set co   '''cdcdcdcd-0000-4000-8000-0000000b0001'''
\set cal  '''cdcdcdcd-1111-4000-8000-0000000b0001'''
\set gus  '''cdcdcdcd-1111-4000-8000-0000000b0002'''
\set desk '''cdcdcdcd-1111-4000-8000-0000000b0003'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Money Co');
SELECT pg_temp.signup(:cal::uuid, 'cal-money@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-money@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-money@example.com');
DELETE FROM public.company_members WHERE user_id IN (:cal::uuid, :gus::uuid, :desk::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:cal::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'), (:desk::uuid, :co::uuid, 'office');
UPDATE public.crew SET id = 'm-cal', name = 'Cal Climb', company_id = :co::uuid, status = 'active', role = 'Climber',
  permissions = '{}'::jsonb WHERE auth_user_id = :cal::uuid;
UPDATE public.crew SET id = 'm-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Groundsman',
  permissions = '{}'::jsonb WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'm-desk', name = 'Dee Desk', company_id = :co::uuid, status = 'active', role = 'Office'
  WHERE auth_user_id = :desk::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('m-c1', :co::uuid, 'Ann', 'A'), ('m-c2', :co::uuid, 'Ben', 'B');
-- Estimate: $1,000 of lines, 10% off, 8% tax = $972.
INSERT INTO public.estimates (id, company_id, customer_id, title, lines, tax_rate, discount_type, discount_value, status, created_date)
VALUES
  ('m-e1', :co::uuid, 'm-c1', 'Oak removal',
   '[{"id":"l1","description":"Remove oak","quantity":1,"unitPrice":800},{"id":"l2","description":"Grind stump","quantity":2,"unitPrice":100}]'::jsonb,
   8, 'percent', 10, 'accepted', '2026-11-01'),
  ('m-e2', :co::uuid, 'm-c2', 'Elm trim',
   '[{"id":"l1","description":"Trim elm","quantity":1,"unitPrice":400}]'::jsonb,
   0, 'none', 0, 'accepted', '2026-11-01');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id, value, billing_type) VALUES
  ('m-j1', :co::uuid, 'm-c1', 'Removal', 'Big oak', '2026-11-10', 'scheduled', ARRAY['m-cal', 'm-gus'], 'm-e1', NULL, 'flat'),
  ('m-j2', :co::uuid, 'm-c2', 'Trimming', 'Elm trim', '2026-11-10', 'scheduled', ARRAY['m-cal'], 'm-e2', NULL, 'flat');

-- ---------- 1-2: the estimate total ----------
SELECT is(public.estimate_active_total((SELECT e FROM public.estimates e WHERE id = 'm-e1')), 972.00::numeric,
  'estimate_active_total: lines minus discount plus tax, as the app');
SELECT is(public.job_price_before_change((SELECT j FROM public.jobs j WHERE id = 'm-j1')), 972.00::numeric,
  'a job priced by its estimate: the price before a change is the estimate''s total');

-- ---------- 3-7: the Climber changes the price ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$SELECT public.change_job_price('m-j1', 1200, NULL, 'flat', 'Second stump found')$$,
  'a Climber on the job changes the price with a reason');
SELECT results_eq($$SELECT value, replaced_price FROM public.app_jobs('cdcdcdcd-0000-4000-8000-0000000b0001') WHERE id = 'm-j1'$$,
  $$VALUES (1200::numeric, 972.00::numeric)$$,
  'the job keeps the estimate''s price as the replaced price, and he reads it');
SELECT lives_ok($$SELECT public.change_job_price('m-j1', 1300, NULL, 'flat', 'Third stump too')$$,
  'he changes it again');
SELECT is((SELECT replaced_price FROM public.app_jobs('cdcdcdcd-0000-4000-8000-0000000b0001') WHERE id = 'm-j1'), 972.00::numeric,
  'the replaced price stays the original one');
SELECT throws_ok($$UPDATE public.jobs SET replaced_price = NULL WHERE id = 'm-j1'$$, '42501', NULL,
  'he cannot change the replaced price directly');
SELECT pg_temp.as_db();

-- ---------- 8: a groundsman ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT replaced_price FROM public.app_jobs(:co::uuid) WHERE id = 'm-j1'), NULL::numeric,
  'a groundsman without see money gets the replaced price blank');
SELECT pg_temp.as_db();

-- ---------- 9-12: the office ----------
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$SELECT public.change_job_price('m-j2', 450, NULL, 'flat', NULL)$$,
  'the office changes another job''s price');
SELECT is((SELECT replaced_price FROM public.jobs WHERE id = 'm-j2'), NULL::numeric,
  'the office''s change does not replace the estimate''s price');
SELECT lives_ok($$UPDATE public.jobs SET replaced_price = NULL WHERE id = 'm-j1'$$,
  'the office may clear a replaced price (the estimate prices the job again)');
SELECT is((SELECT replaced_price FROM public.jobs WHERE id = 'm-j1'), NULL::numeric, 'and it is cleared');
SELECT pg_temp.as_db();

-- ---------- 13-17: the automatic Done invoice ----------
UPDATE public.jobs SET replaced_price = 972 WHERE id = 'm-j1';
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'm-j1'$$, 'the Climber marks his job done');
SELECT pg_temp.as_db();
SELECT results_eq(
  $$SELECT jsonb_array_length(lines), (lines -> 0 ->> 'unitPrice')::numeric, tax_rate, discount_type
      FROM public.invoices WHERE job_id = 'm-j1'$$,
  $$VALUES (1, 1300::numeric, 0::numeric, 'none'::text)$$,
  'the automatic invoice bills the Climber''s price (one line, no tax), not the estimate''s lines');
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'm-j2'$$, 'a job priced by its estimate is marked done');
SELECT pg_temp.as_db();
SELECT is((SELECT (lines -> 0 ->> 'unitPrice')::numeric FROM public.invoices WHERE job_id = 'm-j2'), 400::numeric,
  'its invoice still bills the estimate''s lines (the office change did not replace them)');
UPDATE public.jobs SET status = 'scheduled', invoice_id = NULL, value = NULL, replaced_price = 972 WHERE id = 'm-j1';
DELETE FROM public.invoices WHERE job_id = 'm-j1';
UPDATE public.jobs SET status = 'done' WHERE id = 'm-j1';
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'm-j1'), 'no_price',
  'with a replaced price but no value, the job goes to the review list');

-- ---------- 18-20: crew limits kept from the "rls tightening" rules (rls branch) ----------
INSERT INTO public.invoices (id, company_id, number, customer_id, lines, tax_rate, status, issued_date, due_date)
VALUES ('m-i-other', :co::uuid, 'INV-9001', 'm-c2', '[]'::jsonb, 0, 'unpaid', '2026-11-01', '2026-11-01');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id, value, billing_type) VALUES
  ('m-j4', :co::uuid, 'm-c2', 'Trimming', 'Maple trim', '2026-11-10', 'scheduled', ARRAY['m-cal', 'm-gus'], NULL, 300, 'flat');
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$UPDATE public.jobs SET invoice_id = 'm-i-other' WHERE id = 'm-j4'$$, '42501', NULL,
  'a Climber cannot link a job to an invoice');
SELECT throws_ok($$UPDATE public.jobs SET recurring = 'weekly' WHERE id = 'm-j4'$$, '42501', NULL,
  'a Climber cannot change a job''s repeat settings');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$UPDATE public.jobs SET status = 'cancelled' WHERE id = 'm-j4'$$, '42501', NULL,
  'crew can set only scheduled, in progress or done');
SELECT pg_temp.as_db();

-- ---------- 21-26: an estimate linked only by its job id ----------
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id, value, billing_type) VALUES
  ('m-j3', :co::uuid, 'm-c1', 'Removal', 'Pine removal', '2026-11-10', 'scheduled', ARRAY['m-cal', 'm-gus'], NULL, 500, 'flat');
INSERT INTO public.estimates (id, company_id, customer_id, job_id, title, lines, tax_rate, discount_type, discount_value, status, created_date)
VALUES ('m-e3', :co::uuid, 'm-c1', 'm-j3', 'Pine removal',
   '[{"id":"l1","description":"Remove pine","quantity":1,"unitPrice":800},{"id":"l2","description":"Grind stump","quantity":2,"unitPrice":100}]'::jsonb,
   8, 'percent', 10, 'accepted', '2026-11-01');
SELECT pg_temp.act_as(:gus::uuid);
SELECT is(public.crew_job_price_before_change('m-j3'), NULL::numeric,
  'a groundsman does not get the current price');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:cal::uuid);
SELECT is(public.crew_job_price_before_change('m-j3'), 972.00::numeric,
  'the Climber''s price box gets the estimate''s total (after discount and tax), the figure later struck');
SELECT lives_ok($$SELECT public.change_job_price('m-j3', 1200, NULL, 'flat', 'Bigger than quoted')$$,
  'the Climber changes the price of a job whose estimate points at it');
SELECT is((SELECT replaced_price FROM public.app_jobs('cdcdcdcd-0000-4000-8000-0000000b0001') WHERE id = 'm-j3'), 972.00::numeric,
  'the estimate''s total is the replaced price, not the job''s old value');
SELECT is(public.crew_job_price_before_change('m-j3'), NULL::numeric,
  'once replaced, the price box gets no current price');
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'm-j3'$$, 'he marks it done');
SELECT pg_temp.as_db();
SELECT results_eq(
  $$SELECT (lines -> 0 ->> 'unitPrice')::numeric, tax_rate FROM public.invoices WHERE job_id = 'm-j3'$$,
  $$VALUES (1200::numeric, 0::numeric)$$,
  'the automatic invoice bills the Climber''s price, not the estimate''s lines');

-- ---------- 28-31: the office uses the estimate's price again ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$SELECT public.clear_replaced_price('m-j3')$$, '42501', NULL,
  'a Climber cannot clear a replaced price');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$SELECT public.clear_replaced_price('m-j3')$$, 'the office clears it');
SELECT throws_ok($$SELECT public.clear_replaced_price('m-j3')$$, '22023', NULL,
  'clearing it again says there was nothing to clear');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE job_id = 'm-j3' AND field = 'replacedPrice' AND old_value = '972.00'), 1,
  'the clear is in the change history');

SELECT * FROM finish();
ROLLBACK;
