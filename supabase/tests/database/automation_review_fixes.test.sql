-- The "automation review fixes" rules: dead accept links
-- show nothing even after acceptance; a "Done" invoice stuck in 'sending'
-- can be claimed again after 30 minutes (and app users cannot touch the
-- claim time); Gmail refusing the account gives a send claim back
-- without counting a try.
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
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(extensions.digest(t, 'sha256'), 'hex');
$$;
CREATE FUNCTION pg_temp.view(t text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.estimate_accept_view(pg_temp.h(t));
$$;

\set co   '''aaaaaaaa-0000-4000-8000-0000000af001'''
\set desk '''bbbbbbbb-0000-4000-8000-0000000af001'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Fix Co');
INSERT INTO public.settings (company_id, residential_terms_days) VALUES (:co::uuid, 7)
  ON CONFLICT (company_id) DO UPDATE SET residential_terms_days = 7;
SELECT pg_temp.signup(:desk::uuid, 'desk-fix@example.com');
DELETE FROM public.company_members WHERE user_id = :desk::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES (:desk::uuid, :co::uuid, 'office');
INSERT INTO public.customers (id, company_id, first_name, last_name, email) VALUES
  ('af-cust', :co::uuid, 'Ann', 'Acorn', 'ann@example.com');
INSERT INTO public.estimates (id, company_id, customer_id, title, lines, status, created_date) VALUES
  ('af-est', :co::uuid, 'af-cust', 'Big maple', '[{"id":"l1","description":"Prune","quantity":1,"unitPrice":800}]', 'sent', '2026-11-15');

-- ===== 1. Accept links: dead states come first =====
SELECT is(public.create_estimate_accept_link(:co::uuid, 'af-est', pg_temp.h('af-a'))->>'status', 'ok', 'a link is made');
SELECT is(public.accept_estimate_by_link(pg_temp.h('af-a'), '', 'Ann Acorn')->>'status', 'accepted', 'the customer accepts');
-- 3-4: the live link that accepted shows it
SELECT is(pg_temp.view('af-a')->>'status', 'accepted', 'the live accepted link says accepted');
SELECT is(pg_temp.view('af-a')->'estimate'->>'title', 'Big maple', '... and shows the estimate');

-- 5-8: expired after acceptance
UPDATE public.estimate_accept_links SET expires_at = now() - interval '1 minute' WHERE token_hash = pg_temp.h('af-a');
SELECT is(pg_temp.view('af-a')->>'status', 'expired', 'an expired accepted link says expired');
SELECT ok(pg_temp.view('af-a')->'estimate' IS NULL AND pg_temp.view('af-a')->'greeting' IS NULL,
  '... and shows no estimate or name');
SELECT ok(position('Ann' IN pg_temp.view('af-a')::text) = 0 AND position('800' IN pg_temp.view('af-a')::text) = 0,
  '... nothing about the customer or the price');
SELECT is(public.accept_estimate_by_link(pg_temp.h('af-a'), '', 'Ann Acorn')->>'status', 'expired', 'accepting on it says expired');
UPDATE public.estimate_accept_links SET expires_at = now() + interval '30 days' WHERE token_hash = pg_temp.h('af-a');

-- 9-10: revoked after acceptance (for example replaced)
UPDATE public.estimate_accept_links SET revoked_at = now(), revoked_reason = 'replaced' WHERE token_hash = pg_temp.h('af-a');
SELECT is(pg_temp.view('af-a')->>'status', 'changed', 'a revoked accepted link says changed');
SELECT ok(pg_temp.view('af-a')->'estimate' IS NULL, '... and shows no estimate');
UPDATE public.estimate_accept_links SET revoked_at = NULL, revoked_reason = NULL WHERE token_hash = pg_temp.h('af-a');

-- 11-12: the estimate changed after acceptance
UPDATE public.estimates SET lines = '[{"id":"l1","description":"Prune","quantity":1,"unitPrice":900}]' WHERE id = 'af-est';
SELECT is(pg_temp.view('af-a')->>'status', 'changed', 'an accepted link whose estimate changed says changed');
SELECT ok(pg_temp.view('af-a')->'estimate' IS NULL, '... and shows no prices');
UPDATE public.estimates SET lines = '[{"id":"l1","description":"Prune","quantity":1,"unitPrice":800}]' WHERE id = 'af-est';
SELECT is(pg_temp.view('af-a')->>'status', 'accepted', 'back to unchanged: accepted again');

-- 14-15: another live link of the accepted estimate; expired
INSERT INTO public.estimate_accept_links (company_id, estimate_id, token_hash, content_hash)
SELECT :co::uuid, 'af-est', pg_temp.h('af-b'), public.estimate_content_hash(e) FROM public.estimates e WHERE id = 'af-est';
SELECT is(pg_temp.view('af-b')->>'status', 'accepted-elsewhere', 'a live second link says accepted elsewhere');
UPDATE public.estimate_accept_links SET expires_at = now() - interval '1 minute' WHERE token_hash = pg_temp.h('af-b');
SELECT is(pg_temp.view('af-b')->>'status', 'expired', 'an expired second link says expired, not accepted elsewhere');

-- 16: the office took the acceptance back
UPDATE public.estimates SET status = 'sent' WHERE id = 'af-est';
SELECT is(pg_temp.view('af-a')->>'status', 'changed', 'an acceptance taken back: the old link says changed');

-- ===== 2. "Done" invoices stuck in 'sending' =====
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date,
                             auto_created, auto_send_status, auto_send_at)
VALUES ('af-inv', :co::uuid, 'INV-9001', 'af-cust', 'unpaid', '2026-11-15', '2026-11-15', true, 'waiting', now() - interval '3 hours'),
       ('af-old', :co::uuid, 'INV-9002', 'af-cust', 'unpaid', '2026-11-15', '2026-11-15', true, 'sending', now() - interval '3 hours'),
       ('af-later', :co::uuid, 'INV-9003', 'af-cust', 'unpaid', '2026-11-15', '2026-11-15', true, 'sending', now() + interval '1 hour');

SELECT has_column('public', 'invoices', 'auto_send_claimed_at', 'invoices keep the claim time');
SELECT is(public.auto_invoice_send_claim('af-inv'), true, 'a waiting due invoice is claimed');
SELECT ok((SELECT auto_send_status = 'sending' AND auto_send_claimed_at > now() - interval '1 minute' FROM public.invoices WHERE id = 'af-inv'),
  '... with the claim time');
SELECT is(public.auto_invoice_send_claim('af-inv'), false, 'a fresh claim cannot be taken again');
UPDATE public.invoices SET auto_send_claimed_at = now() - interval '29 minutes' WHERE id = 'af-inv';
SELECT is(public.auto_invoice_send_claim('af-inv'), false, 'nor after 29 minutes');
UPDATE public.invoices SET auto_send_claimed_at = now() - interval '31 minutes' WHERE id = 'af-inv';
SELECT is(public.auto_invoice_send_claim('af-inv'), true, 'a claim older than 30 minutes is taken again');
SELECT is(public.auto_invoice_send_claim('af-old'), true, 'a claim from before this update (no time) is taken again');
SELECT is(public.auto_invoice_send_claim('af-later'), false, 'not before its send time');

-- 25-26: app users cannot move the claim time
UPDATE public.invoices SET auto_send_status = 'waiting', auto_send_claimed_at = NULL WHERE id = 'af-inv';
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET auto_send_claimed_at = now() - interval '2 hours' WHERE id = 'af-inv';
SELECT pg_temp.as_db();
SELECT ok((SELECT auto_send_claimed_at IS NULL AND auto_send_status = 'waiting' FROM public.invoices WHERE id = 'af-inv'),
  'office staff cannot set the claim time (and it does not count as an edit)');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.invoices SET auto_send_status = 'stopped' WHERE id = 'af-inv';
SELECT pg_temp.as_db();
SELECT is((SELECT auto_send_status || '|' || auto_send_note FROM public.invoices WHERE id = 'af-inv'), 'stopped|stopped',
  'Stop still works for the office');

-- ===== 3. Give a claim back without counting a try =====
SELECT ok(NOT has_function_privilege('authenticated', 'public.release_automation_send(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.release_automation_send(uuid)', 'EXECUTE'),
  'logins and the public key cannot release sends');
SELECT ok(has_function_privilege('service_role', 'public.release_automation_send(uuid)', 'EXECUTE'), 'the edge function can');

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid);
INSERT INTO ids SELECT 'a', public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:af-inv', 'af-inv', 'af-cust', 'Ann');
SELECT is(public.release_automation_send((SELECT id FROM ids WHERE k = 'a')), true, 'a first try is given back');
SELECT is((SELECT count(*)::int FROM public.automation_sends WHERE company_id = :co::uuid AND dedupe_key = 'invoice_reminder:af-inv'), 0,
  '... and leaves no trace');
-- a real failure, then a retry that hits the account problem
INSERT INTO ids SELECT 'b', public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:af-inv', 'af-inv', 'af-cust', 'Ann');
SELECT public.finish_automation_send((SELECT id FROM ids WHERE k = 'b'), false);
SELECT public.claim_automation_send(:co::uuid, 'invoice_reminder', 'invoice_reminder:af-inv', 'af-inv', 'af-cust', 'Ann');
SELECT is(public.release_automation_send((SELECT id FROM ids WHERE k = 'b')), true, 'a retry is given back');
SELECT is((SELECT status || '|' || attempts FROM public.automation_sends WHERE id = (SELECT id FROM ids WHERE k = 'b')), 'failed|1',
  '... keeping only the real failure');
SELECT is(public.release_automation_send((SELECT id FROM ids WHERE k = 'b')), false, 'a send that is not being sent cannot be released');

SELECT * FROM finish();
ROLLBACK;
