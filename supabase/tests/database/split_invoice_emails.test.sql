-- The "split invoice emails" rules: a split invoice is
-- emailed only by a person, one email per payer (send-invoice). The
-- automatic "Done" email never claims one; the hourly run stops it
-- (note 'split') and lists the job in "Needs invoice review"; a hand
-- stop of a split invoice is never put back to waiting. Each payer's
-- send has its own sends-log row; the first one Gmail takes sets
-- emailed_at.
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

\set co   '''aaaaaaaa-0000-4000-8000-00000005b101'''
\set desk '''bbbbbbbb-0000-4000-8000-00000005b101'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Split Mail Co');
SELECT pg_temp.signup(:desk::uuid, 'desk-split@example.com');
DELETE FROM public.company_members WHERE user_id = :desk::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES (:desk::uuid, :co::uuid, 'office');
INSERT INTO public.customers (id, company_id, first_name, email, customer_type)
VALUES ('sp-c1', :co::uuid, 'Rae', 'rae@example.com', 'residential');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status)
VALUES ('sp-j1', :co::uuid, 'sp-c1', 'Removal', 'Oak removal', '2026-11-17', 'scheduled'),
       ('sp-j2', :co::uuid, 'sp-c1', 'Removal', 'Elm removal', '2026-11-17', 'scheduled'),
       ('sp-j3', :co::uuid, 'sp-c1', 'Removal', 'Ash removal', '2026-11-17', 'scheduled');

\set two_payers '''[{"id":"p1","recipientName":"Ann","recipientEmail":"ann@example.com","kind":"percentage","value":60,"paid":false,"paidDate":null},{"id":"p2","recipientName":"Bob","recipientEmail":"bob@example.com","kind":"percentage","value":40,"paid":false,"paidDate":null}]'''

INSERT INTO public.invoices (id, company_id, number, customer_id, job_id, lines, status, issued_date, due_date, splits)
VALUES
  -- split, its Done email due now
  ('sp-i1', :co::uuid, 'INV-2001', 'sp-c1', 'sp-j1', '[{"id":"l","description":"Removal","quantity":1,"unitPrice":1000}]',
   'unpaid', '2026-11-17', '2026-11-17', :two_payers::jsonb),
  -- not split, its Done email due now
  ('sp-i2', :co::uuid, 'INV-2002', 'sp-c1', 'sp-j2', '[{"id":"l","description":"Removal","quantity":1,"unitPrice":1000}]',
   'unpaid', '2026-11-17', '2026-11-17', '[]'::jsonb),
  -- split, stopped for a hand send that never went
  ('sp-i3', :co::uuid, 'INV-2003', 'sp-c1', 'sp-j3', '[{"id":"l","description":"Removal","quantity":1,"unitPrice":1000}]',
   'unpaid', '2026-11-17', '2026-11-17', :two_payers::jsonb);
UPDATE public.invoices SET auto_created = true, auto_send_status = 'waiting', auto_send_at = now() - interval '1 minute'
 WHERE id IN ('sp-i1', 'sp-i2');
UPDATE public.invoices SET auto_created = true, auto_send_status = 'stopped', auto_send_note = 'sent-by-hand'
 WHERE id = 'sp-i3';

-- 1-3: the new note and review reason; unknown ones are still refused
SELECT lives_ok($$UPDATE public.invoices SET auto_send_note = 'split' WHERE id = 'sp-i3'$$, 'auto_send_note takes split');
UPDATE public.invoices SET auto_send_note = 'sent-by-hand' WHERE id = 'sp-i3';
SELECT throws_ok($$UPDATE public.invoices SET auto_send_note = 'whatever' WHERE id = 'sp-i3'$$,
  '23514', NULL, 'an unknown note is still refused');
SELECT throws_ok($$INSERT INTO public.invoice_reviews (company_id, job_id, reason)
  VALUES ('aaaaaaaa-0000-4000-8000-00000005b101', 'sp-j2', 'made_up')$$,
  '23514', NULL, 'an unknown review reason is still refused');

-- 4-6: app users cannot call the new function or set the note
SELECT is(has_function_privilege('authenticated', 'public.auto_invoice_stop_split(uuid)', 'EXECUTE'), false,
  'app users cannot run auto_invoice_stop_split');
SELECT is(has_function_privilege('anon', 'public.invoice_is_split(jsonb)', 'EXECUTE'), false,
  'visitors cannot run invoice_is_split');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET auto_send_status = 'stopped', auto_send_note = 'split' WHERE id = 'sp-i2';
SELECT pg_temp.as_db();
SELECT is((SELECT auto_send_note FROM public.invoices WHERE id = 'sp-i2'), 'stopped',
  'an app user stopping an email gets the note "stopped", never "split"');
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_note = NULL WHERE id = 'sp-i2';

-- 7-8: invoice_is_split
SELECT is(public.invoice_is_split('[]'::jsonb), false, 'no splits: not split');
SELECT is(public.invoice_is_split(:two_payers::jsonb), true, 'two payers: split');

-- 9-10: the automatic "Done" email never claims a split invoice
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_send_claim('sp-i1'), false, 'a split invoice is never claimed for the automatic email');
SELECT is(public.auto_invoice_send_claim('sp-i2'), true, 'an invoice that is not split still is');
SELECT pg_temp.as_db();
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_claimed_at = NULL WHERE id = 'sp-i2';

-- 11-13: a hand stop of a split invoice is never put back to waiting
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_restore_hand_stops(:co::uuid), 0, 'nothing is put back');
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE id = 'sp-i3'), '(stopped,sent-by-hand)',
  'the split invoice stays stopped');
UPDATE public.invoices SET splits = '[]'::jsonb WHERE id = 'sp-i3';
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_restore_hand_stops(:co::uuid), 1, 'once it is not split it goes back as before');
SELECT pg_temp.as_db();
UPDATE public.invoices SET splits = :two_payers::jsonb, auto_send_status = 'stopped', auto_send_note = 'sent-by-hand'
 WHERE id = 'sp-i3';

-- 14-17: the hourly run stops the split one and lists it for review
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_stop_split(:co::uuid), 1, 'one split Done email is stopped');
SELECT pg_temp.as_db();
SELECT is((SELECT (auto_send_status, auto_send_note)::text FROM public.invoices WHERE id = 'sp-i1'), '(stopped,split)',
  'it is stopped with the note split');
SELECT is((SELECT auto_send_status FROM public.invoices WHERE id = 'sp-i2'), 'waiting',
  'the invoice that is not split still waits for its automatic email');
SELECT is((SELECT reason FROM public.invoice_reviews WHERE company_id = :co::uuid AND job_id = 'sp-j1'), 'split_invoice',
  'its job is in Needs invoice review');

-- 18: office staff see it in the review list
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE job_id = 'sp-j1'), 1, 'office staff see the review item');
SELECT pg_temp.as_db();

-- 19: running it again changes nothing
SELECT pg_temp.as_service();
SELECT is(public.auto_invoice_stop_split(:co::uuid), 0, 'a second run stops nothing more');

-- 20-24: one sends-log row per payer; the first real send marks the invoice emailed
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_emailed', 'invoice_emailed:sp-i1:payer-p1:first', 'sp-i1', 'sp-c1', 'Ann (for Rae)'),
  NULL, 'payer 1 is claimed');
SELECT isnt(public.claim_automation_send(:co::uuid, 'invoice_emailed', 'invoice_emailed:sp-i1:payer-p2:first', 'sp-i1', 'sp-c1', 'Bob (for Rae)'),
  NULL, 'payer 2 has its own row');
SELECT is(public.finish_automation_send(
  (SELECT id FROM public.automation_sends WHERE dedupe_key = 'invoice_emailed:sp-i1:payer-p2:first'), false), NULL,
  'Gmail refused payer 2');
SELECT isnt(public.finish_automation_send(
  (SELECT id FROM public.automation_sends WHERE dedupe_key = 'invoice_emailed:sp-i1:payer-p1:first'),
  true, 'Invoice INV-2001 emailed to Ann (their share).', 'sp-j1', NULL, 'Invoice email'), NULL, 'payer 1 is recorded');
SELECT pg_temp.as_db();
SELECT ok((SELECT emailed_at IS NOT NULL FROM public.invoices WHERE id = 'sp-i1'),
  'emailed_at is set once at least one payer was emailed');

-- 25-33: claim_invoice_payer_sends claims every payer at once, inside the limits
SELECT is(has_function_privilege('authenticated', 'public.claim_invoice_payer_sends(uuid, text, text, jsonb, integer, integer)', 'EXECUTE'),
  false, 'app users cannot claim payer sends');
SELECT pg_temp.as_service();
SELECT throws_ok($$SELECT public.claim_invoice_payer_sends('aaaaaaaa-0000-4000-8000-00000005b101', 'sp-i3', 'sp-c1',
  '[{"key":"invoice_emailed:sp-i1:payer-p1:x","name":"Ann"}]', 60, 400)$$,
  '22023', NULL, 'a key of another invoice is refused');
SELECT throws_ok($$SELECT public.claim_invoice_payer_sends('aaaaaaaa-0000-4000-8000-00000005b101', 'sp-i3', 'sp-c1', '[]', 60, 400)$$,
  '22023', NULL, 'an empty press is refused');
-- 2 invoice_emailed rows so far this hour (payer 1 sent, payer 2 failed).
SELECT is(public.claim_invoice_payer_sends(:co::uuid, 'sp-i3', 'sp-c1',
  '[{"key":"invoice_emailed:sp-i3:payer-p1:first","name":"Ann"},{"key":"invoice_emailed:sp-i3:payer-p2:first","name":"Bob"}]', 3, 400),
  '{"refused": "too-many"}'::jsonb, 'over the hourly limit with this press included: refused');
SELECT is((SELECT count(*)::int FROM public.automation_sends WHERE target_id = 'sp-i3'), 0,
  'all or nothing: no payer was claimed');
SELECT is(public.claim_invoice_payer_sends(:co::uuid, 'sp-i3', 'sp-c1',
  '[{"key":"invoice_emailed:sp-i3:payer-p1:first","name":"Ann"},{"key":"invoice_emailed:sp-i3:payer-p2:first","name":"Bob"}]', 60, 2),
  '{"refused": "daily-limit"}'::jsonb, 'over the daily limit (sent and sending, all kinds): refused');
SELECT is((SELECT count(*)::int FROM jsonb_each(public.claim_invoice_payer_sends(:co::uuid, 'sp-i3', 'sp-c1',
  '[{"key":"invoice_emailed:sp-i3:payer-p1:first","name":"Ann"},{"key":"invoice_emailed:sp-i3:payer-p2:first","name":"Bob"}]', 4, 400)
  -> 'claims') WHERE jsonb_typeof(value) = 'string'), 2, 'exactly at the limit: both payers are claimed');
SELECT is((SELECT count(*)::int FROM public.automation_sends WHERE target_id = 'sp-i3' AND status = 'sending'), 2,
  'one sending row per payer');
SELECT is(public.claim_invoice_payer_sends(:co::uuid, 'sp-i3', 'sp-c1',
  '[{"key":"invoice_emailed:sp-i3:payer-p1:first","name":"Ann"}]', 60, 400),
  '{"claims": {"invoice_emailed:sp-i3:payer-p1:first": null}}'::jsonb, 'a second press claims nothing for a payer being emailed');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
