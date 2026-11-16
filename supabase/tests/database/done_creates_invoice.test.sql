-- The "done creates invoice" rules: marking a job done
-- makes its invoice (or a "Needs invoice review" item), the automatic
-- email after the 2-hour grace period and everything that stops it.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(54);

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
CREATE FUNCTION pg_temp.today() RETURNS text LANGUAGE sql AS $$
  SELECT to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD') $$;

\set co    '''aaaaaaaa-0000-4000-8000-0000000d0e01'''
\set other '''aaaaaaaa-0000-4000-8000-0000000d0e02'''
\set boss  '''bbbbbbbb-0000-4000-8000-0000000d0e01'''
\set desk  '''bbbbbbbb-0000-4000-8000-0000000d0e02'''
\set gus   '''bbbbbbbb-0000-4000-8000-0000000d0e03'''
\set far   '''bbbbbbbb-0000-4000-8000-0000000d0e04'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Done Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:boss::uuid, 'boss-done@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-done@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-done@example.com');
SELECT pg_temp.signup(:far::uuid, 'far-done@example.com');
DELETE FROM public.company_members WHERE user_id IN (:boss::uuid, :desk::uuid, :gus::uuid, :far::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:boss::uuid, :co::uuid, 'manager'), (:desk::uuid, :co::uuid, 'office'),
  (:gus::uuid, :co::uuid, 'crew'), (:far::uuid, :other::uuid, 'office');
UPDATE public.crew SET id = 'gus', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :gus::uuid;
INSERT INTO public.settings (company_id, commercial_terms_days, residential_terms_days)
VALUES (:co::uuid, 30, 0) ON CONFLICT (company_id) DO UPDATE SET commercial_terms_days = 30, residential_terms_days = 0;

INSERT INTO public.customers (id, company_id, first_name, email, customer_type) VALUES
  ('dc-res', :co::uuid, 'Rae', 'rae@example.com', 'residential'),
  ('dc-com', :co::uuid, 'Cal', 'cal@example.com', 'commercial'),
  ('dc-none', :co::uuid, 'Noe', '', 'residential');

INSERT INTO public.estimates (id, company_id, customer_id, title, lines, options, accepted_option_id, status, created_date, tax_rate) VALUES
  ('dc-e1', :co::uuid, 'dc-res', 'Maple', '[{"id":"l0","description":"Base","quantity":1,"unitPrice":100}]',
   '[{"id":"good","label":"Good","lines":[{"id":"l1","description":"Prune","quantity":1,"unitPrice":800}]},
     {"id":"best","label":"Best","lines":[{"id":"l2","description":"Prune + cable","quantity":2,"unitPrice":600}]}]',
   'best', 'accepted', '2026-11-01', 8),
  ('dc-e2', :co::uuid, 'dc-com', 'Oak', '[{"id":"l1","description":"Remove","quantity":1,"unitPrice":2000}]', NULL, NULL, 'accepted', '2026-11-01', 0),
  ('dc-e3', :co::uuid, 'dc-res', 'Draft', '[{"id":"l1","description":"x","quantity":1,"unitPrice":50}]', NULL, NULL, 'sent', '2026-11-01', 0),
  ('dc-e4', :co::uuid, 'dc-res', 'Free', '[{"id":"l1","description":"x","quantity":1,"unitPrice":0}]', NULL, NULL, 'accepted', '2026-11-01', 0),
  ('dc-e5', :co::uuid, 'dc-res', 'Ash', '[{"id":"l1","description":"Remove","quantity":1,"unitPrice":900}]', NULL, NULL, 'accepted', '2026-11-01', 0),
  ('dc-e6', :co::uuid, 'dc-none', 'Elm', '[{"id":"l1","description":"Remove","quantity":1,"unitPrice":400}]', NULL, NULL, 'accepted', '2026-11-01', 0);

INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id,
                         billing_type, materials_cost, end_date) VALUES
  ('dc-j1', :co::uuid, 'dc-res', 'Pruning', 'Maple prune', pg_temp.today(), 'in_progress', ARRAY['gus'], 'dc-e1', NULL, NULL, NULL),
  ('dc-j2', :co::uuid, 'dc-com', 'Removal', 'Oak removal', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e2', 'flat', NULL, NULL),
  ('dc-hr', :co::uuid, 'dc-res', 'Pruning', 'Hourly', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e5', 'hourly', NULL, NULL),
  ('dc-mc', :co::uuid, 'dc-res', 'Pruning', 'Materials', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e5', NULL, 120, NULL),
  ('dc-md', :co::uuid, 'dc-res', 'Removal', 'Two days', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e5', NULL, NULL,
   to_char((pg_temp.today())::date + 1, 'YYYY-MM-DD')),
  ('dc-ne', :co::uuid, 'dc-res', 'Pruning', 'No estimate', pg_temp.today(), 'scheduled', ARRAY['gus'], NULL, NULL, NULL, NULL),
  ('dc-ns', :co::uuid, 'dc-res', 'Pruning', 'Not accepted', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e3', NULL, NULL, NULL),
  ('dc-zp', :co::uuid, 'dc-res', 'Pruning', 'Zero', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e4', NULL, NULL, NULL),
  ('dc-j3', :co::uuid, 'dc-res', 'Removal', 'Ash removal', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e5', NULL, NULL, NULL),
  ('dc-j4', :co::uuid, 'dc-none', 'Removal', 'Elm removal', pg_temp.today(), 'scheduled', ARRAY['gus'], 'dc-e6', NULL, NULL, NULL);

-- 1-6: structure and safe defaults
SELECT has_table('public', 'invoice_reviews', 'invoice_reviews exists');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_reviews'::regclass), true, 'invoice_reviews has RLS on');
SELECT col_default_is('public', 'invoices', 'auto_created', 'false', 'invoices are not automatic unless the database made them');
SELECT is((SELECT count(*)::int FROM public.invoices WHERE auto_send_status IS NOT NULL), 0, 'no invoice is waiting to be emailed after the migration');
SELECT is((SELECT count(*)::int FROM public.automations WHERE kind = 'invoice_send' AND enabled), 0, 'Auto-send invoices is off (no rule row)');
SELECT is(has_table_privilege('authenticated', 'public.invoice_reviews', 'INSERT'), false, 'app users cannot add review items');

-- 7-15: a crew tap on Done makes the invoice from the accepted option
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 'dc-j1'$$, 'a Climber can mark his job done (groundsmen cannot: crew_phone_rules)');
SELECT pg_temp.as_db();
SELECT isnt((SELECT invoice_id FROM public.jobs WHERE id = 'dc-j1'), NULL, 'the job is linked to a new invoice');
SELECT is((SELECT lines FROM public.invoices WHERE job_id = 'dc-j1'),
  '[{"id":"l2","description":"Prune + cable","quantity":2,"unitPrice":600}]'::jsonb, 'the invoice has the accepted option''s lines');
SELECT is((SELECT (tax_rate, estimate_id, status, auto_created)::text FROM public.invoices WHERE job_id = 'dc-j1'),
  '(8,dc-e1,unpaid,t)', 'tax, estimate, unpaid, automatic');
SELECT is((SELECT number FROM public.invoices WHERE job_id = 'dc-j1'), 'INV-1001', 'numbered like the app (INV-1001 first)');
SELECT is((SELECT (issued_date, due_date)::text FROM public.invoices WHERE job_id = 'dc-j1'),
  format('(%s,%s)', pg_temp.today(), pg_temp.today()), 'residential: issued today, due on receipt');
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'dc-j1'), NULL,
  'with the switches off the invoice is NOT scheduled for email');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE job_id = 'dc-j1' AND actor = 'Automatic (job marked done)'), 2,
  'the invoice and the job link are in the history');
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT status FROM public.jobs WHERE id = 'dc-j1'), 'done', 'the crew member still sees his job done');
SELECT pg_temp.as_db();

-- 16-17: commercial terms; numbering goes on
UPDATE public.jobs SET status = 'done' WHERE id = 'dc-j2';
SELECT is((SELECT due_date FROM public.invoices WHERE job_id = 'dc-j2'),
  to_char(pg_temp.today()::date + 30, 'YYYY-MM-DD'), 'commercial: due after 30 days');
SELECT is((SELECT number FROM public.invoices WHERE job_id = 'dc-j2'), 'INV-1002', 'next number');

-- 18-25: jobs that need a person go to the review list instead
UPDATE public.jobs SET status = 'done' WHERE id IN ('dc-hr', 'dc-mc', 'dc-md', 'dc-ne', 'dc-ns', 'dc-zp');
SELECT is((SELECT count(*)::int FROM public.invoices WHERE job_id IN ('dc-hr', 'dc-mc', 'dc-md', 'dc-ne', 'dc-ns', 'dc-zp')), 0,
  'none of them got an invoice');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'dc-hr'), 'hourly', 'hourly billing -> review');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'dc-mc'), 'extra_costs', 'materials cost -> review');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'dc-md'), 'multi_day', 'multi-day job before its last day -> review');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'dc-ne'), 'no_estimate', 'no estimate -> review');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'dc-ns'), 'no_estimate', 'estimate not accepted -> review');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 'dc-zp'), 'no_price', '$0 estimate -> review');
-- The office worked on the invoice, so reopening keeps it (an untouched
-- one inside the grace period is removed: undo_done_removes_fresh_invoice).
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET discount_type = 'fixed', discount_value = 10 WHERE job_id = 'dc-j2';
SELECT pg_temp.as_db();
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'dc-j2';
UPDATE public.jobs SET status = 'done' WHERE id = 'dc-j2';
SELECT is((SELECT (reason, (SELECT count(*) FROM public.invoices WHERE job_id = 'dc-j2'))::text FROM public.invoice_reviews WHERE job_id = 'dc-j2'),
  '(has_invoice,1)', 'done again with an invoice already made -> review, no second invoice');

-- 26-31: who sees and clears the review list
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE company_id = :co::uuid), 7, 'the office sees the review list');
SELECT throws_ok($$INSERT INTO public.invoice_reviews (company_id, job_id, reason) VALUES ('aaaaaaaa-0000-4000-8000-0000000d0e01', 'dc-j3', 'hourly')$$,
  '42501', NULL, 'the office cannot add review items by hand');
DELETE FROM public.invoice_reviews WHERE job_id = 'dc-ns';
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE job_id = 'dc-ns'), 0, 'the office can dismiss an item');
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.invoice_reviews), 0, 'crew see no review items');
DELETE FROM public.invoice_reviews;
SELECT pg_temp.act_as(:far::uuid);
SELECT is((SELECT count(*)::int FROM public.invoice_reviews), 0, 'another company sees none');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE company_id = :co::uuid), 6, 'crew could delete nothing');
-- An invoice made by hand settles the item.
INSERT INTO public.invoices (id, company_id, number, customer_id, job_id, status, issued_date, due_date)
VALUES ('dc-inv-hr', :co::uuid, 'INV-1003', 'dc-res', 'dc-hr', 'unpaid', pg_temp.today(), pg_temp.today());
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE job_id = 'dc-hr'), 0, 'an invoice for the job removes it from the list');

-- 32-36: switches on -> the invoice waits 2 hours, then can be emailed
UPDATE public.settings SET auto_emails = true WHERE company_id = :co::uuid;
INSERT INTO public.automations (id, company_id, kind, label, enabled, template)
VALUES ('dc-rule', :co::uuid, 'invoice_send', 'Auto-send invoices', true, 'Hi {customer}');
UPDATE public.jobs SET status = 'done' WHERE id = 'dc-j3';
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'dc-j3'), 'waiting', 'switches on: the invoice waits to be emailed');
SELECT ok((SELECT auto_send_at BETWEEN now() + interval '119 minutes' AND now() + interval '121 minutes' FROM public.invoices WHERE job_id = 'dc-j3'),
  'it is emailed after a 2-hour grace period');
SELECT is(public.auto_invoice_send_claim((SELECT id FROM public.invoices WHERE job_id = 'dc-j3')), false,
  'it cannot be claimed during the grace period');
UPDATE public.jobs SET status = 'done' WHERE id = 'dc-j4';
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'dc-j4'), NULL, 'a customer with no email is not scheduled');
UPDATE public.customers SET no_auto_emails = true WHERE id = 'dc-res';
UPDATE public.jobs SET status = 'scheduled', invoice_id = NULL WHERE id = 'dc-ns';
UPDATE public.estimates SET status = 'accepted' WHERE id = 'dc-e3';
UPDATE public.jobs SET status = 'done' WHERE id = 'dc-ns';
SELECT is((SELECT (auto_created, auto_send_status)::text FROM public.invoices WHERE job_id = 'dc-ns'), '(t,)',
  '"No automatic emails" customer: invoice made, not scheduled');
UPDATE public.customers SET no_auto_emails = false WHERE id = 'dc-res';

-- 37-43: what stops it, and what app users cannot do
UPDATE public.invoices SET auto_send_at = now() - interval '1 minute' WHERE job_id = 'dc-j3';
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET status = status, lines = lines WHERE job_id = 'dc-j3';
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'dc-j3'), 'waiting', 'an unchanged save does not stop it');
UPDATE public.invoices SET auto_send_at = now() - interval '9 hours', auto_sent_at = now() WHERE job_id = 'dc-j3';
SELECT pg_temp.as_db();
SELECT ok((SELECT auto_send_at > now() - interval '2 minutes' AND auto_sent_at IS NULL FROM public.invoices WHERE job_id = 'dc-j3'),
  'the office cannot move the send time or mark it sent');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET lines = '[{"id":"x","description":"Fixed","quantity":1,"unitPrice":850}]' WHERE job_id = 'dc-j3';
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE job_id = 'dc-j3'), '(stopped,edited)',
  'editing the invoice cancels the automatic email');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET auto_send_status = 'waiting' WHERE job_id = 'dc-j3';
SELECT pg_temp.as_db();
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'dc-j3'), 'stopped', 'the office cannot restart it');
-- Stop button
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL WHERE job_id = 'dc-j3';
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET auto_send_status = 'stopped' WHERE job_id = 'dc-j3';
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE job_id = 'dc-j3'), '(stopped,stopped)',
  '"Stop" on the invoice cancels it');
-- Reopen
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL WHERE job_id = 'dc-j3';
SELECT pg_temp.act_as(:gus::uuid);
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'dc-j3';
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE job_id = 'dc-j3'), '(stopped,reopened)',
  'reopening the job cancels it');
SELECT is((SELECT count(*)::int FROM public.invoices WHERE job_id = 'dc-j3'), 1, 'and keeps the invoice for the office');
-- Office makes another invoice by hand
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL WHERE job_id = 'dc-j3';
SELECT pg_temp.act_as(:desk::uuid);
INSERT INTO public.invoices (id, company_id, number, customer_id, job_id, status, issued_date, due_date, auto_created, auto_send_status, auto_send_at)
VALUES ('dc-inv-hand', :co::uuid, 'INV-1099', 'dc-res', 'dc-j3', 'unpaid', pg_temp.today(), pg_temp.today(), true, 'waiting', now());
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_created, auto_send_status)::text FROM public.invoices WHERE id = 'dc-inv-hand'), '(f,)',
  'an invoice made in the app can never schedule itself');

-- 44-45
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE job_id = 'dc-j3' AND auto_created), '(stopped,another-invoice)',
  'another invoice for the job cancels the automatic one');
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL WHERE job_id = 'dc-j3' AND auto_created;
DELETE FROM public.jobs WHERE id = 'dc-j3';
SELECT is((SELECT auto_send_note FROM public.invoices WHERE id = (SELECT id FROM public.invoices WHERE estimate_id = 'dc-e5' AND auto_created)), 'job-deleted',
  'deleting the job cancels it');

-- 46-52: the runner's functions (service role only)
SELECT is(has_function_privilege('authenticated', 'public.auto_invoice_send_claim(text)', 'EXECUTE'), false, 'app users cannot claim a send');
SELECT is(has_function_privilege('authenticated', 'public.auto_invoice_send_finish(text, text, text)', 'EXECUTE'), false, 'app users cannot finish a send');
SELECT is(has_function_privilege('authenticated', 'public.invoice_for_done_job(public.jobs)', 'EXECUTE'), false, 'app users cannot call the invoice maker');
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL, auto_send_at = now() - interval '5 minutes'
 WHERE estimate_id = 'dc-e5' AND auto_created;
SELECT is(public.auto_invoice_send_claim((SELECT id FROM public.invoices WHERE estimate_id = 'dc-e5' AND auto_created)), true, 'a due invoice is claimed once');
SELECT is(public.auto_invoice_send_claim((SELECT id FROM public.invoices WHERE estimate_id = 'dc-e5' AND auto_created)), false, '... and not twice');
SELECT public.auto_invoice_send_finish((SELECT id FROM public.invoices WHERE estimate_id = 'dc-e5' AND auto_created), 'sent');
SELECT ok((SELECT auto_send_status = 'sent' AND auto_sent_at IS NOT NULL FROM public.invoices WHERE estimate_id = 'dc-e5' AND auto_created),
  'finishing marks it sent with the time');
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL, auto_send_at = now() - interval '5 minutes', auto_sent_at = NULL
 WHERE job_id = 'dc-j1';
SELECT is(public.auto_invoice_stop_unsendable(:co::uuid, false), 1, 'switched off: due invoices are stopped, not sent later');

SELECT * FROM finish();
ROLLBACK;
