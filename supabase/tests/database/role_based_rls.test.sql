-- Phase 3 — role-based row-level security (audit SEC-1, SEC-5).
-- Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(58);

-- ---------- helpers ----------
CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  VALUES (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, now(), '{}'::jsonb);
$$;
CREATE FUNCTION pg_temp.act_as(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
-- Back to the database owner, with no signed-in user.
CREATE FUNCTION pg_temp.as_db()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
-- Rows a statement changed, run as the current role.
CREATE FUNCTION pg_temp.affected(p_sql text)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

\set co '''11111111-1111-4111-8111-111111111111'''
\set owner  '''bbbbbbbb-0000-4000-8000-000000000001'''
\set office '''bbbbbbbb-0000-4000-8000-000000000002'''
\set climb  '''bbbbbbbb-0000-4000-8000-000000000003'''
\set ground '''bbbbbbbb-0000-4000-8000-000000000004'''
\set other  '''bbbbbbbb-0000-4000-8000-000000000005'''

-- ---------- seed (as the database owner) ----------
SELECT pg_temp.signup(:owner::uuid, 'owner@example.com');
SELECT pg_temp.signup(:office::uuid, 'office@example.com');
SELECT pg_temp.signup(:climb::uuid, 'climber@example.com');
SELECT pg_temp.signup(:ground::uuid, 'ground@example.com');
SELECT pg_temp.signup(:other::uuid, 'other@example.com');
-- Signups made pending roster rows (id = auth user id). Approve them.
UPDATE public.crew SET status = 'active', pay_type = 'hourly', pay_amount = 30 WHERE company_id = :co::uuid;
UPDATE public.crew SET role = 'Climber' WHERE auth_user_id = :climb::uuid;
UPDATE public.crew SET role = 'Groundsman' WHERE auth_user_id IN (:ground::uuid, :other::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:office::uuid, :co::uuid, 'office'),
  (:climb::uuid, :co::uuid, 'crew'),
  (:ground::uuid, :co::uuid, 'crew'),
  (:other::uuid, :co::uuid, 'crew');

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('c1', :co::uuid, 'Mine', 'Customer'),
  ('c2', :co::uuid, 'Other', 'Customer'),
  ('c3', :co::uuid, 'Buddy', 'Customer');
-- j1: climber + groundsman. j2: someone else. j3: the groundsman's day-crew buddy.
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids, value) VALUES
  ('j1', :co::uuid, 'c1', 'Removal', 'Oak', '2026-12-01', 'scheduled', ARRAY[:climb, :ground], 1000),
  ('j2', :co::uuid, 'c2', 'Removal', 'Elm', '2026-12-01', 'scheduled', ARRAY[:other], 2000),
  ('j3', :co::uuid, 'c3', 'Trimming', 'Ash', '2026-12-02', 'scheduled', ARRAY[:other], 500);
INSERT INTO public.day_crews (id, company_id, date, name, member_ids) VALUES
  ('d1', :co::uuid, '2026-12-02', 'Crew 1', ARRAY[:ground, :other]);
INSERT INTO public.invoices (id, company_id, number, customer_id, status, issued_date, due_date) VALUES
  ('i1', :co::uuid, '1001', 'c1', 'sent', '2026-12-01', '2026-12-31'),
  ('i2', :co::uuid, '1002', 'c2', 'sent', '2026-12-01', '2026-12-31');
INSERT INTO public.estimates (id, company_id, customer_id, status, created_date) VALUES
  ('e1', :co::uuid, 'c1', 'draft', '2026-11-01');
-- Personal notes belong to a login (author_user, the "rls tightening" rules).
INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text, author_user) VALUES
  ('n-admin', :co::uuid, 'c1', 'admin', 'owner', '2026-11-01', 'admin only', NULL),
  ('n-mine', :co::uuid, 'c1', 'personal', 'ground', '2026-11-01', 'mine', :ground::uuid),
  ('n-other', :co::uuid, 'c1', 'personal', 'other', '2026-11-01', 'not mine', :other::uuid);
INSERT INTO public.messages (id, company_id, customer_id, channel, direction, created_at) VALUES
  ('m1', :co::uuid, 'c1', 'sms', 'out', '2026-11-01'),
  ('m2', :co::uuid, 'c2', 'sms', 'out', '2026-11-01');
INSERT INTO public.audit_log (id, company_id, timestamp, entity, entity_id, field, job_id) VALUES
  ('a1', :co::uuid, '2026-11-01', 'Job', 'j1', 'title', 'j1'),
  ('a2', :co::uuid, '2026-11-01', 'User', :other, 'payAmount', NULL);
INSERT INTO public.timesheets (id, company_id, crew_id, date) VALUES
  ('t-other', :co::uuid, :other, '2026-11-01');
INSERT INTO public.automations (id, company_id, kind) VALUES ('au1', :co::uuid, 'reminder');
INSERT INTO public.booking_requests (id, company_id, date, requested_at) VALUES ('b1', :co::uuid, '2026-12-01', '2026-11-01');
INSERT INTO public.equipment (id, company_id, name) VALUES ('eq1', :co::uuid, 'Chipper');
INSERT INTO public.settings (company_id) VALUES (:co::uuid);

-- =====================================================================
-- Groundsman (app role crew, job role Groundsman)
-- =====================================================================
SELECT pg_temp.act_as(:ground::uuid);

SELECT is((SELECT count(*)::int FROM public.crew), 1, 'crew: reads only their own roster row');
SELECT is((SELECT count(*)::int FROM public.crew WHERE pay_amount IS NOT NULL AND auth_user_id <> :ground::uuid), 0,
  'crew: cannot read another crew member''s pay');
SELECT is((SELECT count(*)::int FROM public.crew_directory(:co::uuid)), 5, 'crew: crew_directory lists the active crew');
SELECT ok((SELECT NOT (proargnames && ARRAY['pay_amount', 'pay_type', 'email', 'permissions', 'auth_user_id'])
    FROM pg_proc WHERE proname = 'crew_directory'),
  'crew_directory has no pay, email or permissions columns');

-- Since the "crew see the whole work day" rules: every job on a day they work (here they are on
-- j1 on 12-01 and on day crew d1 on 12-02, so they work both days and
-- see all three; crew_see_the_day.test.sql covers days they don't work).
SELECT is(ARRAY(SELECT id FROM public.jobs ORDER BY id), ARRAY['j1', 'j2', 'j3'],
  'crew: sees every job on the days they work');
SELECT is(ARRAY(SELECT id FROM public.customers ORDER BY id), ARRAY['c1', 'c2', 'c3'],
  'crew: sees the customers of jobs they can see');
SELECT is((SELECT count(*)::int FROM public.invoices), 0, 'crew: cannot read invoices');
SELECT is((SELECT count(*)::int FROM public.estimates), 0, 'crew: cannot read estimates');
SELECT is(ARRAY(SELECT id FROM public.private_notes ORDER BY id), ARRAY['n-mine'],
  'crew: reads only their own personal note (no admin notes)');
SELECT is(ARRAY(SELECT id FROM public.messages ORDER BY id), ARRAY['m1', 'm2'],
  'crew: reads messages only for customers they can see');
SELECT is(ARRAY(SELECT id FROM public.audit_log ORDER BY id), ARRAY['a1'],
  'crew: reads audit entries for their jobs only (no pay changes)');
SELECT is((SELECT count(*)::int FROM public.timesheets), 0, 'crew: cannot read another crew member''s timesheets');
SELECT is((SELECT count(*)::int FROM public.automations), 0, 'crew: cannot read automations');
SELECT is((SELECT count(*)::int FROM public.booking_requests), 0, 'crew: cannot read booking requests');
SELECT is((SELECT count(*)::int FROM public.equipment), 1, 'crew: can read equipment');
SELECT is((SELECT count(*)::int FROM public.settings), 1, 'crew: can read settings');

SELECT is(pg_temp.affected('DELETE FROM public.customers'), 0, 'crew: cannot delete any customer');
SELECT is(pg_temp.affected('DELETE FROM public.jobs'), 0, 'crew: cannot delete jobs');
SELECT is(pg_temp.affected('UPDATE public.audit_log SET field = ''x'''), 0, 'crew: cannot update the audit log');
SELECT is(pg_temp.affected('DELETE FROM public.audit_log'), 0, 'crew: cannot delete the audit log');
SELECT lives_ok(format($$INSERT INTO public.audit_log (id, company_id, timestamp, entity, entity_id, field)
  VALUES ('a-new', %L, '2026-11-02', 'Job', 'j1', 'status')$$, :co), 'crew: can add audit entries');
SELECT is(pg_temp.affected('UPDATE public.settings SET auto_clock = true'), 0, 'crew: cannot change settings');

SELECT throws_ok(format($$UPDATE public.crew SET permissions = '{"seeMoney": true}' WHERE auth_user_id = %L$$, :ground),
  '42501', NULL, 'crew: cannot change their own permissions');
SELECT throws_ok(format($$UPDATE public.crew SET app_role = 'owner' WHERE auth_user_id = %L$$, :ground),
  '42501', NULL, 'crew: cannot change their own app role');
SELECT throws_ok(format($$UPDATE public.crew SET role = 'Climber' WHERE auth_user_id = %L$$, :ground),
  '42501', NULL, 'crew: cannot change their own job role');
SELECT throws_ok(format($$UPDATE public.crew SET pay_amount = 99 WHERE auth_user_id = %L$$, :ground),
  '42501', NULL, 'crew: cannot change their own pay');
SELECT is(pg_temp.affected(format($$UPDATE public.crew SET message_intro = 'Hi' WHERE auth_user_id = %L$$, :ground)), 1,
  'crew: can change their own message intro');
SELECT is(pg_temp.affected($$UPDATE public.crew SET message_intro = 'Hi' WHERE id <> (SELECT id FROM public.crew LIMIT 1)$$), 0,
  'crew: cannot change another crew member''s row');

SELECT throws_ok($$UPDATE public.jobs SET title = 'Changed' WHERE id = 'j1'$$, '42501', NULL,
  'groundsman: cannot edit job details');
SELECT is(pg_temp.affected($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 'j1'$$), 1,
  'groundsman: can change the status of their job');
SELECT is(pg_temp.affected($$UPDATE public.jobs SET status = 'done' WHERE id = 'j2'$$), 0,
  'groundsman: cannot change a job they are not on');

SELECT lives_ok(format($$INSERT INTO public.timesheets (id, company_id, crew_id, date) VALUES ('t-mine', %L, %L, '2026-11-02')$$, :co, :ground),
  'crew: can clock their own time');
SELECT throws_ok(format($$INSERT INTO public.timesheets (id, company_id, crew_id, date) VALUES ('t-fake', %L, %L, '2026-11-02')$$, :co, :other),
  '42501', NULL, 'crew: cannot clock time for someone else');
SELECT is(pg_temp.affected($$DELETE FROM public.timesheets WHERE id = 't-mine'$$), 0, 'crew: cannot delete timesheets');

SELECT lives_ok(format($$INSERT INTO public.time_off_requests (id, company_id, crew_id, start_date, end_date, status, requested_at)
  VALUES ('to1', %L, %L, '2026-12-10', '2026-12-11', 'pending', '2026-11-01')$$, :co, :ground),
  'crew: can ask for time off');
SELECT throws_ok(format($$INSERT INTO public.time_off_requests (id, company_id, crew_id, start_date, end_date, status, requested_at)
  VALUES ('to2', %L, %L, '2026-12-10', '2026-12-11', 'approved', '2026-11-01')$$, :co, :ground),
  '42501', NULL, 'crew: cannot approve their own time off');

SELECT throws_ok(format($$INSERT INTO public.messages (id, company_id, customer_id, channel, direction, created_at, sender_crew_id)
  VALUES ('m-x', %L, 'c1', 'sms', 'out', '2026-11-02', %L)$$, :co, :ground),
  '42501', NULL, 'crew: cannot message customers without the switch');
SELECT throws_ok(format($$INSERT INTO public.equipment (id, company_id, name) VALUES ('eq2', %L, 'Saw')$$, :co),
  '42501', NULL, 'crew: cannot add equipment');
SELECT lives_ok(format($$INSERT INTO public.equipment_notes (id, company_id, equipment_id, author_id, text)
  VALUES ('en1', %L, 'eq1', %L, 'Chain is dull')$$, :co, :ground),
  'crew: can add an equipment note as themselves');
SELECT throws_ok(format($$INSERT INTO public.customers (id, company_id) VALUES ('c9', %L)$$, :co),
  '42501', NULL, 'crew: cannot add customers');
SELECT pg_temp.as_db();

-- Per-person switches (set by an admin) open data up.
UPDATE public.crew SET permissions = '{"seeMoney": true, "seeAllCustomers": true, "canMessageCustomers": true}'
  WHERE auth_user_id = :ground::uuid;
SELECT pg_temp.act_as(:ground::uuid);
SELECT is(ARRAY(SELECT id FROM public.invoices ORDER BY id), ARRAY['i1', 'i2'],
  'see money + see all customers: crew reads those invoices');
SELECT is((SELECT count(*)::int FROM public.customers), 3, 'see all customers: crew reads every customer');
SELECT is(ARRAY(SELECT id FROM public.jobs ORDER BY id), ARRAY['j1', 'j2', 'j3'], 'see all customers does not change which jobs they see');
SELECT lives_ok(format($$INSERT INTO public.messages (id, company_id, customer_id, channel, direction, created_at, sender_crew_id)
  VALUES ('m-ok', %L, 'c1', 'sms', 'out', '2026-11-02', %L)$$, :co, :ground),
  'can message customers: crew can send as themselves');
SELECT pg_temp.as_db();

-- =====================================================================
-- Climber (app role crew, job role Climber)
-- =====================================================================
SELECT pg_temp.act_as(:climb::uuid);
SELECT is(pg_temp.affected($$UPDATE public.jobs SET title = 'Oak (bigger)' WHERE id = 'j1'$$), 1,
  'climber: can edit their job (the price only with "see money", crew_privacy.test.sql)');
SELECT is(pg_temp.affected($$UPDATE public.jobs SET value = 1 WHERE id = 'j2'$$), 0,
  'climber: cannot edit a job they are not on');
SELECT throws_ok(format($$INSERT INTO public.jobs (id, company_id, customer_id, service_type, date, status, crew_ids)
  VALUES ('j9', %L, 'c1', 'Removal', '2026-12-05', 'scheduled', ARRAY[%L])$$, :co, :climb),
  '42501', NULL, 'climber: cannot create jobs');
SELECT is(pg_temp.affected($$DELETE FROM public.jobs WHERE id = 'j1'$$), 0, 'climber: cannot delete jobs');
SELECT pg_temp.as_db();

-- =====================================================================
-- Office
-- =====================================================================
SELECT pg_temp.act_as(:office::uuid);
SELECT is((SELECT count(*)::int FROM public.invoices), 2, 'office: reads all invoices');
SELECT is((SELECT count(*)::int FROM public.jobs), 3, 'office: reads all jobs');
SELECT is(ARRAY(SELECT id FROM public.private_notes ORDER BY id), ARRAY[]::text[],
  'office: cannot read admin notes or others'' personal notes');
SELECT is(pg_temp.affected(format($$UPDATE public.crew SET pay_amount = 1 WHERE auth_user_id = %L$$, :other)), 0,
  'office: cannot change crew pay');
SELECT pg_temp.as_db();

-- =====================================================================
-- Owner (admin)
-- =====================================================================
SELECT pg_temp.act_as(:owner::uuid);
SELECT is((SELECT count(*)::int FROM public.crew WHERE pay_amount IS NOT NULL), 5, 'owner: reads all crew pay');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE kind = 'admin'), 1, 'owner: reads admin notes');
SELECT is(pg_temp.affected(format($$UPDATE public.crew SET permissions = '{"seeAllJobs": true}' WHERE auth_user_id = %L$$, :other)), 1,
  'owner: can change a crew member''s permissions');
SELECT is(pg_temp.affected($$DELETE FROM public.customers WHERE id = 'c2'$$), 1, 'owner: can delete a customer');
SELECT is(pg_temp.affected('UPDATE public.audit_log SET field = ''x'''), 0, 'owner: cannot update the audit log either');
SELECT pg_temp.as_db();

-- =====================================================================
-- SEC-5
-- =====================================================================
SELECT hasnt_column('public', 'crew', 'password', 'crew.password is gone');

SELECT * FROM finish();
ROLLBACK;
