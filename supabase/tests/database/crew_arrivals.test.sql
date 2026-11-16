-- The "crew arrival times" rules.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(4);

SELECT has_column('public', 'jobs', 'crew_arrivals', 'jobs.crew_arrivals exists');
SELECT col_type_is('public', 'jobs', 'crew_arrivals', 'jsonb', 'crew_arrivals is jsonb');
SELECT col_is_null('public', 'jobs', 'crew_arrivals', 'crew_arrivals is optional');

INSERT INTO public.companies (id, name) VALUES ('aaaaaaaa-0000-4000-8000-00000000a0a1', 'Arrivals Co');
SELECT throws_ok(
  $$INSERT INTO public.jobs (id, company_id, customer_id, service_type, date, status, crew_arrivals)
    VALUES ('arr-1', 'aaaaaaaa-0000-4000-8000-00000000a0a1', 'c', 'Removal', '2026-11-20', 'scheduled', '["08:00"]'::jsonb)$$,
  '23514', NULL, 'crew_arrivals must be an object (crew id -> time)');

SELECT * FROM finish();
ROLLBACK;
