-- Phase 4 — public booking form (audit SEC-6).
-- Run with: supabase test db
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(9);

\set co '''11111111-1111-4111-8111-111111111111'''

SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'booking_requests' AND 'anon' = ANY (roles)),
  'booking_requests has no policy for anon');
SELECT ok(NOT has_table_privilege('anon', 'public.booking_requests', 'INSERT'),
  'anon cannot insert into booking_requests');

SET LOCAL ROLE anon;
SELECT throws_ok(
  format($$INSERT INTO public.booking_requests (id, company_id, date, requested_at, name)
           VALUES ('x', %L, '2026-12-01', '2026-11-01', 'bot')$$, :co),
  '42501', NULL, 'a direct insert with the anon key fails');
SELECT throws_ok($$SELECT public.booking_rate_limit_take('ip')$$, '42501', NULL,
  'anon cannot call the rate-limit function');
SELECT throws_ok($$SELECT count(*) FROM public.booking_rate_limits$$, '42501', NULL,
  'anon cannot read the rate-limit table');
RESET ROLE;

SELECT throws_ok(
  format($$INSERT INTO public.booking_requests (id, company_id, date, requested_at, name)
           VALUES ('long', %L, '2026-12-01', '2026-11-01', repeat('a', 101))$$, :co),
  '23514', NULL, 'the database rejects a name over 100 characters');
SELECT throws_ok(
  format($$INSERT INTO public.booking_requests (id, company_id, date, requested_at, details)
           VALUES ('long2', %L, '2026-12-01', '2026-11-01', repeat('a', 2001))$$, :co),
  '23514', NULL, 'the database rejects details over 2,000 characters');

-- Five allowed per hour, then refused (run as the service role's owner).
SELECT is(
  (SELECT array_agg(public.booking_rate_limit_take('test-ip')) FROM generate_series(1, 5)),
  ARRAY[true, true, true, true, true],
  'the first five requests from one IP are allowed');
SELECT is(public.booking_rate_limit_take('test-ip'), false, 'the sixth request in an hour is refused');

SELECT * FROM finish();
ROLLBACK;
