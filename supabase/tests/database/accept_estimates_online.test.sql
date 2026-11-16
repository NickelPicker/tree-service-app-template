-- The "customers accept estimates online" rules: private
-- accept links (stored hashed, 60 days, ended when the estimate changes),
-- the public view / accept functions (service role only: the public page
-- acts only through the estimate-accept function and the token), the
-- rate limit, and the estimate-sent bookkeeping.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(53);

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

\set co    '''aaaaaaaa-0000-4000-8000-0000000ac001'''
\set other '''aaaaaaaa-0000-4000-8000-0000000ac002'''
\set desk  '''bbbbbbbb-0000-4000-8000-0000000ac002'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Accept Co'), (:other::uuid, 'Other Co');
INSERT INTO public.settings (company_id, company_profile, residential_terms_days)
VALUES (:co::uuid, '{"name":"Accept Trees","phone":"555-0100","email":"office@example.com","zelleNumber":"555-9999"}', 7);
SELECT pg_temp.signup(:desk::uuid, 'desk-accept@example.com');
DELETE FROM public.company_members WHERE user_id = :desk::uuid;
INSERT INTO public.company_members (user_id, company_id, role) VALUES (:desk::uuid, :co::uuid, 'office');
INSERT INTO public.customers (id, company_id, first_name, last_name, email, phone, address, gate_code) VALUES
  ('ac-cust', :co::uuid, 'Ann', 'Acorn', 'ann@example.com', '555-1111', '1 Oak St', '4321'),
  ('ac-cust2', :co::uuid, 'Bob', 'Birch', 'bob@example.com', '555-2222', '2 Elm St', '');
INSERT INTO public.estimates (id, company_id, customer_id, title, lines, options, status, created_date, notes, expected_crew) VALUES
  ('ac-est', :co::uuid, 'ac-cust', 'Big maple', '[{"id":"l1","description":"Prune","quantity":1,"unitPrice":800,"treeId":"tree-secret"}]',
   '[{"id":"good","label":"Good","description":"Prune only","lines":[{"id":"l1","description":"Prune","quantity":1,"unitPrice":800,"treeId":"tree-secret"}]},
     {"id":"best","label":"Best","description":"Prune and cable","lines":[{"id":"l2","description":"Prune + cable","quantity":1,"unitPrice":1200}]}]',
   'draft', '2026-11-15', 'Haul away included', 4),
  ('ac-est2', :co::uuid, 'ac-cust2', 'Stump', '[{"id":"s1","description":"Grind","quantity":1,"unitPrice":300}]', NULL,
   'sent', '2026-11-15', '', NULL);

-- 1-4: tables, RLS, no access for logins or the public key
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.estimate_accept_links'::regclass), 'estimate_accept_links has RLS on');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.public_rate_limits'::regclass), 'public_rate_limits has RLS on');
SELECT ok(NOT has_table_privilege('anon', 'public.estimate_accept_links', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.estimate_accept_links', 'SELECT,INSERT,UPDATE,DELETE'),
  'neither the public key nor a login can touch the links');
SELECT ok(NOT has_table_privilege('anon', 'public.public_rate_limits', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.public_rate_limits', 'SELECT,INSERT,UPDATE,DELETE'),
  'neither the public key nor a login can touch the rate limits');

-- 5-12: functions are for the edge functions only
SELECT ok(NOT has_function_privilege('anon', 'public.estimate_accept_view(text)', 'EXECUTE'), 'the public key cannot call the view function directly');
SELECT ok(NOT has_function_privilege('anon', 'public.accept_estimate_by_link(text,text,text)', 'EXECUTE'), 'the public key cannot call accept directly (Turnstile and limits are skipped otherwise)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.accept_estimate_by_link(text,text,text)', 'EXECUTE'), 'a login cannot call accept directly');
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_estimate_accept_link(uuid,text,text,boolean)', 'EXECUTE'), 'a login cannot make links directly');
SELECT ok(NOT has_function_privilege('anon', 'public.public_rate_limit_take(text,text,integer,integer)', 'EXECUTE'), 'the public key cannot reset its own limit');
SELECT ok(has_function_privilege('service_role', 'public.estimate_accept_view(text)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.accept_estimate_by_link(text,text,text)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.create_estimate_accept_link(uuid,text,text,boolean)', 'EXECUTE'),
  'the edge functions (service role) can call them');
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.estimate_accept_view(repeat('a', 64))$$, '42501', NULL, 'anon calling the view function is refused');
SELECT throws_ok($$SELECT count(*) FROM public.estimate_accept_links$$, '42501', NULL, 'anon reading links is refused');
RESET ROLE;

-- 13-17: making a link
SELECT is(public.create_estimate_accept_link(:co::uuid, 'ac-est', pg_temp.h('tok-1'))->>'status', 'ok', 'a link is made');
SELECT is((SELECT token_hash FROM public.estimate_accept_links WHERE estimate_id = 'ac-est'), pg_temp.h('tok-1'), 'only the hash is stored');
SELECT ok((SELECT expires_at BETWEEN now() + interval '59 days' AND now() + interval '61 days' FROM public.estimate_accept_links WHERE estimate_id = 'ac-est'),
  'it works for 60 days');
SELECT is(public.create_estimate_accept_link(:co::uuid, 'ac-est', pg_temp.h('tok-1b'))->>'status', 'already-sent', 'the same estimate is not emailed twice by accident');
SELECT is(public.create_estimate_accept_link(:co::uuid, 'ac-est', pg_temp.h('tok-1c'), true)->>'status', 'already-sent', '"Email again" within 2 minutes is a double click');
SELECT is(public.create_estimate_accept_link(:other::uuid, 'ac-est', pg_temp.h('tok-x'))->>'status', 'not-found', 'another company''s estimate cannot be linked');

-- 18-25: the public view shows only this estimate
SELECT is(public.estimate_accept_view(pg_temp.h('tok-1'))->>'status', 'open', 'the link opens the estimate');
SELECT is(public.estimate_accept_view(pg_temp.h('tok-1'))->'estimate'->>'title', 'Big maple', 'it shows the title');
SELECT is(jsonb_array_length(public.estimate_accept_view(pg_temp.h('tok-1'))->'estimate'->'options'), 2, 'it shows both options');
SELECT ok(position('tree-secret' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0
      AND position('expected' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0,
  'no tree ids or internal fields');
SELECT ok(position('555-1111' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0
      AND position('ann@example.com' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0
      AND position('4321' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0
      AND position('Acorn' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0
      AND position('Bob' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0
      AND position('555-9999' IN public.estimate_accept_view(pg_temp.h('tok-1'))::text) = 0,
  'no phone, email, address, gate code, last name, other customers or payment details');
SELECT is(public.estimate_accept_view(pg_temp.h('tok-1'))->>'greeting', 'Ann', 'first name only');
SELECT is((public.estimate_accept_view(pg_temp.h('tok-1'))->>'terms_days')::int, 7, 'the residential payment terms');
SELECT is(public.estimate_accept_view(pg_temp.h('nope'))->>'status', 'not-found', 'an unknown token shows nothing');

-- 26-29: an estimate change ends the link (also when office staff save it)
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.estimates SET status = 'sent' WHERE id = 'ac-est';
SELECT pg_temp.as_db();
SELECT is(public.estimate_accept_view(pg_temp.h('tok-1'))->>'status', 'open', 'a status change alone keeps the link');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.estimates SET options = jsonb_set(options, '{1,lines,0,unitPrice}', '1500') WHERE id = 'ac-est';
SELECT pg_temp.as_db();
SELECT is((SELECT revoked_reason FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-1')), 'changed',
  'a price change by the office ends the link');
SELECT is(public.estimate_accept_view(pg_temp.h('tok-1'))->>'status', 'changed', 'the old link says the estimate changed');
SELECT ok(public.estimate_accept_view(pg_temp.h('tok-1'))->'estimate' IS NULL, 'and shows no prices');

-- 30-31: a new link; the old one cannot accept
SELECT ok((SELECT r->>'status' = 'ok' AND r->'estimate'->>'title' = 'Big maple' AND r->'company'->>'name' = 'Accept Trees'
                   AND position('tree-secret' IN r::text) = 0
              FROM (SELECT public.create_estimate_accept_link(:co::uuid, 'ac-est', pg_temp.h('tok-2')) AS r) x),
  'the changed estimate can be emailed again (with the customer''s copy for the email)');
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-1'), 'best', 'Ann Acorn')->>'status', 'changed', 'the old link cannot accept');

-- 32-35: validation
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-2'), 'best', ' A ')->>'status', 'bad-name', 'a name is required');
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-2'), 'best', repeat('x', 101))->>'status', 'bad-name', 'names are at most 100 characters');
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-2'), 'nope', 'Ann Acorn')->>'status', 'bad-option', 'the option must be one of the estimate''s');
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-2'), '', 'Ann Acorn')->>'status', 'bad-option', 'a multi-option estimate needs an option');

-- 36-45: accept
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-2'), 'best', E'Ann\n  Acorn')->>'status', 'accepted', 'the customer accepts');
SELECT is((SELECT status || '|' || accepted_option_id || '|' || accepted_by FROM public.estimates WHERE id = 'ac-est'),
  'accepted|best|Ann Acorn', 'the estimate is accepted with the option and the typed name');
SELECT ok((SELECT accepted_at ~ '^\d{4}-\d{2}-\d{2}T' FROM public.estimates WHERE id = 'ac-est'), 'with the time');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE entity_id = 'ac-est' AND actor = 'Customer online: Ann Acorn'), 2,
  'two history entries (status, option)');
SELECT is((SELECT count(*)::int FROM public.messages WHERE estimate_id = 'ac-est' AND customer_id = 'ac-cust'
            AND direction = 'in' AND thread_id IS NOT NULL AND body LIKE '%"Best"%'), 1, 'a message in the customer''s thread');
SELECT is((SELECT count(*)::int FROM public.jobs WHERE estimate_id = 'ac-est'), 0,
  'no job yet: the estimate waits in "To schedule" (accepted, no job)');
SELECT ok((SELECT accepted_name = 'Ann Acorn' AND accepted_at IS NOT NULL FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-2')),
  'the link records the acceptance');
SELECT is((SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'estimate_accept_links' AND column_name ILIKE '%ip%'), 0,
  'no IP address column');
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-2'), 'good', 'Ann Acorn')->>'status', 'already-accepted', 'accepting twice changes nothing');
SELECT is((SELECT accepted_option_id FROM public.estimates WHERE id = 'ac-est'), 'best', 'the first choice stands');

-- 46-47: view after accept; expired
SELECT is(public.estimate_accept_view(pg_temp.h('tok-2'))->>'accepted_option_id', 'best', 'the page shows what was accepted');
SELECT public.create_estimate_accept_link(:co::uuid, 'ac-est2', pg_temp.h('tok-3'));
UPDATE public.estimate_accept_links SET expires_at = now() - interval '1 minute' WHERE token_hash = pg_temp.h('tok-3');
SELECT is(public.accept_estimate_by_link(pg_temp.h('tok-3'), '', 'Bob Birch')->>'status', 'expired', 'an expired link cannot accept');

-- 48-50: estimate-sent bookkeeping
SELECT public.create_estimate_accept_link(:co::uuid, 'ac-est2', pg_temp.h('tok-4'), true);
SELECT isnt(public.finish_automation_send(
    public.claim_automation_send(:co::uuid, 'estimate_sent', 'estimate_sent:' || (SELECT id FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-4')),
      (SELECT id::text FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-4')), 'ac-cust2', 'Bob Birch'),
    true, 'Estimate: Stump', NULL, 'ac-est2', 'Estimate email'), NULL, 'the emailed estimate is recorded');
SELECT ok((SELECT email_queued_at IS NOT NULL FROM public.estimates WHERE id = 'ac-est2')
      AND EXISTS (SELECT 1 FROM public.messages WHERE estimate_id = 'ac-est2' AND sender_name = 'Estimate email' AND direction = 'out'),
  'the estimate is marked emailed and the email is in the thread');
UPDATE public.estimate_accept_links SET created_at = now() - interval '5 minutes' WHERE token_hash = pg_temp.h('tok-4');
SELECT public.create_estimate_accept_link(:co::uuid, 'ac-est2', pg_temp.h('tok-5'), true);
SELECT public.finish_automation_send(
    public.claim_automation_send(:co::uuid, 'estimate_sent', 'estimate_sent:' || (SELECT id FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-5')),
      (SELECT id::text FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-5')), 'ac-cust2', 'Bob Birch'),
    false);
SELECT is((SELECT revoked_reason FROM public.estimate_accept_links WHERE token_hash = pg_temp.h('tok-5')), 'email-failed',
  'a failed email ends its link');

-- 51-52: rate limit
SELECT ok(public.public_rate_limit_take('test', 'k1', 2) AND public.public_rate_limit_take('test', 'k1', 2), 'two tries allowed');
SELECT ok(NOT public.public_rate_limit_take('test', 'k1', 2), 'the third is refused');

SELECT * FROM finish();
ROLLBACK;
