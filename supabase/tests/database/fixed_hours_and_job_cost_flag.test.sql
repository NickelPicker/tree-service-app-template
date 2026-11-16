-- The "fixed hours and job cost flag" rules.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(5);
SELECT has_column('public', 'crew', 'fixed_weekly_hours', 'crew.fixed_weekly_hours exists');
SELECT has_column('public', 'crew', 'counted_on_every_job', 'crew.counted_on_every_job exists');
SELECT col_default_is('public', 'crew', 'counted_on_every_job', 'false', 'nobody is counted on every job unless ticked');
INSERT INTO public.companies (id, name) VALUES ('aaaaaaaa-0000-4000-8000-00000000f1f1', 'Hours Co');
SELECT throws_ok(
  $$INSERT INTO public.crew (id, company_id, name, fixed_weekly_hours) VALUES ('fh-1', 'aaaaaaaa-0000-4000-8000-00000000f1f1', 'Too Many', 100)$$,
  '23514', NULL, 'fixed weekly hours must be 0-80');
SELECT lives_ok(
  $$INSERT INTO public.crew (id, company_id, name, fixed_weekly_hours) VALUES ('fh-2', 'aaaaaaaa-0000-4000-8000-00000000f1f1', 'Part Time', 32)$$,
  '32 fixed hours is fine');
SELECT * FROM finish();
ROLLBACK;
