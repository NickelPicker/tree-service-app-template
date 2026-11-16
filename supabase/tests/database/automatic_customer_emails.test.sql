-- The "automatic customer emails" rules: the master
-- switch (off by default), "No automatic emails" per customer, the
-- sends log and runs (staff read, only the edge function writes) and
-- the claim / finish functions (nothing is sent twice).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(33);

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

\set co    '''aaaaaaaa-0000-4000-8000-0000000ae001'''
\set other '''aaaaaaaa-0000-4000-8000-0000000ae002'''
\set boss  '''bbbbbbbb-0000-4000-8000-0000000ae001'''
\set desk  '''bbbbbbbb-0000-4000-8000-0000000ae002'''
\set crew1 '''bbbbbbbb-0000-4000-8000-0000000ae003'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Auto Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:boss::uuid, 'boss-auto@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-auto@example.com');
SELECT pg_temp.signup(:crew1::uuid, 'crew-auto@example.com');
DELETE FROM public.company_members WHERE user_id IN (:boss::uuid, :desk::uuid, :crew1::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:boss::uuid, :co::uuid, 'manager'), (:desk::uuid, :co::uuid, 'office'), (:crew1::uuid, :co::uuid, 'crew');
INSERT INTO public.customers (id, company_id, first_name, email) VALUES
  ('ae-cust', :co::uuid, 'Ann', 'ann@example.com');

-- 1-6: columns and safe defaults
SELECT has_column('public', 'customers', 'no_auto_emails', 'customers.no_auto_emails exists');
SELECT col_default_is('public', 'customers', 'no_auto_emails', 'false', 'customers get automatic emails unless ticked');
SELECT col_not_null('public', 'customers', 'no_auto_emails', 'no_auto_emails is never null');
SELECT col_default_is('public', 'settings', 'auto_emails', 'false', 'the master switch is OFF by default');
SELECT is((SELECT count(*)::int FROM public.settings WHERE auto_emails), 0,
  'no company has automatic emails on after the migration');
SELECT is((SELECT no_auto_emails FROM public.customers WHERE id = 'ae-cust'), false, 'a new customer is not opted out');

-- 7-10: the "since" day is set by the database
INSERT INTO public.settings (company_id, auto_emails_since) VALUES (:co::uuid, '2000-01-01');
SELECT is((SELECT auto_emails_since FROM public.settings WHERE company_id = :co::uuid), NULL,
  'a new settings row with the switch off has no start day (the app cannot set one)');
UPDATE public.settings SET auto_emails = true WHERE company_id = :co::uuid;
SELECT is((SELECT auto_emails_since FROM public.settings WHERE company_id = :co::uuid),
  to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD'), 'turning the switch on sets the start day to today');
UPDATE public.settings SET auto_emails_since = '2000-01-01' WHERE company_id = :co::uuid;
SELECT is((SELECT auto_emails_since FROM public.settings WHERE company_id = :co::uuid),
  to_char(now() AT TIME ZONE public.business_time_zone(), 'YYYY-MM-DD'), 'the start day cannot be moved back to mail the old backlog');
UPDATE public.settings SET auto_emails = false WHERE company_id = :co::uuid;
SELECT is((SELECT auto_emails FROM public.settings WHERE company_id = :co::uuid), false, 'the switch turns off');

-- 11-14: RLS and privileges
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_sends'::regclass), 'automation_sends has RLS on');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_runs'::regclass), 'automation_runs has RLS on');
SELECT ok(NOT has_table_privilege('authenticated', 'public.automation_sends', 'INSERT,UPDATE,DELETE'),
  'logins cannot write the sends log');
SELECT ok(NOT has_table_privilege('anon', 'public.automation_runs', 'SELECT'), 'the public key cannot read runs');

-- 15-21: claim / finish (as the database owner, like the service role)
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:i1', 'i1', 'ae-cust', 'Ann'),
  NULL, 'the first claim may send');
SELECT is(public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:i1', 'i1', 'ae-cust', 'Ann'),
  NULL, 'a second claim for the same email is refused while it is being sent');
SELECT isnt(public.finish_automation_send(
    (SELECT id FROM public.automation_sends WHERE dedupe_key = 'invoice_reminder:i1'), true, 'Hello Ann', NULL, NULL),
  NULL, 'a successful send is recorded');
SELECT is((SELECT status FROM public.automation_sends WHERE dedupe_key = 'invoice_reminder:i1'), 'sent', 'the send is marked sent');
SELECT is((SELECT count(*)::int FROM public.messages m JOIN public.automation_sends s ON s.message_id = m.id
            WHERE s.dedupe_key = 'invoice_reminder:i1' AND m.customer_id = 'ae-cust' AND m.channel = 'email'
              AND m.direction = 'out' AND m.body = 'Hello Ann' AND m.thread_id IS NOT NULL), 1,
  'the email is in the customer''s message thread');
SELECT is((SELECT count(*)::int FROM public.email_threads WHERE customer_id = 'ae-cust'), 1, 'a thread was started for the customer');
SELECT is(public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:i1', 'i1', 'ae-cust', 'Ann'),
  NULL, 'an email already sent is never sent again');

-- 22-26: a failure is retried, at most 3 attempts; same thread reused
SELECT isnt(public.claim_automation_send(:co::uuid, 'job_reminder', 'job_reminder:j1:2026-12-01', 'j1', 'ae-cust', 'Ann'), NULL, 'claim job reminder');
SELECT is(public.finish_automation_send((SELECT id FROM public.automation_sends WHERE dedupe_key = 'job_reminder:j1:2026-12-01'), false),
  NULL, 'a failed send records no message');
SELECT isnt(public.claim_automation_send(:co::uuid, 'job_reminder', 'job_reminder:j1:2026-12-01', 'j1', 'ae-cust', 'Ann'), NULL,
  'a failed send may be tried again');
SELECT is((SELECT attempts FROM public.automation_sends WHERE dedupe_key = 'job_reminder:j1:2026-12-01'), 2, 'attempts are counted');
UPDATE public.automation_sends SET status = 'failed', attempts = 3 WHERE dedupe_key = 'job_reminder:j1:2026-12-01';
SELECT is(public.claim_automation_send(:co::uuid, 'job_reminder', 'job_reminder:j1:2026-12-01', 'j1', 'ae-cust', 'Ann'), NULL,
  'after 3 failed attempts it is not tried again');

INSERT INTO public.automation_runs (company_id, outcome, sent) VALUES (:co::uuid, 'done', 1), (:other::uuid, 'done', 9);
INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id) VALUES
  (:other::uuid, 'thank_you', 'thank_you:x', 'x');

-- 27-30: who can read
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.automation_sends), 2, 'office staff see their company''s sends only');
SELECT is((SELECT count(*)::int FROM public.automation_runs), 1, 'office staff see their company''s runs only');
SELECT throws_ok($$INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
                   VALUES ('aaaaaaaa-0000-4000-8000-0000000ae001', 'thank_you', 'thank_you:fake', 'ae-cust')$$,
  '42501', NULL, 'office staff cannot add to the sends log (that would block a real email)');
SELECT throws_ok($$SELECT public.claim_automation_send('aaaaaaaa-0000-4000-8000-0000000ae001', 'thank_you', 'k', 't', 'ae-cust', '')$$,
  '42501', NULL, 'logins cannot call the claim function');
SELECT pg_temp.as_db();

-- 31-33: crew and others see nothing; staff cannot clear the log
SELECT pg_temp.act_as(:crew1::uuid);
SELECT is((SELECT count(*)::int FROM public.automation_sends), 0, 'crew do not see the sends log');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:boss::uuid);
SELECT throws_ok($$DELETE FROM public.automation_sends$$, '42501', NULL, 'a manager cannot delete the sends log');
SELECT throws_ok($$SELECT public.finish_automation_send(gen_random_uuid(), true)$$, '42501', NULL,
  'logins cannot call the finish function');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
