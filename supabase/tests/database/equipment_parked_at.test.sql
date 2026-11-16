-- The "equipment parked at and planning shop" rules.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(3);

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

SELECT pg_temp.signup('aaaaaaaa-0000-4000-8000-0000000000c1', 'crew-park@example.com');
SELECT pg_temp.signup('aaaaaaaa-0000-4000-8000-0000000000c2', 'office-park@example.com');
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000c1', '11111111-1111-4111-8111-111111111111', 'crew'),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', '11111111-1111-4111-8111-111111111111', 'office');
INSERT INTO public.equipment (id, company_id, name, kind, details, status)
VALUES ('park-dump', '11111111-1111-4111-8111-111111111111', 'Dump trailer', 'Dump trailer', '', 'available');

SELECT has_column('public', 'equipment', 'home_site', 'equipment has a parked-at shop');

SELECT pg_temp.act_as('aaaaaaaa-0000-4000-8000-0000000000c1');
SELECT is_empty($$UPDATE public.equipment SET home_site = 'Tejon' WHERE id = 'park-dump' RETURNING 1$$,
  'crew cannot change where equipment is parked');
RESET ROLE;

SELECT pg_temp.act_as('aaaaaaaa-0000-4000-8000-0000000000c2');
SELECT isnt_empty($$UPDATE public.equipment SET home_site = 'Tejon' WHERE id = 'park-dump' RETURNING 1$$,
  'office can set where equipment is parked');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
