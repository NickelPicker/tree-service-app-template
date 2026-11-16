-- The "invoice email by hand" rules: "Email invoice"
-- pressed by a person is logged as 'invoice_emailed'; a still-waiting
-- automatic email is stopped as 'sent-by-hand' (service role only); the
-- automatic review request is off.
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

\set co   '''aaaaaaaa-0000-4000-8000-0000000e1e01'''
\set desk '''bbbbbbbb-0000-4000-8000-0000000e1e01'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Invoice Mail Co');
SELECT pg_temp.signup(:desk::uuid, 'desk-invmail@example.com');
DELETE FROM public.company_members WHERE user_id = :desk::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES (:desk::uuid, :co::uuid, 'office');
INSERT INTO public.customers (id, company_id, first_name, email, customer_type)
VALUES ('im-c1', :co::uuid, 'Rae', 'rae@example.com', 'residential');
INSERT INTO public.invoices (id, company_id, number, customer_id, lines, status, issued_date, due_date)
VALUES ('im-i1', :co::uuid, 'INV-1001', 'im-c1', '[{"id":"l","description":"Prune","quantity":1,"unitPrice":500}]',
        'unpaid', '2026-11-17', '2026-11-17');
-- As if "Done" had scheduled its automatic email.
UPDATE public.invoices SET auto_created = true, auto_send_status = 'waiting', auto_send_at = now() + interval '2 hours'
 WHERE id = 'im-i1';

-- 1-2: the sends log takes the new kind, and still refuses unknown ones
SELECT lives_ok($$INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
  VALUES ('aaaaaaaa-0000-4000-8000-0000000e1e01', 'invoice_emailed', 'invoice_emailed:x:first', 'im-c1')$$,
  'the sends log accepts invoice_emailed');
SELECT throws_ok($$INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
  VALUES ('aaaaaaaa-0000-4000-8000-0000000e1e01', 'review_link_blast', 'k', 'im-c1')$$,
  '23514', NULL, 'an unknown kind is still refused');
DELETE FROM public.automation_sends WHERE company_id = :co::uuid;

-- 3-4: office staff cannot write the sends log or stop an email "by hand"
SELECT pg_temp.act_as(:desk::uuid);
SELECT throws_ok($$INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
  VALUES ('aaaaaaaa-0000-4000-8000-0000000e1e01', 'invoice_emailed', 'k2', 'im-c1')$$,
  '42501', NULL, 'app users cannot add to the sends log');
UPDATE public.invoices SET auto_send_note = 'sent-by-hand' WHERE id = 'im-i1';
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE id = 'im-i1'), '(waiting,)',
  'an app user cannot set the sent-by-hand note (guard keeps it)');

-- 5-6: send-invoice (service role) stops the waiting automatic email first
SELECT pg_temp.as_service();
SELECT lives_ok($$UPDATE public.invoices SET auto_send_status = 'stopped', auto_send_note = 'sent-by-hand'
  WHERE id = 'im-i1' AND auto_send_status = 'waiting'$$, 'the function can stop it as sent-by-hand');
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE id = 'im-i1'), '(stopped,sent-by-hand)',
  'the automatic email will never go');

-- 7: a made-up note is still refused
SELECT throws_ok($$UPDATE public.invoices SET auto_send_note = 'whatever' WHERE id = 'im-i1'$$,
  '23514', NULL, 'auto_send_note still only takes known notes');

-- 8-11: claim, finish: one send per key, a thread message, no double press
SELECT pg_temp.as_service();
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_emailed', 'invoice_emailed:im-i1:first', 'im-i1', 'im-c1', 'Rae'),
  NULL, 'the first press claims the send');
SELECT is(public.claim_automation_send(:co::uuid, 'invoice_emailed', 'invoice_emailed:im-i1:first', 'im-i1', 'im-c1', 'Rae'),
  NULL, 'a second press with the same key sends nothing');
SELECT isnt(public.finish_automation_send(
  (SELECT id FROM public.automation_sends WHERE dedupe_key = 'invoice_emailed:im-i1:first'),
  true, 'Invoice INV-1001 emailed to the customer.', NULL, NULL, 'Invoice email'), NULL, 'finishing records it');
SELECT pg_temp.as_db();
SELECT is((SELECT (sender_name, body)::text FROM public.messages WHERE company_id = :co::uuid AND customer_id = 'im-c1'),
  '("Invoice email","Invoice INV-1001 emailed to the customer.")', 'the customer thread shows it (no amount)');

-- 12-19: emailed_at is the database's record of a real send
SELECT ok((SELECT emailed_at IS NOT NULL AND email_queued_at IS NOT NULL FROM public.invoices WHERE id = 'im-i1'),
  'a successful invoice_emailed marks the invoice emailed (emailed_at and email_queued_at)');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET emailed_at = NULL, email_queued_at = '2026-11-15T10:00:00.000Z' WHERE id = 'im-i1';
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date, email_queued_at, emailed_at)
VALUES ('im-i9', 'aaaaaaaa-0000-4000-8000-0000000e1e01', 'INV-1009', 'im-c1', 'unpaid', '2026-11-17', '2026-11-17',
        '2026-11-15T10:00:00.000Z', now());
SELECT pg_temp.as_db();
SELECT ok((SELECT emailed_at IS NOT NULL FROM public.invoices WHERE id = 'im-i1'),
  'an app user cannot clear emailed_at (an old tab saving the whole row changes nothing)');
SELECT is((SELECT emailed_at FROM public.invoices WHERE id = 'im-i9'), NULL,
  'an app user cannot make an invoice look emailed (queued is not sent)');

INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date)
VALUES ('im-i2', :co::uuid, 'INV-1002', 'im-c1', 'unpaid', '2026-11-17', '2026-11-17'),
       ('im-i3', :co::uuid, 'INV-1003', 'im-c1', 'unpaid', '2026-11-17', '2026-11-17');
UPDATE public.invoices SET auto_created = true, auto_send_status = 'sending' WHERE id = 'im-i2';
UPDATE public.invoices SET auto_created = true, auto_send_status = 'stopped', auto_send_note = 'sent-by-hand' WHERE id = 'im-i3';
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_send_finish('im-i2', 'sent'), true, 'the automatic Done email finishes');
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_emailed', 'invoice_emailed:im-i3:first', 'im-i3', 'im-c1', 'Rae'),
  NULL, 'a send for im-i3 is claimed');
SELECT is(public.finish_automation_send(
  (SELECT id FROM public.automation_sends WHERE dedupe_key = 'invoice_emailed:im-i3:first'), false), NULL,
  'Gmail refused it');
-- send-invoice puts back the automatic email it stopped
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL
 WHERE id = 'im-i3' AND auto_send_status = 'stopped' AND auto_send_note = 'sent-by-hand';
SELECT pg_temp.as_db();
SELECT ok((SELECT emailed_at IS NOT NULL FROM public.invoices WHERE id = 'im-i2'), 'the automatic Done email sets emailed_at');
SELECT is((SELECT (emailed_at IS NULL, auto_send_status)::text FROM public.invoices WHERE id = 'im-i3'), '(t,waiting)',
  'a failed send leaves it not emailed, and the stopped automatic email is waiting again');

-- 20-22: a send stuck in 'sending' may be taken over after 30 minutes only
SELECT pg_temp.as_service();
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_emailed', 'invoice_emailed:im-i2:first', 'im-i2', 'im-c1', 'Rae'),
  NULL, 'a send is claimed (and then the function stops half way)');
SELECT is(public.reclaim_invoice_email(:co::uuid, 'invoice_emailed:im-i2:first'), NULL, 'a fresh one is not taken over');
SELECT pg_temp.as_db();
UPDATE public.automation_sends SET created_at = now() - interval '31 minutes' WHERE dedupe_key = 'invoice_emailed:im-i2:first';
SELECT pg_temp.as_service();
SELECT isnt(public.reclaim_invoice_email(:co::uuid, 'invoice_emailed:im-i2:first'), NULL, 'after 30 minutes it may be tried again');
SELECT pg_temp.as_db();
UPDATE public.automation_sends SET created_at = now() - interval '2 hours' WHERE dedupe_key = 'invoice_emailed:im-i1:first';

-- 23: a sent one never is
SELECT pg_temp.as_service();
SELECT is(public.reclaim_invoice_email(:co::uuid, 'invoice_emailed:im-i1:first'), NULL, 'a sent email is never taken over');
SELECT pg_temp.as_db();

-- 24-26: who hears that a customer accepted online (Sam = the manager login)
\set sam  '''bbbbbbbb-0000-4000-8000-0000000e1e02'''
\set gone  '''bbbbbbbb-0000-4000-8000-0000000e1e03'''
\set boss  '''bbbbbbbb-0000-4000-8000-0000000e1e04'''
SELECT pg_temp.signup(:sam::uuid, 'sam-invmail@example.com');
SELECT pg_temp.signup(:gone::uuid, 'gone-invmail@example.com');
SELECT pg_temp.signup(:boss::uuid, 'boss-invmail@example.com');
DELETE FROM public.company_members WHERE user_id IN (:sam::uuid, :gone::uuid, :boss::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:sam::uuid, :co::uuid, 'manager'), (:gone::uuid, :co::uuid, 'manager'), (:boss::uuid, :co::uuid, 'owner');
DELETE FROM public.crew WHERE auth_user_id IN (:desk::uuid, :sam::uuid, :gone::uuid, :boss::uuid);
INSERT INTO public.crew (id, company_id, name, role, status, auth_user_id) VALUES
  ('im-desk', :co::uuid, 'Desk', 'Office', 'active', :desk::uuid),
  ('im-sam', :co::uuid, 'Sam', 'Office manager', 'active', :sam::uuid),
  ('im-gone', :co::uuid, 'Gone', 'Office manager', 'inactive', :gone::uuid),
  ('im-boss', :co::uuid, 'Boss', 'Owner', 'active', :boss::uuid);
SELECT pg_temp.as_service();
SELECT is(public.estimate_heads_up_recipients(:co::uuid), ARRAY['sam-invmail@example.com'],
  'only the active manager login (not office, owner or an inactive card)');
SELECT pg_temp.as_db();
SELECT is(has_function_privilege('authenticated', 'public.estimate_heads_up_recipients(uuid)', 'EXECUTE'), false,
  'app users cannot list the recipients');
SELECT is(has_function_privilege('authenticated', 'public.reclaim_invoice_email(uuid, text)', 'EXECUTE'), false,
  'app users cannot take over a send');

-- 27a-d: the hourly run puts back a Done email whose hand send provably never went
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date) VALUES
  ('im-r1', :co::uuid, 'INV-1011', 'im-c1', 'unpaid', '2026-11-17', '2026-11-17'),
  ('im-r2', :co::uuid, 'INV-1012', 'im-c1', 'unpaid', '2026-11-17', '2026-11-17'),
  ('im-r3', :co::uuid, 'INV-1013', 'im-c1', 'unpaid', '2026-11-17', '2026-11-17');
UPDATE public.invoices SET auto_created = true, auto_send_status = 'stopped', auto_send_note = 'sent-by-hand'
 WHERE id IN ('im-r1', 'im-r2', 'im-r3');
UPDATE public.invoices SET emailed_at = now() WHERE id = 'im-r3';
INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, target_id, customer_id, status, attempts, created_at) VALUES
  (:co::uuid, 'invoice_emailed', 'invoice_emailed:im-r1:first', 'im-r1', 'im-c1', 'failed', 1, now() - interval '2 hours'),
  -- died with the hand send still 'sending': it may have gone, so hands off
  (:co::uuid, 'invoice_emailed', 'invoice_emailed:im-r2:first', 'im-r2', 'im-c1', 'sending', 1, now() - interval '2 hours');
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_restore_hand_stops(:co::uuid), 1, 'exactly one Done email is put back');
SELECT pg_temp.as_db();
SELECT is((SELECT array_agg(id || ':' || auto_send_status || ':' || coalesce(auto_send_note, '-') ORDER BY id)
             FROM public.invoices WHERE id IN ('im-r1', 'im-r2', 'im-r3')),
  ARRAY['im-r1:waiting:-', 'im-r2:stopped:sent-by-hand', 'im-r3:stopped:sent-by-hand'],
  'put back only where every hand send failed; never after a send that may have gone, or one that went');
SELECT is((SELECT auto_send_status FROM public.invoices WHERE id = 'im-i3'), 'waiting',
  'an invoice already put back is left as it is');
SELECT is(has_function_privilege('authenticated', 'public.auto_invoice_restore_hand_stops(uuid)', 'EXECUTE'), false,
  'app users cannot call it');

-- 27: nobody is asked for a review automatically
SELECT is((SELECT count(*)::int FROM public.automations WHERE kind = 'review_request' AND enabled), 0,
  'no company has the automatic review request on');

SELECT * FROM finish();
ROLLBACK;
