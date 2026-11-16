-- Migrations the "automatic emails hidden from crew without money" rules (automatic emails hidden from crew without
-- "see money"), the "undo done removes fresh invoice" rules (Done, then Undo removes the untouched
-- automatic invoice) and the "unique invoice numbers" rules (unique invoice numbers).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(32);

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

\set co    '''dddddddd-0000-4000-8000-0000000f0001'''
\set other '''dddddddd-0000-4000-8000-0000000f0002'''
\set desk  '''dddddddd-1111-4000-8000-0000000f0001'''
\set clem  '''dddddddd-1111-4000-8000-0000000f0002'''
\set gary  '''dddddddd-1111-4000-8000-0000000f0003'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Fix Co'), (:other::uuid, 'Other Fix Co');
SELECT pg_temp.signup(:desk::uuid, 'desk-fix@example.com');
SELECT pg_temp.signup(:clem::uuid, 'clem-fix@example.com');
SELECT pg_temp.signup(:gary::uuid, 'gary-fix@example.com');
DELETE FROM public.company_members WHERE user_id IN (:desk::uuid, :clem::uuid, :gary::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:desk::uuid, :co::uuid, 'office'), (:clem::uuid, :co::uuid, 'crew'), (:gary::uuid, :co::uuid, 'crew');
-- Clem: Climber with "see money". Gary: groundsman without it.
UPDATE public.crew SET id = 'f-clem', company_id = :co::uuid, status = 'active', role = 'Climber',
       permissions = '{"seeMoney": true}'::jsonb WHERE auth_user_id = :clem::uuid;
UPDATE public.crew SET id = 'f-gary', company_id = :co::uuid, status = 'active', role = 'Groundsman',
       permissions = '{"seeMoney": false}'::jsonb WHERE auth_user_id = :gary::uuid;
INSERT INTO public.settings (company_id, commercial_terms_days, residential_terms_days)
VALUES (:co::uuid, 30, 0) ON CONFLICT (company_id) DO UPDATE SET commercial_terms_days = 30, residential_terms_days = 0;

INSERT INTO public.customers (id, company_id, first_name, email, customer_type) VALUES
  ('f-c1', :co::uuid, 'Ivy', 'ivy@example.com', 'residential');
INSERT INTO public.estimates (id, company_id, customer_id, title, lines, status, created_date, tax_rate) VALUES
  ('f-e1', :co::uuid, 'f-c1', 'Pine', '[{"id":"l1","description":"Remove","quantity":1,"unitPrice":700}]', 'accepted', '2026-11-01', 0),
  ('f-e2', :co::uuid, 'f-c1', 'Fir', '[{"id":"l1","description":"Prune","quantity":1,"unitPrice":300}]', 'accepted', '2026-11-01', 0),
  ('f-e3', :co::uuid, 'f-c1', 'Yew', '[{"id":"l1","description":"Shape","quantity":1,"unitPrice":200}]', 'accepted', '2026-11-01', 0),
  ('f-e4', :co::uuid, 'f-c1', 'Ash', '[{"id":"l1","description":"Cable","quantity":1,"unitPrice":250}]', 'accepted', '2026-11-01', 0);
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id) VALUES
  ('f-j1', :co::uuid, 'f-c1', 'Removal', 'Pine removal', pg_temp.today(), 'in_progress', ARRAY['f-clem', 'f-gary'], 'f-e1'),
  ('f-j2', :co::uuid, 'f-c1', 'Pruning', 'Fir prune', pg_temp.today(), 'in_progress', ARRAY['f-clem'], 'f-e2'),
  ('f-j3', :co::uuid, 'f-c1', 'Pruning', 'Yew shape', pg_temp.today(), 'in_progress', ARRAY['f-clem'], 'f-e3'),
  ('f-j4', :co::uuid, 'f-c1', 'Pruning', 'Ash cable', pg_temp.today(), 'in_progress', ARRAY['f-clem'], 'f-e4');

-- ===== 1-7: automatic emails in the thread =====
SELECT col_default_is('public', 'messages', 'automatic', 'false', 'messages are not automatic unless an automatic email wrote them');
INSERT INTO public.messages (id, company_id, customer_id, job_id, channel, direction, sender_crew_id, sender_name, body, created_at)
VALUES ('f-m1', :co::uuid, 'f-c1', 'f-j1', 'sms', 'out', 'f-clem', 'Clem', 'On our way', '2026-11-15T15:00:00Z');
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:f-x', 'f-x', 'f-c1', 'Ivy'), NULL, 'claim a reminder');
SELECT isnt(public.finish_automation_send(
    (SELECT id FROM public.automation_sends WHERE dedupe_key = 'invoice_reminder:f-x'), true,
    'Automatic email: payment reminder for INV-1', 'f-j1', NULL), NULL, 'the sent email is recorded in the thread');
SELECT is((SELECT automatic FROM public.messages m JOIN public.automation_sends s ON s.message_id = m.id
            WHERE s.dedupe_key = 'invoice_reminder:f-x'), true, 'and marked automatic');
SELECT pg_temp.act_as(:gary::uuid);
SELECT is((SELECT array_agg(id ORDER BY id)::text FROM public.messages WHERE customer_id = 'f-c1'), '{f-m1}',
  'a groundsman without "see money" reads the crew message but not the automatic email');
SELECT pg_temp.act_as(:clem::uuid);
SELECT is((SELECT count(*)::int FROM public.messages WHERE customer_id = 'f-c1'), 2, 'crew with "see money" read both');
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.messages WHERE customer_id = 'f-c1'), 2, 'the office reads both');
SELECT pg_temp.as_db();

-- ===== 8-17: Done, then Undo inside the grace period =====
UPDATE public.settings SET auto_emails = true WHERE company_id = :co::uuid;
INSERT INTO public.automations (id, company_id, kind, label, enabled, template)
VALUES ('f-rule', :co::uuid, 'invoice_send', 'Auto-send invoices', true, 'Hi {customer}');
SELECT pg_temp.act_as(:clem::uuid);
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j1';
SELECT pg_temp.as_db();
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'f-j1'), 'waiting', 'Done: the invoice waits to be emailed');
SELECT ok((SELECT auto_undo_until BETWEEN now() + interval '119 minutes' AND now() + interval '121 minutes'
             FROM public.invoices WHERE job_id = 'f-j1'), 'it can be undone for 2 hours');
SELECT pg_temp.act_as(:clem::uuid);
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'f-j1';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.invoices WHERE job_id = 'f-j1'), 0, 'Undo removes the untouched invoice');
SELECT is((SELECT invoice_id FROM public.jobs WHERE id = 'f-j1'), NULL, 'and the job''s link to it');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE job_id = 'f-j1' AND field = '(deleted)'), 1, 'the removal is in the history');
SELECT pg_temp.act_as(:clem::uuid);
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j1';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.invoices WHERE job_id = 'f-j1'), 1, 'Done again makes one invoice');
SELECT is((SELECT auto_send_status FROM public.invoices WHERE job_id = 'f-j1'), 'waiting', 'and schedules its email again');
SELECT is((SELECT invoice_id FROM public.jobs WHERE id = 'f-j1'), (SELECT id FROM public.invoices WHERE job_id = 'f-j1'),
  'the job links to the new invoice');
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE job_id = 'f-j1'), 0, 'nothing goes to the review list');
-- Auto-send off: the same for an invoice with no email planned.
UPDATE public.automations SET enabled = false WHERE id = 'f-rule';
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j2';
UPDATE public.jobs SET status = 'scheduled' WHERE id = 'f-j2';
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j2';
SELECT is((SELECT (count(*), (SELECT count(*) FROM public.invoice_reviews WHERE job_id = 'f-j2'))::text
             FROM public.invoices WHERE job_id = 'f-j2'), '(1,0)', 'auto-send off: Done, Undo, Done gives one invoice, no review');

-- ===== 18-24: what keeps the invoice =====
-- Edited by the office.
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET due_date = '2026-12-31' WHERE job_id = 'f-j2';
SELECT pg_temp.as_db();
SELECT is((SELECT auto_undo_until FROM public.invoices WHERE job_id = 'f-j2'), NULL, 'an office change ends the undo');
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'f-j2';
SELECT is((SELECT count(*)::int FROM public.invoices WHERE job_id = 'f-j2'), 1, 'an edited invoice is kept when the job is reopened');
-- Sent.
UPDATE public.automations SET enabled = true WHERE id = 'f-rule';
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j3';
UPDATE public.invoices SET auto_send_at = now() - interval '1 minute' WHERE job_id = 'f-j3';
SELECT is(public.auto_invoice_send_claim((SELECT id FROM public.invoices WHERE job_id = 'f-j3')), true, 'claimed for sending');
SELECT public.auto_invoice_send_finish((SELECT id FROM public.invoices WHERE job_id = 'f-j3'), 'sent');
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'f-j3';
SELECT is((SELECT (count(*), min(auto_send_status))::text FROM public.invoices WHERE job_id = 'f-j3'), '(1,sent)',
  'a sent invoice is kept when the job is reopened');
-- Past the grace period.
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j4';
UPDATE public.invoices SET auto_undo_until = now() - interval '1 minute' WHERE job_id = 'f-j4';
UPDATE public.jobs SET status = 'in_progress' WHERE id = 'f-j4';
SELECT is((SELECT (count(*), min(auto_send_note))::text FROM public.invoices WHERE job_id = 'f-j4'), '(1,reopened)',
  'after the grace period the invoice is kept and its email stopped');
-- App users cannot set the undo time.
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET auto_undo_until = now() + interval '1 day' WHERE job_id = 'f-j4';
SELECT pg_temp.as_db();
SELECT is((SELECT auto_undo_until FROM public.invoices WHERE job_id = 'f-j4'), NULL, 'the office cannot set the undo time');
SELECT pg_temp.act_as(:desk::uuid);
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date, auto_undo_until)
VALUES ('f-hand', :co::uuid, 'INV-5000', 'f-c1', 'unpaid', pg_temp.today(), pg_temp.today(), now() + interval '1 hour');
SELECT pg_temp.as_db();
SELECT is((SELECT auto_undo_until FROM public.invoices WHERE id = 'f-hand'), NULL, 'nor on a new invoice');

-- ===== 25-32: unique invoice numbers =====
SELECT has_index('public', 'invoices', 'invoices_company_number', 'invoices have a unique number index');
SELECT pg_temp.act_as(:desk::uuid);
-- The app's copy was out of date: it picks INV-5000 again.
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date)
VALUES ('f-dup', :co::uuid, 'INV-5000', 'f-c1', 'unpaid', pg_temp.today(), pg_temp.today());
SELECT pg_temp.as_db();
SELECT is((SELECT number FROM public.invoices WHERE id = 'f-dup'), 'INV-5001', 'a number already used gets the next free one');
SELECT is((SELECT number FROM public.invoices WHERE id = 'f-hand'), 'INV-5000', 'the first invoice keeps its number');
SELECT pg_temp.act_as(:desk::uuid);
-- An upsert of an existing invoice keeps its own number.
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date)
VALUES ('f-hand', :co::uuid, 'INV-5000', 'f-c1', 'unpaid', pg_temp.today(), '2027-01-01')
ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, due_date = EXCLUDED.due_date;
SELECT pg_temp.as_db();
SELECT is((SELECT (number, due_date)::text FROM public.invoices WHERE id = 'f-hand'), '(INV-5000,2027-01-01)',
  'saving an existing invoice again keeps its number');
-- Done numbering continues after the app's numbers.
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, estimate_id)
VALUES ('f-j5', :co::uuid, 'f-c1', 'Pruning', 'Oak', pg_temp.today(), 'in_progress', ARRAY['f-clem'], NULL);
INSERT INTO public.estimates (id, company_id, customer_id, title, lines, status, created_date, tax_rate)
VALUES ('f-e5', :co::uuid, 'f-c1', 'Oak', '[{"id":"l1","description":"Prune","quantity":1,"unitPrice":90}]', 'accepted', '2026-11-01', 0);
UPDATE public.jobs SET estimate_id = 'f-e5' WHERE id = 'f-j5';
UPDATE public.jobs SET status = 'done' WHERE id = 'f-j5';
SELECT is((SELECT number FROM public.invoices WHERE job_id = 'f-j5'), 'INV-5002', '"Done" numbering skips the app''s numbers');
SELECT throws_ok($$UPDATE public.invoices SET number = 'INV-5000' WHERE id = 'f-dup'$$, '23505', NULL,
  'two invoices of one company can never share a number');
-- Another company may use the same number.
INSERT INTO public.customers (id, company_id, first_name) VALUES ('f-oc', :other::uuid, 'Oz');
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date)
VALUES ('f-other', :other::uuid, 'INV-5000', 'f-oc', 'unpaid', pg_temp.today(), pg_temp.today());
SELECT is((SELECT number FROM public.invoices WHERE id = 'f-other'), 'INV-5000', 'numbers are unique per company only');
SELECT is((SELECT count(*)::int FROM (SELECT company_id, number FROM public.invoices GROUP BY 1, 2 HAVING count(*) > 1) d), 0,
  'no duplicate numbers anywhere');

SELECT * FROM finish();
ROLLBACK;
