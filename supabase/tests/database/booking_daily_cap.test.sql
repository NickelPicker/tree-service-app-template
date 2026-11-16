-- The "booking daily cap" rules: public booking limits
-- that a made-up IP address does not get around.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(12);

\set co '''eeeeeeee-0000-4000-8000-0000000e0001'''
INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Booking Co');
DELETE FROM public.booking_rate_limits;

-- 1-3: only the service role (the edge function) may use it.
SELECT ok(NOT has_function_privilege('anon', 'public.booking_limits_take(text, text, int, int, int, int)', 'EXECUTE'),
  'the public cannot call booking_limits_take');
SELECT ok(NOT has_function_privilege('authenticated', 'public.booking_limits_take(text, text, int, int, int, int)', 'EXECUTE'),
  'signed-in users cannot call it either');
SELECT ok(has_function_privilege('service_role', 'public.booking_limits_take(text, text, int, int, int, int)', 'EXECUTE'),
  'the booking function (service role) can');

-- 4-5: per visitor.
SELECT is((SELECT array_agg(public.booking_limits_take('ip-a', NULL)) FROM generate_series(1, 5)),
  ARRAY['ok', 'ok', 'ok', 'ok', 'ok'], 'five requests an hour from one visitor are fine');
SELECT is(public.booking_limits_take('ip-a', NULL), 'visitor', 'the sixth from that visitor is refused');

-- 6-7: per phone number, whatever the IP says.
SELECT is((SELECT array_agg(public.booking_limits_take('ip-' || g, 'phone-1')) FROM generate_series(1, 3) g),
  ARRAY['ok', 'ok', 'ok'], 'three requests a day with one phone number are fine, from any address');
SELECT is(public.booking_limits_take('ip-new', 'phone-1'), 'visitor',
  'a fourth with the same phone number is refused even from a new address');

-- 8-9: everyone together per day (here a cap of 10, 8 already used).
SELECT is(public.booking_limits_take('ip-x1', 'phone-x1', 5, 3, 10), 'ok', 'the 9th request today is fine');
SELECT is((SELECT array_agg(public.booking_limits_take('ip-y' || g, 'phone-y' || g, 5, 3, 10)) FROM generate_series(1, 2) g),
  ARRAY['ok', 'daily'], 'past the daily cap every new visitor is refused');

-- 10: refused requests are not counted against anyone.
SELECT is((SELECT count(*)::int FROM public.booking_rate_limits), 10, 'only accepted requests are counted');

-- 11-12: a full waiting list.
DELETE FROM public.booking_rate_limits;
INSERT INTO public.booking_requests (id, company_id, date, requested_at, status)
  SELECT 'cap-' || g, :co::uuid, '2026-12-01', '2026-11-16', 'pending' FROM generate_series(1, 3) g;
SELECT is(public.booking_limits_take('ip-z', 'phone-z', 5, 3, 40,
            (SELECT count(*)::int FROM public.booking_requests WHERE status = 'pending')),
  'backlog', 'when the waiting list is full, the page says call us');
SELECT is(public.booking_limits_take('ip-z', 'phone-z', 5, 3, 40,
            (SELECT count(*)::int + 1 FROM public.booking_requests WHERE status = 'pending')),
  'ok', 'with room on the list it goes through');

SELECT * FROM finish();
ROLLBACK;
