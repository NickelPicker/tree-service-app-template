-- The "team notes and week approvals" rules:
-- shared team notes on a customer (private_notes.kind = 'team') and
-- the owner/manager-only "Approve week" table for timesheets.
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
\set gus   '''bbbbbbbb-0000-4000-8000-0000000ae003'''
\set far   '''bbbbbbbb-0000-4000-8000-0000000ae004'''
\set otto  '''bbbbbbbb-0000-4000-8000-0000000ae005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Notes Co'), (:other::uuid, 'Other Co');
SELECT pg_temp.signup(:boss::uuid, 'boss-tn@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-tn@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-tn@example.com');
SELECT pg_temp.signup(:far::uuid, 'far-tn@example.com');
SELECT pg_temp.signup(:otto::uuid, 'otto-tn@example.com');
DELETE FROM public.company_members WHERE user_id IN (:boss::uuid, :desk::uuid, :gus::uuid, :far::uuid, :otto::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:boss::uuid, :co::uuid, 'manager'), (:desk::uuid, :co::uuid, 'office'),
  (:gus::uuid, :co::uuid, 'crew'), (:otto::uuid, :co::uuid, 'crew'),
  (:far::uuid, :other::uuid, 'owner');
UPDATE public.crew SET id = 'tn-boss', name = 'Bo Boss', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :boss::uuid;
UPDATE public.crew SET id = 'tn-desk', name = 'Olive Office', company_id = :co::uuid, status = 'active', role = 'Sales' WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'tn-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'tn-otto', name = 'Otto Other', company_id = :co::uuid, status = 'active', role = 'Groundsman' WHERE auth_user_id = :otto::uuid;
UPDATE public.crew SET id = 'tn-far', name = 'Far Away', company_id = :other::uuid, status = 'active' WHERE auth_user_id = :far::uuid;

INSERT INTO public.customers (id, company_id, first_name) VALUES
  ('tn-dana', :co::uuid, 'Dana'), ('tn-carl', :co::uuid, 'Carl');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids) VALUES
  ('tn-j1', :co::uuid, 'tn-dana', 'Removal', 'Big oak', to_char(now(), 'YYYY-MM-DD'), 'scheduled', ARRAY['tn-gus']);
-- Personal notes belong to a login (author_user, the "rls tightening" rules).
INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text, author_user) VALUES
  ('tn-admin', :co::uuid, 'tn-dana', 'admin', 'Bo Boss', '2026-11-15T10:00:00Z', 'admin only', NULL),
  ('tn-mine', :co::uuid, 'tn-dana', 'personal', 'Bo Boss', '2026-11-15T10:00:00Z', 'boss private', :boss::uuid);

-- 1-8: team notes, writing
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
  VALUES ('tn-t1', 'aaaaaaaa-0000-4000-8000-0000000ae001', 'tn-dana', 'team', 'Olive Office', '2026-11-15T11:00:00Z', 'Wants Tuesday')$$,
  'office adds a team note as themselves');
SELECT throws_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
  VALUES ('tn-t2', 'aaaaaaaa-0000-4000-8000-0000000ae001', 'tn-dana', 'team', 'Bo Boss', '2026-11-15T11:00:00Z', 'x')$$,
  '42501', NULL, 'office cannot write a team note in someone else''s name');
SELECT pg_temp.act_as(:boss::uuid);
SELECT lives_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
  VALUES ('tn-t3', 'aaaaaaaa-0000-4000-8000-0000000ae001', 'tn-carl', 'team', 'Bo Boss', '2026-11-15T11:00:00Z', 'Gate 1234')$$,
  'a manager adds a team note');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
  VALUES ('tn-t4', 'aaaaaaaa-0000-4000-8000-0000000ae001', 'tn-dana', 'team', 'Gus Ground', '2026-11-15T11:00:00Z', 'x')$$,
  '42501', NULL, 'crew cannot add team notes');
SELECT lives_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
  VALUES ('tn-p1', 'aaaaaaaa-0000-4000-8000-0000000ae001', 'tn-dana', 'personal', 'Gus Ground', '2026-11-15T11:00:00Z', 'mine')$$,
  'crew still add their own private note (unchanged)');
SELECT pg_temp.act_as(:far::uuid);
SELECT throws_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
  VALUES ('tn-t5', 'aaaaaaaa-0000-4000-8000-0000000ae001', 'tn-dana', 'team', 'Far Away', '2026-11-15T11:00:00Z', 'x')$$,
  '42501', NULL, 'another company cannot add a team note');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.private_notes SET text = 'Wants Tuesday after 9' WHERE id = 'tn-t1';
SELECT is((SELECT text FROM public.private_notes WHERE id = 'tn-t1'), 'Wants Tuesday after 9', 'the author can fix their team note');
UPDATE public.private_notes SET text = 'changed' WHERE id = 'tn-t3';
SELECT pg_temp.as_db();
SELECT is((SELECT text FROM public.private_notes WHERE id = 'tn-t3'), 'Gate 1234', 'office cannot change someone else''s team note');

-- 9-16: team notes, reading
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE kind = 'team' AND company_id = :co::uuid), 2, 'office reads every team note');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id IN ('tn-admin', 'tn-mine', 'tn-p1')), 0,
  'office still cannot read admin notes or other people''s private notes');
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT array_agg(id ORDER BY id)::text FROM public.private_notes WHERE kind = 'team'), '{tn-t1}',
  'crew read team notes only for customers of their jobs');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id IN ('tn-admin', 'tn-mine')), 0, 'crew cannot read admin or others'' private notes');
SELECT pg_temp.act_as(:otto::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE kind = 'team'), 0, 'crew not on the customer''s jobs see no team notes');
SELECT pg_temp.act_as(:far::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE company_id = :co::uuid), 0, 'another company sees no notes');
SELECT pg_temp.act_as(:boss::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id IN ('tn-admin', 'tn-mine', 'tn-t1', 'tn-t3')), 4,
  'a manager reads admin, own private and team notes');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 'tn-p1'), 0, 'a manager still cannot read crew private notes');

-- 17-20: team notes, deleting
SELECT pg_temp.act_as(:gus::uuid);
DELETE FROM public.private_notes WHERE id = 'tn-t1';
SELECT pg_temp.act_as(:desk::uuid);
DELETE FROM public.private_notes WHERE id = 'tn-t3';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id IN ('tn-t1', 'tn-t3')), 2,
  'crew cannot delete team notes; office cannot delete someone else''s');
SELECT pg_temp.act_as(:desk::uuid);
DELETE FROM public.private_notes WHERE id = 'tn-t1';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 'tn-t1'), 0, 'the author deletes their own team note');
SELECT pg_temp.act_as(:boss::uuid);
DELETE FROM public.private_notes WHERE id = 'tn-t3';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 'tn-t3'), 0, 'a manager deletes a team note');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id IN ('tn-admin', 'tn-mine', 'tn-p1')), 3, 'other notes untouched');

-- 21-24: week approvals, structure
SELECT has_table('public', 'timesheet_week_approvals', 'timesheet_week_approvals exists');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.timesheet_week_approvals'::regclass), true, 'it has RLS on');
SELECT is(has_table_privilege('anon', 'public.timesheet_week_approvals', 'SELECT'), false, 'signed-out visitors cannot read it');
SELECT is(has_table_privilege('authenticated', 'public.timesheet_week_approvals', 'UPDATE'), false, 'an approval is never edited, only undone');

-- 25-33: who approves
SELECT pg_temp.act_as(:boss::uuid);
SELECT lives_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start, approved_by, total_hours)
  VALUES ('aaaaaaaa-0000-4000-8000-0000000ae001', '2026-11-09', 'Somebody Else', 81.5)$$, 'a manager approves a week');
SELECT is((SELECT (approved_by, approved_user, total_hours)::text FROM public.timesheet_week_approvals WHERE company_id = :co::uuid),
  format('("Bo Boss",%s,81.50)', :boss), 'who approved comes from the login, not the browser');
SELECT throws_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start) VALUES ('aaaaaaaa-0000-4000-8000-0000000ae001', '2026-11-10')$$,
  '23514', NULL, 'a week starts on a Monday');
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.timesheet_week_approvals), 0, 'office cannot see approvals');
SELECT throws_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start) VALUES ('aaaaaaaa-0000-4000-8000-0000000ae001', '2026-11-02')$$,
  '42501', NULL, 'office cannot approve a week');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$INSERT INTO public.timesheet_week_approvals (company_id, week_start) VALUES ('aaaaaaaa-0000-4000-8000-0000000ae001', '2026-11-02')$$,
  '42501', NULL, 'crew cannot approve a week');
DELETE FROM public.timesheet_week_approvals;
SELECT pg_temp.act_as(:far::uuid);
SELECT is((SELECT count(*)::int FROM public.timesheet_week_approvals WHERE company_id = :co::uuid), 0, 'another company''s owner sees none');
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.timesheet_week_approvals WHERE company_id = :co::uuid), 1, 'crew could not undo the approval');
SELECT pg_temp.act_as(:boss::uuid);
DELETE FROM public.timesheet_week_approvals WHERE company_id = :co::uuid;
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.timesheet_week_approvals WHERE company_id = :co::uuid), 0, 'a manager can undo an approval');

SELECT * FROM finish();
ROLLBACK;
