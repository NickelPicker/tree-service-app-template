-- The "mass emails wait for approval" rules: more than
-- 3 automatic emails at once wait in a batch for the office. Staff read
-- the batches; only the edge function (service role) holds, claims and
-- finishes them; "Don't send" (discard_automation_batch) is staff only,
-- discards just the listed items and stops a "Done" invoice among them.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(44);

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
CREATE FUNCTION pg_temp.as_service()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';
END $$;
CREATE FUNCTION pg_temp.as_db()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
CREATE FUNCTION pg_temp.item(k text, kind text, target text, cust text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('kind', kind, 'dedupe_key', k, 'target_id', target,
                            'customer_id', cust, 'customer_name', 'Name ' || cust, 'due_day', '2026-11-16');
$$;

\set co    '''aaaaaaaa-0000-4000-8000-0000000ba001'''
\set other '''aaaaaaaa-0000-4000-8000-0000000ba002'''
\set boss  '''bbbbbbbb-0000-4000-8000-0000000ba001'''
\set desk  '''bbbbbbbb-0000-4000-8000-0000000ba002'''
\set crew1 '''bbbbbbbb-0000-4000-8000-0000000ba003'''
\set elsew '''bbbbbbbb-0000-4000-8000-0000000ba004'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Batch Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:boss::uuid, 'boss-batch@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-batch@example.com');
SELECT pg_temp.signup(:crew1::uuid, 'crew-batch@example.com');
SELECT pg_temp.signup(:elsew::uuid, 'else-batch@example.com');
DELETE FROM public.company_members WHERE user_id IN (:boss::uuid, :desk::uuid, :crew1::uuid, :elsew::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:boss::uuid, :co::uuid, 'manager'), (:desk::uuid, :co::uuid, 'office'),
  (:crew1::uuid, :co::uuid, 'crew'), (:elsew::uuid, :other::uuid, 'owner');
INSERT INTO public.customers (id, company_id, first_name, email) VALUES
  ('ba-c1', :co::uuid, 'Ann', 'a@example.com'), ('ba-c2', :co::uuid, 'Bo', 'b@example.com'),
  ('ba-c3', :co::uuid, 'Cy', 'c@example.com'), ('ba-c4', :co::uuid, 'Di', 'd@example.com'),
  ('ba-c5', :co::uuid, 'Ed', 'e@example.com');
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date,
                             auto_created, auto_send_status, auto_send_at) VALUES
  ('ba-inv', :co::uuid, 'INV-9001', 'ba-c1', 'unpaid', '2026-11-16', '2026-11-23', true, 'waiting', now() - interval '3 hours'),
  ('ba-inv2', :co::uuid, 'INV-9002', 'ba-c5', 'unpaid', '2026-11-16', '2026-11-23', true, 'waiting', now() - interval '3 hours');

-- 1-6: tables, row-level security
SELECT has_table('public', 'automation_batches', 'automation_batches exists');
SELECT has_table('public', 'automation_batch_items', 'automation_batch_items exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_batches'::regclass),
  'automation_batches has row-level security on');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_batch_items'::regclass),
  'automation_batch_items has row-level security on');
SELECT col_default_is('public', 'automation_batches', 'status', 'waiting', 'a new batch waits for the office');
SELECT col_default_is('public', 'automation_batch_items', 'status', 'waiting', 'a new item waits for the office');

-- 7-12: holding emails (service role)
SELECT pg_temp.as_service();
SELECT isnt(public.hold_automation_emails(:co::uuid, jsonb_build_array(
    pg_temp.item('invoice_send:ba-inv', 'invoice_send', 'ba-inv', 'ba-c1'),
    pg_temp.item('thank_you:x2', 'thank_you', 'x2', 'ba-c2'),
    pg_temp.item('thank_you:x3', 'thank_you', 'x3', 'ba-c3'),
    pg_temp.item('thank_you:x4', 'thank_you', 'x4', 'ba-c4'))), NULL, 'the service role holds 4 emails in a batch');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.automation_batches WHERE company_id = :co::uuid), 1, 'one batch');
SELECT is((SELECT count(*)::int FROM public.automation_batch_items WHERE company_id = :co::uuid AND status = 'waiting'), 4,
  '... with 4 waiting emails');
SELECT pg_temp.as_service();
SELECT is(public.hold_automation_emails(:co::uuid, jsonb_build_array(
    pg_temp.item('thank_you:x2', 'thank_you', 'x2', 'ba-c2'),
    pg_temp.item('invoice_send:ba-inv2', 'invoice_send', 'ba-inv2', 'ba-c5'))),
  (SELECT id FROM public.automation_batches WHERE company_id = :co::uuid),
  'a later run adds to the same open batch');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.automation_batch_items WHERE company_id = :co::uuid AND status = 'waiting'), 5,
  '... an email already waiting is not added twice');
SELECT is((SELECT auto_send_status FROM public.invoices WHERE id = 'ba-inv'), 'waiting',
  'holding a "Done" invoice does not send or stop it');

-- 13-15: an email already sent is never held
INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id, status)
  VALUES (:co::uuid, 'review_request', 'review_request:sent1', 'ba-c3', 'sent');
SELECT pg_temp.as_service();
SELECT lives_ok($$SELECT public.hold_automation_emails('aaaaaaaa-0000-4000-8000-0000000ba001'::uuid,
    jsonb_build_array(pg_temp.item('review_request:sent1', 'review_request', 'sent1', 'ba-c3')))$$,
  'holding an already-sent email does not fail');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.automation_batch_items WHERE dedupe_key = 'review_request:sent1'), 0,
  '... and it is not held');
SELECT throws_ok($$INSERT INTO public.automation_batch_items (batch_id, company_id, rule_kind, dedupe_key, customer_id)
    SELECT id, company_id, 'thank_you', 'thank_you:x3', 'ba-c3' FROM public.automation_batches LIMIT 1$$,
  '23505', NULL, 'the same email cannot wait twice in a company');

-- 16-22: who can read
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.automation_batch_items), 5, 'office staff see the waiting emails');
SELECT is((SELECT count(*)::int FROM public.automation_batches), 1, 'office staff see the batch');
SELECT pg_temp.act_as(:crew1::uuid);
SELECT is((SELECT count(*)::int FROM public.automation_batch_items), 0, 'crew see no waiting emails');
SELECT is((SELECT count(*)::int FROM public.automation_batches), 0, 'crew see no batch');
SELECT pg_temp.act_as(:elsew::uuid);
SELECT is((SELECT count(*)::int FROM public.automation_batch_items), 0, 'another company sees nothing');
SELECT pg_temp.as_db();
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT count(*) FROM public.automation_batch_items$$, '42501', NULL, 'anon cannot read the items');
SELECT throws_ok($$SELECT count(*) FROM public.automation_batches$$, '42501', NULL, 'anon cannot read the batches');
SELECT pg_temp.as_db();

-- 23-30: nobody in the app writes them or calls the service functions
SELECT pg_temp.act_as(:boss::uuid);
SELECT throws_ok($$INSERT INTO public.automation_batches (company_id) VALUES ('aaaaaaaa-0000-4000-8000-0000000ba001')$$,
  '42501', NULL, 'a manager cannot make a batch');
SELECT throws_ok($$UPDATE public.automation_batch_items SET status = 'sent'$$, '42501', NULL,
  'a manager cannot mark emails sent');
SELECT throws_ok($$DELETE FROM public.automation_batch_items$$, '42501', NULL, 'a manager cannot delete waiting emails');
SELECT throws_ok($$UPDATE public.automation_batches SET status = 'done'$$, '42501', NULL, 'a manager cannot close a batch');
SELECT throws_ok($$SELECT public.hold_automation_emails('aaaaaaaa-0000-4000-8000-0000000ba001', '[]')$$,
  '42501', NULL, 'the app cannot hold emails');
SELECT throws_ok($$SELECT public.automation_batch_claim(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())$$,
  '42501', NULL, 'the app cannot claim a batch (only the edge function sends)');
SELECT throws_ok($$SELECT public.automation_batch_item_finish(gen_random_uuid(), 'sent')$$,
  '42501', NULL, 'the app cannot mark an email sent');
SELECT throws_ok($$SELECT public.automation_batch_release(gen_random_uuid())$$,
  '42501', NULL, 'the app cannot release a batch');
SELECT pg_temp.as_db();

-- 31-34: "Don't send" is for office staff of that company only
SELECT pg_temp.act_as(:crew1::uuid);
SELECT throws_ok(format($$SELECT public.discard_automation_batch(%L, ARRAY(SELECT id FROM public.automation_batch_items))$$,
    (SELECT id FROM public.automation_batches WHERE company_id = 'aaaaaaaa-0000-4000-8000-0000000ba001')),
  '42501', NULL, 'crew cannot press Don''t send');
SELECT pg_temp.act_as(:elsew::uuid);
SELECT throws_ok(format($$SELECT public.discard_automation_batch(%L, '{}')$$,
    (SELECT id FROM public.automation_batches WHERE company_id = 'aaaaaaaa-0000-4000-8000-0000000ba001')),
  '42501', NULL, 'an owner of another company cannot press Don''t send');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.discard_automation_batch(gen_random_uuid(), '{}')$$, '42501', NULL,
  'anon cannot call Don''t send');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.automation_batch_items WHERE status = 'waiting' AND company_id = :co::uuid), 5,
  '... nothing was discarded');

-- 35-39: office staff discard exactly the emails they saw
SELECT pg_temp.act_as(:desk::uuid);
SELECT is(public.discard_automation_batch(
    (SELECT id FROM public.automation_batches),
    ARRAY(SELECT id FROM public.automation_batch_items WHERE dedupe_key <> 'invoice_send:ba-inv2')), 4,
  'the office discards the 4 emails it saw');
SELECT pg_temp.as_db();
SELECT is((SELECT auto_send_status || '/' || auto_send_note FROM public.invoices WHERE id = 'ba-inv'), 'stopped/not-approved',
  'a discarded "Done" invoice is stopped, not sent later');
SELECT is((SELECT auto_send_status FROM public.invoices WHERE id = 'ba-inv2'), 'waiting',
  'an invoice the office did not see is untouched');
SELECT is((SELECT status FROM public.automation_batches WHERE company_id = :co::uuid), 'waiting',
  'the batch still waits for the one email left');
SELECT is((SELECT decided_by FROM public.automation_batches WHERE company_id = :co::uuid), :desk::uuid,
  '... and records who decided');

-- 40: a discarded email is never held again
SELECT pg_temp.as_service();
SELECT public.hold_automation_emails(:co::uuid, jsonb_build_array(pg_temp.item('thank_you:x4', 'thank_you', 'x4', 'ba-c4')));
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.automation_batch_items WHERE dedupe_key = 'thank_you:x4'), 1,
  'an email turned down is not held again');

-- 41-44: "Send them" bookkeeping (service role)
SELECT pg_temp.as_service();
SELECT ok(public.automation_batch_claim((SELECT id FROM public.automation_batches), :co::uuid, :boss::uuid),
  'the edge function claims the batch for Send them');
SELECT ok(NOT public.automation_batch_claim((SELECT id FROM public.automation_batches), :co::uuid, :boss::uuid),
  '... a second Send them at the same time gets nothing');
SELECT ok(public.automation_batch_item_finish(
    (SELECT id FROM public.automation_batch_items WHERE dedupe_key = 'invoice_send:ba-inv2'), 'sent'),
  'an email is marked sent');
SELECT is(public.automation_batch_release((SELECT id FROM public.automation_batches)), 'done',
  'with nothing left waiting, the batch is done');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
