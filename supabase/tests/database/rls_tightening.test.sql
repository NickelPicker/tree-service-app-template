-- The "rls tightening" rules:
--  1. "see all jobs" lets crew see every job but change only their own;
--  2. a Climber cannot change a job's invoice link or repeat settings,
--     crew cannot set an unknown status, and a review is settled by a
--     hand-linked invoice only when the office links it;
--  3. crew history entries carry the login's own name (with the card id
--     when two share a name) and login; a job's history only for jobs
--     they may change; other entries tied to a job only for jobs they
--     can see; size limits (refused with 42501); Sales and the office
--     keep their rules; the struck-out old price counts as a price;
--  4. personal notes belong to the login, not to the name; old notes
--     are linked once, only when one login has that name.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(56);

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

\set co  '''eeeeeeee-0000-4000-8000-0000000f0001'''
\set own '''eeeeeeee-1111-4000-8000-0000000f0001'''
\set cal '''eeeeeeee-1111-4000-8000-0000000f0002'''
\set gus '''eeeeeeee-1111-4000-8000-0000000f0003'''
\set ivy '''eeeeeeee-1111-4000-8000-0000000f0004'''
\set sam '''eeeeeeee-1111-4000-8000-0000000f0005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Tight Co');
SELECT pg_temp.signup(:own::uuid, 'own-tight@example.com');
SELECT pg_temp.signup(:cal::uuid, 'cal-tight@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-tight@example.com');
SELECT pg_temp.signup(:ivy::uuid, 'ivy-tight@example.com');
SELECT pg_temp.signup(:sam::uuid, 'sam-tight@example.com');
DELETE FROM public.company_members WHERE user_id IN (:own::uuid, :cal::uuid, :gus::uuid, :ivy::uuid, :sam::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:own::uuid, :co::uuid, 'owner'), (:cal::uuid, :co::uuid, 'crew'),
  (:gus::uuid, :co::uuid, 'crew'), (:ivy::uuid, :co::uuid, 'crew'), (:sam::uuid, :co::uuid, 'crew');
UPDATE public.crew SET id = 't-own', name = 'Olive Owner', company_id = :co::uuid, status = 'active',
  role = 'Owner', permissions = '{}'::jsonb WHERE auth_user_id = :own::uuid;
-- Cal: Climber with "see all jobs". Gus: groundsman with "see all jobs".
UPDATE public.crew SET id = 't-cal', name = 'Cal Climb', company_id = :co::uuid, status = 'active',
  role = 'Climber', permissions = '{"seeAllJobs": true}'::jsonb WHERE auth_user_id = :cal::uuid;
UPDATE public.crew SET id = 't-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active',
  role = 'Groundsman', permissions = '{"seeAllJobs": true}'::jsonb WHERE auth_user_id = :gus::uuid;
-- Ivy signed up later under the same name as Cal.
UPDATE public.crew SET id = 't-ivy', name = 'Cal Climb', company_id = :co::uuid, status = 'active',
  role = 'Groundsman', permissions = '{"seeAllCustomers": true}'::jsonb WHERE auth_user_id = :ivy::uuid;
UPDATE public.crew SET id = 't-sam', name = 'Sam Sales', company_id = :co::uuid, status = 'active',
  role = 'Sales', permissions = '{}'::jsonb WHERE auth_user_id = :sam::uuid;

INSERT INTO public.customers (id, company_id, first_name, last_name) VALUES
  ('t-c1', :co::uuid, 'Ann', 'A'), ('t-c2', :co::uuid, 'Ben', 'B');
INSERT INTO public.jobs (id, company_id, customer_id, service_type, title, date, status, crew_ids,
                         value, billing_type, recurring) VALUES
  ('t-j1', :co::uuid, 't-c1', 'Removal', 'Big oak', '2026-12-14', 'scheduled', ARRAY['t-cal', 't-gus'],
   900, 'flat', 'weekly'),
  -- Another day, nobody of them on it.
  ('t-j2', :co::uuid, 't-c2', 'Trimming', 'Elm trim', '2026-12-15', 'scheduled', ARRAY['t-own'],
   400, 'flat', NULL);

-- ---------- 1-8: "see all jobs" is for seeing ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT ok(public.job_row_visible(:co::uuid, ARRAY['t-own'], '2026-12-15'),
  'with see all jobs a Climber sees a job he is not on');
SELECT ok(NOT public.job_row_assigned(:co::uuid, ARRAY['t-own'], '2026-12-15'),
  'but that job is not one he may change');
SELECT is((SELECT count(*)::int FROM public.app_jobs(:co::uuid) WHERE id = 't-j2'), 1,
  'the app still loads the job for him');
UPDATE public.jobs SET title = 'Changed', crew_ids = ARRAY['t-own', 't-cal'] WHERE id = 't-j2';
SELECT throws_ok($$SELECT public.change_job_price('t-j2', 1, NULL, 'flat', 'Cheaper now')$$, '42501',
  'Only a Climber on this job or the office can change its price.',
  'he cannot change the price of a job he is not on');
SELECT lives_ok($$SELECT public.change_job_price('t-j1', 950, NULL, 'flat', 'Customer added a stump')$$,
  'he still changes the price of his own job, with a reason');
SELECT pg_temp.act_as(:gus::uuid);
UPDATE public.jobs SET status = 'done' WHERE id = 't-j2';
SELECT pg_temp.as_db();
SELECT is((SELECT title || ' ' || status || ' ' || value::text || ' ' || array_to_string(crew_ids, ',')
             FROM public.jobs WHERE id = 't-j2'),
  'Elm trim scheduled 400 t-own', 'the job he is not on did not change');
SELECT is((SELECT value FROM public.jobs WHERE id = 't-j1'), 950::numeric, 'his own job''s price changed');
SELECT pg_temp.act_as(:cal::uuid);
SELECT is((SELECT count(*)::int FROM public.job_price_changes WHERE company_id = :co::uuid), 1,
  'he reads the price changes of his own job');

-- ---------- 9-17: billing fields and status ----------
SELECT throws_ok($$UPDATE public.jobs SET invoice_id = 'x' WHERE id = 't-j1'$$, '42501',
  'Only the office can change a job''s invoice or repeat settings.',
  'a Climber cannot link an invoice');
SELECT throws_ok($$UPDATE public.jobs SET recurring = NULL WHERE id = 't-j1'$$, '42501', NULL,
  'nor clear the repeat setting');
SELECT throws_ok($$UPDATE public.jobs SET recurring_until = '2027-01-01' WHERE id = 't-j1'$$, '42501', NULL,
  'nor change the repeat end date');
SELECT throws_ok($$UPDATE public.jobs SET status = 'cancelled' WHERE id = 't-j1'$$, '42501',
  'A job''s status can only be scheduled, in progress or done.',
  'a Climber cannot set an unknown status');
SELECT lives_ok($$UPDATE public.jobs SET title = 'Big oak, crane' WHERE id = 't-j1'$$,
  'he still changes the work');
SELECT pg_temp.act_as(:gus::uuid);
SELECT throws_ok($$UPDATE public.jobs SET status = '' WHERE id = 't-j1'$$, '42501', NULL,
  'a groundsman cannot set an unknown status');
SELECT lives_ok($$UPDATE public.jobs SET status = 'in_progress' WHERE id = 't-j1'$$,
  'but can start the job');
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$UPDATE public.jobs SET status = 'done' WHERE id = 't-j1'$$, 'a Climber marks his job done');
SELECT pg_temp.as_db();
SELECT is((SELECT reason FROM public.invoice_reviews WHERE job_id = 't-j1'), 'recurring',
  'the repeating job waits in "needs invoice review"');

-- ---------- 18-19: an invoice linked by hand ----------
SELECT pg_temp.act_as(:own::uuid);
UPDATE public.jobs SET invoice_id = 'inv-by-hand' WHERE id = 't-j1';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.invoice_reviews WHERE job_id = 't-j1'), 0,
  'the office linking an invoice settles the review');
SELECT is((SELECT invoice_id FROM public.jobs WHERE id = 't-j1'), 'inv-by-hand', 'and the link saved');

-- ---------- 20-41: change history from crew ----------
SELECT pg_temp.act_as(:gus::uuid);
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a1', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Job', 't-j1', 'x', 'status', 'scheduled', 'in_progress', 't-c1', 't-j1')$$,
  'crew add history for their own job');
SELECT throws_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a2', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Job', 't-j2', 'x', 'value', '400', '900', 't-c2', 't-j2')$$, '42501',
  'You can only add history for jobs you can change.',
  'with see all jobs, not for a job they can only see');
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a6', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Message', 'm-1', 'x', '(created)', '', 'Hello', 't-c2', 't-j2')$$,
  'but a message about a job they can see is fine');
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a7', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Job', 't-j1', 'x', 'status', 'in_progress', 'done', 't-c1', NULL)$$,
  'a job entry with no job id is about its own job');
SELECT throws_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a8', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'User', 't-own', 'x', 'role', 'Owner', 'Groundsman', NULL, NULL)$$, '42501',
  'You can only add history for your own card.', 'crew cannot add history for someone else''s card');
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a9', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'User', 't-gus', 'x', 'messageIntro', '', 'Hi', NULL, NULL)$$,
  'but can for their own card');
SELECT pg_temp.act_as(:ivy::uuid);
SELECT throws_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a3', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Job', 't-j2', 'x', 'value', '400', '900', 't-c2', 't-j2')$$, '42501',
  'You can only add history for jobs you can change.',
  'crew cannot add history for a job they cannot see');
SELECT throws_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a10', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Job', 't-j2', 'x', 'value', '400', '900', 't-c2', NULL)$$, '42501',
  'You can only add history for jobs you can change.',
  'nor by leaving the job id empty');
SELECT throws_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a11', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Job', 't-j2', 'x', 'value', '400', '900', 't-c2', 't-j1')$$, '42501', NULL,
  'nor by giving another job id');
SELECT throws_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a12', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Invoice', 'inv-1', 'x', 'amount', '400', '900', 't-c2', NULL)$$, '42501',
  'Only the office can add this history.', 'crew without see money cannot add invoice history');
SELECT throws_ok(format($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id,
                    entity_label, field, old_value, new_value)
                  VALUES ('t-a4', 'eeeeeeee-0000-4000-8000-0000000f0001', '2026-12-14T10:00:00.000Z', 'x',
                    'Note', 'n1', 'x', 'text', '', %L)$$, repeat('a', 20001)), '42501',
  'This history entry is too long.', 'a history entry has a size limit (refused, so the app drops it)');
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a13', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Note', 'n1', 'x', 'text', '', 'Gate open', 't-c1', NULL)$$,
  'she adds an entry of her own');
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a14', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Note', 'n2', 'x', 'text', '', 'Dog in yard', 't-c1', NULL)$$,
  'and so does Cal, who has the same name');
SELECT pg_temp.act_as(:sam::uuid);
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a15', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Customer', 't-c2', 'x', 'phone', '', '555', 't-c2', NULL)$$,
  'Sales add customer history');
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a16', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Olive Owner', 'Message', 'm-2', 'x', '(created)', '', 'Hi', 't-c2', 't-j2')$$,
  'and history on any job they read');
SELECT pg_temp.act_as(:own::uuid);
SELECT lives_ok($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id, entity_label, field, old_value, new_value, customer_id, job_id) VALUES ('t-a5', 'eeeeeeee-0000-4000-8000-0000000f0001', '2020-01-01T10:00:00.000Z', 'Automation', 'Job', 't-j2', 'x', 'status', '', '', 't-c2', 't-j2')$$,
  'the office adds history as before');
SELECT lives_ok(format($$INSERT INTO public.audit_log (id, company_id, timestamp, actor, entity, entity_id,
                    entity_label, field, old_value, new_value)
                  VALUES ('t-a17', 'eeeeeeee-0000-4000-8000-0000000f0001', '2026-12-14T10:00:00.000Z', 'x',
                    'Note', 'n1', 'x', 'text', '', %L)$$, repeat('a', 20001)),
  'the size limits are for crew only');
SELECT pg_temp.as_db();
SELECT is((SELECT actor || ' ' || (actor_user = :gus::uuid)::text FROM public.audit_log WHERE id = 't-a1'),
  'Gus Ground true', 'a crew entry is signed with the login''s own name and login, not the ones sent');
SELECT is((SELECT job_id FROM public.audit_log WHERE id = 't-a7'), 't-j1', 'the job id is filled in');
SELECT is((SELECT string_agg(actor, ' / ' ORDER BY id) FROM public.audit_log WHERE id IN ('t-a13', 't-a14')),
  'Cal Climb (t-ivy) / Cal Climb (t-cal)', 'two people with one name are told apart by their card');
SELECT is((SELECT count(*)::int FROM public.audit_log
            WHERE id IN ('t-a2', 't-a3', 't-a4', 't-a8', 't-a10', 't-a11', 't-a12')), 0,
  'the refused entries were not saved');
SELECT is((SELECT actor || ' ' || (actor_user = :own::uuid)::text FROM public.audit_log WHERE id = 't-a5'),
  'Automation true', 'an office entry keeps its name, and records the login');
SELECT is((SELECT actor FROM public.audit_log WHERE entity = 'Job' AND entity_id = 't-j1' AND field = 'value'
             AND company_id = :co::uuid LIMIT 1),
  'Cal Climb', 'change_job_price still writes its own history');

-- ---------- the struck-out old price (column from the money branch) ----------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS replaced_price numeric;
GRANT UPDATE (replaced_price) ON public.jobs TO authenticated;
SELECT pg_temp.act_as(:cal::uuid);
SELECT throws_ok($$UPDATE public.jobs SET replaced_price = 1 WHERE id = 't-j1'$$, '42501',
  'A price change needs a reason: use "Change the price" on the job.',
  'a Climber cannot set the struck-out old price by hand');
SELECT pg_temp.as_db();

-- ---------- personal notes belong to the login ----------
SELECT pg_temp.act_as(:cal::uuid);
SELECT lives_ok($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text)
                  VALUES ('t-n1', 'eeeeeeee-0000-4000-8000-0000000f0001', 't-c1', 'personal', 'Cal Climb',
                    '2026-12-14T10:00:00.000Z', 'Gate code 1234')$$,
  'a Climber writes a personal note');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 't-n1'), 1, 'and reads it');
SELECT pg_temp.act_as(:ivy::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 't-n1'), 0,
  'someone with the same name cannot read it');
UPDATE public.private_notes SET text = 'changed' WHERE id = 't-n1';
DELETE FROM public.private_notes WHERE id = 't-n1';
SELECT lives_ok(format($$INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text,
                    author_user)
                  VALUES ('t-n2', 'eeeeeeee-0000-4000-8000-0000000f0001', 't-c1', 'personal', 'Cal Climb',
                    '2026-12-14T10:00:00.000Z', 'Mine', %L)$$, :cal),
  'she writes her own note (the login sent with it is ignored)');
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 't-n2'), 1, 'and reads it');
SELECT pg_temp.act_as(:cal::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 't-n2'), 0,
  'Cal cannot read her note either');
SELECT lives_ok($$UPDATE public.private_notes SET text = 'Gate code 5678', author_user = NULL WHERE id = 't-n1'$$,
  'Cal edits his note');
SELECT pg_temp.as_db();
SELECT is((SELECT text || ' ' || (author_user = :cal::uuid)::text FROM public.private_notes WHERE id = 't-n1'),
  'Gate code 5678 true', 'only Cal changed it, and it still belongs to him');
SELECT is((SELECT author_user FROM public.private_notes WHERE id = 't-n2'), :ivy::uuid,
  'her note belongs to her login');

-- ---------- old personal notes, linked once by name ----------
INSERT INTO public.private_notes (id, company_id, customer_id, kind, author, created_at, text) VALUES
  ('t-old1', :co::uuid, 't-c1', 'personal', 'Gus Ground', '2026-01-01T10:00:00.000Z', 'Old one'),
  ('t-old2', :co::uuid, 't-c1', 'personal', 'Cal Climb', '2026-01-01T10:00:00.000Z', 'Old two');
SELECT public.link_old_personal_notes();
SELECT is((SELECT author_user FROM public.private_notes WHERE id = 't-old1'), :gus::uuid,
  'an old note goes to the one login with that name');
SELECT is((SELECT author_user FROM public.private_notes WHERE id = 't-old2'), NULL::uuid,
  'with two logins of that name, it goes to nobody');
SELECT pg_temp.act_as(:cal::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 't-old2'), 0,
  'and neither of them can open it');
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.private_notes WHERE id = 't-old1'), 1,
  'the linked note opens for its author');
SELECT pg_temp.as_db();

SELECT * FROM finish();
ROLLBACK;
