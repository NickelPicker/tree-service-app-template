-- The "customer edit followups" rules: every kind of
-- customer note can be suggested; the office can change a suggestion
-- before approving it; a decline can carry a reason; the Sales person
-- reads its own decided suggestions (and nobody else's); the sends log
-- takes the office notification kind.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(42);

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

\set co    '''eeeeeeee-0000-4000-8000-0000000e0001'''
\set other '''eeeeeeee-0000-4000-8000-0000000e0002'''
\set pat    '''eeeeeeee-1111-4000-8000-0000000e0001'''
\set quinn   '''eeeeeeee-1111-4000-8000-0000000e0002'''
\set gus   '''eeeeeeee-1111-4000-8000-0000000e0003'''
\set sam  '''eeeeeeee-1111-4000-8000-0000000e0004'''
\set xo    '''eeeeeeee-1111-4000-8000-0000000e0005'''
\set r1 '''eeeeeeee-2222-4000-8000-000000000001'''
\set r2 '''eeeeeeee-2222-4000-8000-000000000002'''
\set r3 '''eeeeeeee-2222-4000-8000-000000000003'''
\set r4 '''eeeeeeee-2222-4000-8000-000000000004'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Followup Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:pat::uuid, 'pat-followup-test@example.com');
SELECT pg_temp.signup(:quinn::uuid, 'quinn-followup-test@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-followup-test@example.com');
SELECT pg_temp.signup(:sam::uuid, 'sam-followup-test@example.com');
SELECT pg_temp.signup(:xo::uuid, 'xo-followup-test@example.com');
DELETE FROM public.company_members WHERE user_id IN (:pat::uuid, :quinn::uuid, :gus::uuid, :sam::uuid, :xo::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:pat::uuid, :co::uuid, 'crew'), (:quinn::uuid, :co::uuid, 'crew'), (:gus::uuid, :co::uuid, 'crew'),
  (:sam::uuid, :co::uuid, 'office'), (:xo::uuid, :other::uuid, 'office');
UPDATE public.crew SET id = 'e-pat', name = 'Pat', company_id = :co::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :pat::uuid;
UPDATE public.crew SET id = 'e-quinn', name = 'Quinn', company_id = :co::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :quinn::uuid;
UPDATE public.crew SET id = 'e-gus', name = 'Gus', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'e-sam', name = 'Sam', company_id = :co::uuid, status = 'active', role = 'Office manager' WHERE auth_user_id = :sam::uuid;
UPDATE public.crew SET id = 'e-xo', name = 'Xavier', company_id = :other::uuid, status = 'active', role = 'Office' WHERE auth_user_id = :xo::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name, phone, gate_code, property_notes, notes) VALUES
  ('e-c1', :co::uuid, 'Ann', 'Smith', '555-555-0001', '1234', 'Big dog', ''),
  ('e-c2', :co::uuid, 'Bob', 'Jones', '555-555-0002', '', '', '');

-- ---- 1. Any kind of note ----
SELECT pg_temp.act_as(:pat::uuid);
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (id, company_id, customer_id, changes, note)
  VALUES ('eeeeeeee-2222-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-c1',
          '{"gate_code": "#4321", "property_notes": "Big dog. Side gate sticks.", "notes": "Prefers texts"}', 'On site today')$$,
  'Sales suggests a gate code, property (access) notes and general notes');
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (id, company_id, customer_id, changes)
  VALUES ('eeeeeeee-2222-4000-8000-000000000002', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2',
          '{"phone": "555-555-0100", "zip": "12302"}')$$, 'and a phone/ZIP change');
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (id, company_id, customer_id, changes)
  VALUES ('eeeeeeee-2222-4000-8000-000000000003', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2',
          '{"email": "bob@example.com"}')$$, 'and an email change');
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2', jsonb_build_object('property_notes', repeat('p', 4000)))$$,
  'property notes up to 4000 characters');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2', jsonb_build_object('property_notes', repeat('p', 4001)))$$,
  '23514', NULL, 'but not longer');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2', jsonb_build_object('gate_code', repeat('9', 201)))$$,
  '23514', NULL, 'a gate code keeps the short limit (200)');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2', '{"customer_type": "commercial"}')$$,
  '23514', NULL, 'a non-note field outside the allow-list is still refused');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes, decline_reason)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2', '{"phone": "1"}', 'sneaky')$$,
  '23514', NULL, 'Sales cannot set a decline reason');
SELECT throws_ok($$INSERT INTO public.customer_edit_requests (company_id, customer_id, changes, applied_changes)
  VALUES ('eeeeeeee-0000-4000-8000-0000000e0001', 'e-c2', '{"phone": "1"}', '{"phone": "2"}')$$,
  '23514', NULL, 'nor applied values');
SELECT throws_ok($$UPDATE public.customer_edit_requests SET decline_reason = 'x'$$,
  '42501', NULL, 'nor change a row directly');
SELECT throws_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000001', '{"gate_code": "0000"}')$$,
  '42501', NULL, 'nor approve its own, with or without changes');
SELECT throws_ok($$SELECT public.decline_customer_edit('eeeeeeee-2222-4000-8000-000000000001', 'no')$$,
  '42501', NULL, 'nor decline it');
SELECT pg_temp.as_db();
-- A second Sales person's suggestion.
SELECT pg_temp.act_as(:quinn::uuid);
SELECT lives_ok($$INSERT INTO public.customer_edit_requests (id, company_id, customer_id, changes)
  VALUES ('eeeeeeee-2222-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-0000000e0001', 'e-c1',
          '{"last_name": "Smyth"}')$$, 'another Sales person suggests too');
SELECT pg_temp.as_db();

-- ---- 2. The office: plain approve of every note kind ----
SELECT pg_temp.act_as(:sam::uuid);
SELECT lives_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000001')$$, 'the office approves the notes');
SELECT pg_temp.as_db();
SELECT is((SELECT gate_code || ' | ' || property_notes || ' | ' || notes FROM public.customers WHERE id = 'e-c1'),
  '#4321 | Big dog. Side gate sticks. | Prefers texts', 'gate code, property notes and general notes are applied');
SELECT is((SELECT string_agg(field, ',' ORDER BY field) FROM public.audit_log WHERE customer_id = 'e-c1'),
  'gateCode,notes,propertyNotes,suggested change', 'each note field has its own history entry');
SELECT is((SELECT new_value FROM public.audit_log WHERE customer_id = 'e-c1' AND field = 'suggested change'),
  'approved', 'approved as suggested reads "approved"');
SELECT is((SELECT applied_changes FROM public.customer_edit_requests WHERE id = :r1::uuid),
  '{"gate_code": "#4321", "property_notes": "Big dog. Side gate sticks.", "notes": "Prefers texts"}'::jsonb,
  'what was applied is kept');

-- ---- 3. Approve with the office's changes ----
SELECT pg_temp.act_as(:sam::uuid);
SELECT throws_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000002', '{"phone": "555-555-0199", "email": "x@example.com"}')$$,
  '22023', NULL, 'the office cannot add a field that was not suggested');
SELECT throws_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000002', '{"phone": "555-555-0199", "customer_type": "commercial"}')$$,
  '22023', NULL, 'nor a field outside the allow-list');
SELECT throws_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000002', jsonb_build_object('phone', repeat('9', 201)))$$,
  '22023', NULL, 'values are length-checked');
SELECT throws_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000002', '{"phone": 5}')$$,
  '22023', NULL, 'and must be text');
SELECT throws_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000002', '{}')$$,
  '22023', NULL, 'and something must be applied');
SELECT is((SELECT status FROM public.customer_edit_requests WHERE id = :r2::uuid), 'pending',
  'a refused approve changes nothing');
SELECT lives_ok($$SELECT public.approve_customer_edit('eeeeeeee-2222-4000-8000-000000000002', '{"phone": "555-555-0199"}')$$,
  'the office approves with its own phone and leaves the ZIP out');
SELECT pg_temp.as_db();
SELECT is((SELECT phone || ' ' || zip FROM public.customers WHERE id = 'e-c2'), '555-555-0199 ',
  'the office''s value is applied, the left-out field is not');
SELECT is((SELECT old_value || ' >> ' || new_value FROM public.audit_log WHERE customer_id = 'e-c2' AND field = 'suggested change'),
  'suggested by Pat: phone → 555-555-0100; zip → 12302 >> approved with changes: phone → 555-555-0199',
  'the history says "approved with changes", with what was suggested and what was applied');
SELECT is((SELECT old_value || '>' || new_value FROM public.audit_log WHERE customer_id = 'e-c2' AND field = 'phone'),
  '555-555-0002>555-555-0199', 'and the field change itself');
SELECT is((SELECT changes || applied_changes FROM public.customer_edit_requests WHERE id = :r2::uuid),
  '{"phone": "555-555-0199", "zip": "12302"}'::jsonb, 'the suggestion keeps Pat''s values; applied_changes holds the office''s');
SELECT is((SELECT applied_changes FROM public.customer_edit_requests WHERE id = :r2::uuid),
  '{"phone": "555-555-0199"}'::jsonb, 'applied values recorded');

-- ---- 4. Decline with a reason ----
SELECT pg_temp.act_as(:sam::uuid);
SELECT throws_ok($$SELECT public.decline_customer_edit('eeeeeeee-2222-4000-8000-000000000003', repeat('r', 501))$$,
  '22001', NULL, 'a reason is at most 500 characters');
SELECT lives_ok($$SELECT public.decline_customer_edit('eeeeeeee-2222-4000-8000-000000000003', '  We already have his work email.  ')$$,
  'the office declines with a reason');
SELECT lives_ok($$SELECT public.decline_customer_edit('eeeeeeee-2222-4000-8000-000000000004')$$,
  'or without one');
SELECT pg_temp.as_db();
SELECT is((SELECT decline_reason FROM public.customer_edit_requests WHERE id = :r3::uuid),
  'We already have his work email.', 'the reason is stored (trimmed)');
SELECT is((SELECT new_value FROM public.audit_log WHERE customer_id = 'e-c2' AND field = 'suggested change' AND new_value LIKE 'declined%'),
  'declined: We already have his work email.', 'and in the history');

-- ---- 5. Who reads the decided suggestions ----
SELECT pg_temp.act_as(:pat::uuid);
SELECT is((SELECT string_agg(status || ':' || coalesce(nullif(decline_reason, ''), '-') || ':' || coalesce(applied_changes::text, '-'), ', ' ORDER BY id)
           FROM public.customer_edit_requests WHERE status <> 'pending'),
  'approved:-:{"notes": "Prefers texts", "gate_code": "#4321", "property_notes": "Big dog. Side gate sticks."}, approved:-:{"phone": "555-555-0199"}, declined:We already have his work email.:-',
  'Pat reads his own decided suggestions, with the reason and what was applied');
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests WHERE id = :r4::uuid), 0, 'but not Quinn''s');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:quinn::uuid);
SELECT is((SELECT array_agg(id) FROM public.customer_edit_requests), ARRAY[:r4::uuid],
  'another Sales person reads only their own');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests), 0, 'a groundsman reads none');
SELECT pg_temp.as_db();
SELECT pg_temp.act_as(:xo::uuid);
SELECT is((SELECT count(*)::int FROM public.customer_edit_requests), 0, 'another company''s office reads none');
SELECT pg_temp.as_db();

-- ---- 6. The sends log takes the office notification ----
SELECT lives_ok($$SELECT public.claim_automation_send('eeeeeeee-0000-4000-8000-0000000e0001', 'customer_edit_suggested',
  'customer_edit_suggested:eeeeeeee-2222-4000-8000-000000000001', 'eeeeeeee-2222-4000-8000-000000000001', 'e-c1', 'Ann Smith')$$,
  'the new kind is accepted');
SELECT is((SELECT public.claim_automation_send('eeeeeeee-0000-4000-8000-0000000e0001', 'customer_edit_suggested',
  'customer_edit_suggested:eeeeeeee-2222-4000-8000-000000000001', 'eeeeeeee-2222-4000-8000-000000000001', 'e-c1', 'Ann Smith')),
  NULL::uuid, 'and deduped per suggestion');

SELECT * FROM finish();
ROLLBACK;
