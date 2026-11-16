-- The "email fixes and paid receipts" rules: day-plan
-- emails and split-invoice payment receipts are logged in the sends log
-- (claimed all at once within the limits, one per key), test-mode holds
-- are counted on automation_runs, and none of it is open to app users.
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

\set co   '''aaaaaaaa-0000-4000-8000-0000000a3e01'''
\set desk '''bbbbbbbb-0000-4000-8000-0000000a3e01'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Receipts Co');
SELECT pg_temp.signup(:desk::uuid, 'desk-receipts@example.com');
DELETE FROM public.company_members WHERE user_id = :desk::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES (:desk::uuid, :co::uuid, 'office');
INSERT INTO public.customers (id, company_id, first_name, email, customer_type)
VALUES ('rc-c1', :co::uuid, 'Rae', 'rae@example.com', 'residential');
INSERT INTO public.invoices (id, company_id, number, customer_id, lines, status, issued_date, due_date, splits)
VALUES ('rc-i1', :co::uuid, 'INV-3001', 'rc-c1', '[{"id":"l","description":"Removal","quantity":1,"unitPrice":1000}]',
        'partial', '2026-11-17', '2026-12-17',
        '[{"id":"p1","recipientName":"Ann","recipientEmail":"ann@example.com","kind":"percentage","value":60,"paid":true,"paidDate":"2026-11-17"},{"id":"p2","recipientName":"Bob","recipientEmail":"bob@example.com","kind":"percentage","value":40,"paid":false,"paidDate":null}]'::jsonb);

-- ---------- The sends log takes the new kinds, keeps the old ones ----------
SELECT pg_temp.as_db();
SELECT lives_ok($$
  INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
  VALUES ('aaaaaaaa-0000-4000-8000-0000000a3e01', 'customer_edit_suggested', 'k-old', '')
$$, 'an older kind is still accepted');
SELECT throws_ok($$
  INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
  VALUES ('aaaaaaaa-0000-4000-8000-0000000a3e01', 'made_up', 'k-bad', '')
$$, '23514', NULL, 'an unknown kind is refused');
DELETE FROM public.automation_sends WHERE company_id = :co::uuid;

SELECT has_column('public', 'automation_runs', 'blocked', 'automation_runs counts emails held back by test mode');
SELECT col_default_is('public', 'automation_runs', 'blocked', '0', 'blocked starts at 0');

-- ---------- App users cannot call the new functions ----------
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_day_plan_sends(uuid, jsonb, integer, integer)', 'EXECUTE'),
          'app users cannot claim day-plan sends');
SELECT ok(NOT has_function_privilege('authenticated', 'public.finish_day_plan_send(uuid, boolean)', 'EXECUTE'),
          'app users cannot finish day-plan sends');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_payment_receipts(uuid, text, text, jsonb, integer, integer)', 'EXECUTE'),
          'app users cannot claim receipts');
SELECT ok(NOT has_function_privilege('anon', 'public.claim_payment_receipts(uuid, text, text, jsonb, integer, integer)', 'EXECUTE'),
          'the public cannot claim receipts');
SELECT ok(has_function_privilege('service_role', 'public.claim_payment_receipts(uuid, text, text, jsonb, integer, integer)', 'EXECUTE'),
          'the edge function can claim receipts');
SELECT ok(has_function_privilege('service_role', 'public.claim_day_plan_sends(uuid, jsonb, integer, integer)', 'EXECUTE'),
          'the edge function can claim day-plan sends');

-- ---------- Day plans ----------
SELECT pg_temp.as_service();
CREATE TEMP TABLE dp AS
SELECT public.claim_day_plan_sends(:co::uuid,
  '[{"key":"day_plan:2026-11-18:crew1:aaaa","crew_id":"crew1"},{"key":"day_plan:2026-11-18:crew2:bbbb","crew_id":"crew2"}]'::jsonb,
  60, 400) AS r;
SELECT ok((SELECT (r -> 'claims' ->> 'day_plan:2026-11-18:crew1:aaaa') IS NOT NULL FROM dp), 'a new day plan is claimed');
SELECT is((SELECT count(*)::int FROM public.automation_sends WHERE company_id = :co::uuid AND rule_kind = 'day_plan'), 2,
          'one sends-log row per crew member');
SELECT is((SELECT customer_id || '|' || target_id FROM public.automation_sends WHERE dedupe_key = 'day_plan:2026-11-18:crew1:aaaa'),
          '|crew1', 'no customer, the crew id as the target');
SELECT ok(public.finish_day_plan_send(((SELECT r -> 'claims' ->> 'day_plan:2026-11-18:crew1:aaaa' FROM dp))::uuid, true),
          'a day plan is marked sent');
SELECT is((SELECT status FROM public.automation_sends WHERE dedupe_key = 'day_plan:2026-11-18:crew1:aaaa'), 'sent', 'status sent');
SELECT is((SELECT count(*)::int FROM public.messages WHERE company_id = :co::uuid), 0,
          'a day plan goes in no customer thread');
SELECT ok((public.claim_day_plan_sends(:co::uuid, '[{"key":"day_plan:2026-11-18:crew1:aaaa","crew_id":"crew1"}]'::jsonb, 60, 400)
          -> 'claims' ->> 'day_plan:2026-11-18:crew1:aaaa') IS NULL, 'the same plan again is not claimed (unchanged)');
SELECT is(public.claim_day_plan_sends(:co::uuid, '[{"key":"day_plan:2026-11-18:crew3:cccc","crew_id":"crew3"}]'::jsonb, 2, 400),
          '{"refused": "too-many"}'::jsonb, 'over the hourly day-plan limit nothing is claimed');
SELECT is(public.claim_day_plan_sends(:co::uuid, '[{"key":"day_plan:2026-11-18:crew3:cccc","crew_id":"crew3"}]'::jsonb, 60, 2),
          '{"refused": "daily-limit"}'::jsonb, 'day plans count toward the daily total');
SELECT throws_ok($$ SELECT public.claim_day_plan_sends('aaaaaaaa-0000-4000-8000-0000000a3e01',
                     '[{"key":"invoice_emailed:x","crew_id":"c"}]'::jsonb, 60, 400) $$,
                 '22023', NULL, 'only day-plan keys');
SELECT is(public.finish_day_plan_send(((SELECT r -> 'claims' ->> 'day_plan:2026-11-18:crew1:aaaa' FROM dp))::uuid, false),
          NULL, 'a finished day plan cannot be finished again');

-- ---------- Receipts ----------
CREATE TEMP TABLE rc AS
SELECT public.claim_payment_receipts(:co::uuid, 'rc-i1', 'rc-c1',
  '[{"key":"payment_receipt:rc-i1:payer-p1:2026-11-17:first","name":"Ann (receipt)"}]'::jsonb, 60, 400) AS r;
SELECT ok((SELECT (r -> 'claims' ->> 'payment_receipt:rc-i1:payer-p1:2026-11-17:first') IS NOT NULL FROM rc),
          'a receipt is claimed');
SELECT ok((public.claim_payment_receipts(:co::uuid, 'rc-i1', 'rc-c1',
  '[{"key":"payment_receipt:rc-i1:payer-p1:2026-11-17:first","name":"Ann"}]'::jsonb, 60, 400)
  -> 'claims' ->> 'payment_receipt:rc-i1:payer-p1:2026-11-17:first') IS NULL,
  'one receipt per payment: a second claim gets nothing');
SELECT throws_ok($$ SELECT public.claim_payment_receipts('aaaaaaaa-0000-4000-8000-0000000a3e01', 'rc-i1', 'rc-c1',
                     '[{"key":"payment_receipt:other:payer-p1:2026-11-17:first"}]'::jsonb, 60, 400) $$,
                 '22023', NULL, 'only receipt keys of this invoice');
SELECT is(public.claim_payment_receipts(:co::uuid, 'rc-i1', 'rc-c1',
  '[{"key":"payment_receipt:rc-i1:payer-p2:2026-11-17:first"}]'::jsonb, 1, 400),
  '{"refused": "too-many"}'::jsonb, 'over the hourly receipt limit nothing is claimed');
SELECT isnt(public.finish_automation_send(((SELECT r -> 'claims' ->> 'payment_receipt:rc-i1:payer-p1:2026-11-17:first' FROM rc))::uuid,
            true, 'Receipt for invoice INV-3001 emailed to Ann.', NULL, NULL, 'Receipt email'),
            NULL, 'a receipt is recorded');
SELECT is((SELECT body FROM public.messages WHERE company_id = :co::uuid AND customer_id = 'rc-c1'),
          'Receipt for invoice INV-3001 emailed to Ann.', 'the thread line has no amount');
SELECT is((SELECT emailed_at FROM public.invoices WHERE id = 'rc-i1'), NULL,
          'a receipt does not mark the invoice emailed');

-- ---------- Office staff read the receipts; nobody writes them ----------
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.automation_sends WHERE rule_kind = 'payment_receipt' AND status = 'sent'), 1,
          'office staff see the receipt was sent');
SELECT throws_ok($$ INSERT INTO public.automation_sends (company_id, rule_kind, dedupe_key, customer_id)
                    VALUES ('aaaaaaaa-0000-4000-8000-0000000a3e01', 'payment_receipt', 'payment_receipt:x', '') $$,
                 '42501', NULL, 'app users cannot write the sends log');
SELECT throws_ok($$ SELECT public.claim_payment_receipts('aaaaaaaa-0000-4000-8000-0000000a3e01', 'rc-i1', 'rc-c1',
                     '[{"key":"payment_receipt:rc-i1:payer-p2:2026-11-17:first"}]'::jsonb, 60, 400) $$,
                 '42501', NULL, 'app users cannot claim a receipt');

SELECT pg_temp.as_db();
SELECT * FROM finish();
ROLLBACK;
