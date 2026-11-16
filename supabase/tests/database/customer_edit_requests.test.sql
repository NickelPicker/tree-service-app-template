-- The "customer edit requests" rules: a Sales login
-- suggests customer changes; only the office approves (applies them,
-- with change history) or declines them.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(40);

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

\set co    '''ffffffff-0000-4000-8000-0000000f0001'''
\set other '''ffffffff-0000-4000-8000-0000000f0002'''
\set pat    '''ffffffff-1111-4000-8000-0000000f0001'''
\set gus   '''ffffffff-1111-4000-8000-0000000f0002'''
\set sam  '''ffffffff-1111-4000-8000-0000000f0003'''
\set xs    '''ffffffff-1111-4000-8000-0000000f0004'''
\set xo    '''ffffffff-1111-4000-8000-0000000f0005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Suggest Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:pat::uuid, 'pat-suggest-test@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-suggest-test@example.com');
SELECT pg_temp.signup(:sam::uuid, 'sam-suggest-test@example.com');
SELECT pg_temp.signup(:xs::uuid, 'xs-suggest-test@example.com');
SELECT pg_temp.signup(:xo::uuid, 'xo-suggest-test@example.com');
DELETE FROM public.company_members WHERE user_id IN (:pat::uuid, :gus::uuid, :sam::uuid, :xs::uuid, :xo::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:pat::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'), (:sam::uuid, :co::uuid, 'office'),
  (:xs::uuid, :other::uuid, 'crew'), (:xo::uuid, :other::uuid, 'office');
UPDATE public.crew SET id = 'f-pat', name = 'Pat', company_id = :co::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :pat::uuid;
UPDATE public.crew SET id = 'f-gus', name = 'Gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'f-sam', name = 'Sam', company_id = :co::uuid, status = 'active', role = 'Office manager' WHERE auth_user_id = :sam::uuid;
UPDATE public.crew SET id = 'f-xs', name = 'Xena', company_id = :other::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :xs::uuid;
UPDATE public.crew SET id = 'f-xo', name = 'Xavier', company_id = :other::uuid, status = 'active', role = 'Office' WHERE auth_user_id = :xo::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name, phone, email, address, city, zip, gate_code) VALUES
  ('f-c1', :co::uuid, 'Ann', 'Smith', '555-555-0001', 'ann@example.com', '1 Elm St', 'Anytown', '12301', '1234'),
  ('f-c2', :co::uuid, 'Bob', 'Jones', '555-555-0002', '', '', '', '', ''),
  ('f-x1', :other::uuid, 'Xander', 'Other', '444-555-0009', '', '', '', '', '');
INSERT INTO public.customer_addresses (id, company_id, customer_id, label, street, city, state, zip, is_primary)
  VALUES ('f-a1', :co::uuid, 'f-c1', 'Home', '1 Elm St', 'Anytown', 'CO', '12301', true);

-- ---- Pat (crew login, job title Sales) ----
SELECT pg_temp.act_as(:pat::uuid);
SELECT is_empty($$UPDATE public.customers SET phone = '000' WHERE id = 'f-c1' RETURNING 1$$,
  'Sales cannot change a customer directly');
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (id, company_id, customer_id, changes, note)
  VALUES ('ffffffff-2222-4000-8000-000000000001', 'ffffffff-0000-4000-8000-0000000f0001', 'f-c1',
          '{"phone": "555-555-0100", "street": "9 Oak Ave", "zip": "12302"}', 'New number, moved')$$,
  'but suggests a change');
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (id, company_id, customer_id, changes)
  VALUES ('ffffffff-2222-4000-8000-000000000002', 'ffffffff-0000-4000-8000-0000000f0001', 'f-c2',
          '{"email": "bob@example.com"}')$$,
  'and another one');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes, status, decided_at)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-c1', '{"phone": "1"}', 'approved', now())$$,
  '42501', NULL, 'only as pending');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-c1', '{"customer_type": "commercial"}')$$,
  '23514', NULL, 'a field outside the allow-list is refused');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-c1', '{"phone": "1", "company_id": "x"}')$$,
  '23514', NULL, 'even mixed with allowed ones');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-c1', '{"phone": 5}')$$,
  '23514', NULL, 'values must be text');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-c1', '{}')$$,
  '23514', NULL, 'and something must change');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0002', 'f-x1', '{"phone": "1"}')$$,
  '42501', NULL, 'not for another company''s customer');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-x1', '{"phone": "1"}')$$,
  '42501', NULL, 'nor another company''s customer filed under this company');
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests), 2, 'Sales reads its own suggestions');
SELECT is((SELECT requested_by || '/' || requested_name FROM public.customer_edit_requests
           WHERE id = 'ffffffff-2222-4000-8000-000000000001'), 'f-pat/Pat', 'who suggested it is set by the database');
SELECT throws_ok($$UPDATE public.customer_edit_requests SET status = 'approved'$$,
  '42501', NULL, 'Sales cannot mark a suggestion approved');
SELECT throws_ok($$SELECT public.approve_customer_edit('ffffffff-2222-4000-8000-000000000001')$$,
  '42501', NULL, 'nor approve its own suggestion');
SELECT throws_ok($$SELECT public.decline_customer_edit('ffffffff-2222-4000-8000-000000000001')$$,
  '42501', NULL, 'nor decline it');
SELECT is_empty($$DELETE FROM public.customer_edit_requests RETURNING 1$$, 'nor delete it');
SELECT pg_temp.as_db();
SELECT is((SELECT phone FROM public.customers WHERE id = 'f-c1'), '555-555-0001', 'the customer is unchanged so far');

-- ---- Gus (crew login, Groundsman): nothing ----
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests), 0, 'a groundsman sees no suggestions');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('ffffffff-0000-4000-8000-0000000f0001', 'f-c1', '{"phone": "1"}')$$,
  '42501', NULL, 'cannot suggest');
SELECT throws_ok($$SELECT public.approve_customer_edit('ffffffff-2222-4000-8000-000000000001')$$,
  '42501', NULL, 'cannot approve');
SELECT throws_ok($$SELECT public.decline_customer_edit('ffffffff-2222-4000-8000-000000000001')$$,
  '42501', NULL, 'cannot decline');
SELECT is_empty($$DELETE FROM public.customer_edit_requests RETURNING 1$$, 'cannot delete');
SELECT pg_temp.as_db();

-- ---- Another company ----
SELECT pg_temp.act_as(:xs::uuid);
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests), 0, 'another company''s Sales person sees none of them');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:xo::uuid);
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests), 0, 'another company''s office sees none of them');
SELECT throws_ok($$SELECT public.approve_customer_edit('ffffffff-2222-4000-8000-000000000001')$$,
  '42501', NULL, 'and cannot approve them');
SELECT is_empty($$DELETE FROM public.customer_edit_requests RETURNING 1$$, 'nor delete them');
SELECT pg_temp.as_db();

-- A row with an extra key slipped in by the database itself is still
-- applied only for allow-listed fields.
ALTER TABLE public.customer_edit_requests DROP CONSTRAINT customer_edit_requests_changes_check;
INSERT INTO public.customer_edit_requests (id, company_id, customer_id, requested_user, requested_name, changes)
  VALUES ('ffffffff-2222-4000-8000-000000000003', :co::uuid, 'f-c2', :pat::uuid, 'Pat',
          '{"last_name": "Jones-Ray", "customer_type": "commercial", "company_id": "ffffffff-0000-4000-8000-0000000f0002"}');

-- ---- Sam (office) ----
SELECT pg_temp.act_as(:sam::uuid);
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests WHERE status = 'pending'), 3, 'the office reads every suggestion');
SELECT throws_ok($$UPDATE public.customer_edit_requests SET status = 'approved'$$,
  '42501', NULL, 'the office decides only through approve/decline');
SELECT lives_ok($$SELECT public.approve_customer_edit('ffffffff-2222-4000-8000-000000000001')$$, 'the office approves');
SELECT throws_ok($$SELECT public.approve_customer_edit('ffffffff-2222-4000-8000-000000000001')$$,
  '55000', NULL, 'only once');
SELECT is((SELECT phone || ' | ' || address || ' | ' || city || ' | ' || zip FROM public.customers WHERE id = 'f-c1'),
  '555-555-0100 | 9 Oak Ave | Anytown | 12302', 'the customer changed (and its address mirror)');
SELECT is((SELECT street || ' ' || zip FROM public.customer_addresses WHERE id = 'f-a1'), '9 Oak Ave 12302',
  'the primary address changed');
SELECT is((SELECT string_agg(field || ':' || old_value || '>' || new_value || ':' || actor, ',' ORDER BY field)
           FROM public.audit_log WHERE customer_id = 'f-c1'),
  'address:1 Elm St>9 Oak Ave:Sam,phone:555-555-0001>555-555-0100:Sam,suggested change:suggested by Pat>approved:Sam,zip:12301>12302:Sam',
  'the change history has each field, who approved it, and who suggested it');
SELECT is((SELECT status || ' ' || decided_by FROM public.customer_edit_requests WHERE id = 'ffffffff-2222-4000-8000-000000000001'),
  'approved Sam', 'the suggestion is marked approved');
SELECT lives_ok($$SELECT public.approve_customer_edit('ffffffff-2222-4000-8000-000000000003')$$,
  'a row with fields outside the allow-list');
SELECT is((SELECT last_name || ' ' || customer_type || ' ' || company_id FROM public.customers WHERE id = 'f-c2'),
  'Jones-Ray residential ffffffff-0000-4000-8000-0000000f0001', 'applies only the allow-listed ones');
SELECT lives_ok($$SELECT public.decline_customer_edit('ffffffff-2222-4000-8000-000000000002')$$, 'the office declines');
SELECT is((SELECT email FROM public.customers WHERE id = 'f-c2'), '', 'a declined suggestion changes nothing');
SELECT lives_ok($$DELETE FROM public.customer_edit_requests WHERE id = 'ffffffff-2222-4000-8000-000000000002'$$,
  'staff may delete a suggestion');
SELECT pg_temp.as_db();

-- Pat sees the decision on its own suggestion.
SELECT pg_temp.act_as(:pat::uuid);
SELECT is((SELECT status FROM public.customer_edit_requests WHERE id = 'ffffffff-2222-4000-8000-000000000001'), 'approved',
  'Sales sees that its suggestion was approved');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
