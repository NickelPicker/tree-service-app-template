-- The "company documents" rules: Licences & insurance.
-- Staff (owner, manager, office) read and write documents and their
-- uploaded files; crew and signed-out visitors get nothing; another
-- company sees nothing; files are at most 5 MB and really are the
-- type they claim; a replaced or deleted document's file is removed.
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
CREATE FUNCTION pg_temp.as_anon()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;
CREATE FUNCTION pg_temp.as_db()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
-- A tiny valid file body of each type, as base64.
CREATE FUNCTION pg_temp.b64(p bytea) RETURNS text LANGUAGE sql AS $$
  SELECT replace(encode(p, 'base64'), E'\n', '');
$$;
CREATE FUNCTION pg_temp.pdf() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.b64(convert_to('%PDF-1.4 tiny test file', 'UTF8'));
$$;
CREATE FUNCTION pg_temp.png() RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.b64('\x89504e470d0a1a0a0000000d49484452'::bytea);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.b64(bytea), pg_temp.pdf(), pg_temp.png() TO authenticated, anon;

\set co    '''aaaaaaaa-0000-4000-8000-0000000cd001'''
\set other '''aaaaaaaa-0000-4000-8000-0000000cd002'''
\set boss  '''bbbbbbbb-0000-4000-8000-0000000cd001'''
\set mgr   '''bbbbbbbb-0000-4000-8000-0000000cd002'''
\set desk  '''bbbbbbbb-0000-4000-8000-0000000cd003'''
\set gus   '''bbbbbbbb-0000-4000-8000-0000000cd004'''
\set far   '''bbbbbbbb-0000-4000-8000-0000000cd005'''

INSERT INTO public.companies (id, name) VALUES (:co::uuid, 'Docs Co'), (:other::uuid, 'Other Docs Co');
SELECT pg_temp.signup(:boss::uuid, 'boss-cd@example.com');
SELECT pg_temp.signup(:mgr::uuid, 'mgr-cd@example.com');
SELECT pg_temp.signup(:desk::uuid, 'desk-cd@example.com');
SELECT pg_temp.signup(:gus::uuid, 'gus-cd@example.com');
SELECT pg_temp.signup(:far::uuid, 'far-cd@example.com');
DELETE FROM public.company_members WHERE user_id IN (:boss::uuid, :mgr::uuid, :desk::uuid, :gus::uuid, :far::uuid);
INSERT INTO public.company_members (user_id, company_id, role) VALUES
  (:boss::uuid, :co::uuid, 'owner'), (:mgr::uuid, :co::uuid, 'manager'),
  (:desk::uuid, :co::uuid, 'office'), (:gus::uuid, :co::uuid, 'crew'),
  (:far::uuid, :other::uuid, 'owner');
UPDATE public.crew SET id = 'cd-boss', name = 'Bo Boss', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :boss::uuid;
UPDATE public.crew SET id = 'cd-mgr', name = 'Mo Manager', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :mgr::uuid;
UPDATE public.crew SET id = 'cd-desk', name = 'Olive Office', company_id = :co::uuid, status = 'active' WHERE auth_user_id = :desk::uuid;
UPDATE public.crew SET id = 'cd-gus', name = 'Gus Ground', company_id = :co::uuid, status = 'active', role = 'Climber' WHERE auth_user_id = :gus::uuid;
UPDATE public.crew SET id = 'cd-far', name = 'Far Away', company_id = :other::uuid, status = 'active' WHERE auth_user_id = :far::uuid;

-- 1-6: structure
SELECT has_table('public', 'company_documents', 'company_documents exists');
SELECT has_table('public', 'company_document_files', 'company_document_files exists');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.company_documents'::regclass), true, 'documents have RLS on');
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.company_document_files'::regclass), true, 'files have RLS on');
SELECT is(has_table_privilege('anon', 'public.company_documents', 'SELECT')
  OR has_table_privilege('anon', 'public.company_document_files', 'SELECT')
  OR has_table_privilege('anon', 'public.company_documents', 'INSERT')
  OR has_table_privilege('anon', 'public.company_document_files', 'INSERT'), false,
  'signed-out visitors have no privileges on either table');
SELECT is(has_table_privilege('authenticated', 'public.company_document_files', 'UPDATE'), false,
  'an uploaded file is never edited, only replaced');

-- 7-14: staff write
SELECT pg_temp.act_as(:desk::uuid);
SELECT lives_ok($$INSERT INTO public.company_document_files (id, company_id, file_name, mime_type, size_bytes, data_base64)
  VALUES ('cd-f1', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'gl.pdf', 'application/pdf', 23, pg_temp.pdf())$$,
  'office uploads a PDF');
SELECT lives_ok($$INSERT INTO public.company_documents (id, company_id, kind, name, issuer, start_date, expiry_date, file_id, file_name)
  VALUES ('cd-d1', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'liability_insurance', 'GL-123', 'Acme Mutual', '2026-01-01', '2026-12-31', 'cd-f1', 'gl.pdf')$$,
  'office adds a liability insurance document with its file');
SELECT pg_temp.act_as(:mgr::uuid);
SELECT lives_ok($$INSERT INTO public.company_document_files (id, company_id, file_name, mime_type, size_bytes, data_base64)
  VALUES ('cd-f2', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'isa.png', 'image/png', 16, pg_temp.png())$$,
  'a manager uploads a photo');
SELECT lives_ok($$INSERT INTO public.company_documents (id, company_id, kind, name, crew_id, expiry_date, file_id)
  VALUES ('cd-d2', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'arborist_certification', 'RM-0001A', 'cd-gus', '2027-06-30', 'cd-f2')$$,
  'a manager adds a crew member''s certification');
SELECT pg_temp.act_as(:boss::uuid);
SELECT lives_ok($$INSERT INTO public.company_documents (id, company_id, kind, name)
  VALUES ('cd-d3', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'business_licence', 'City tree licence')$$,
  'an owner adds a document with no file yet');
UPDATE public.company_documents SET notes = 'Renew in December' WHERE id = 'cd-d1';
SELECT is((SELECT notes FROM public.company_documents WHERE id = 'cd-d1'), 'Renew in December', 'an owner edits a document');
SELECT pg_temp.act_as(:desk::uuid);
UPDATE public.company_documents SET issuer = 'Acme Mutual Ins.' WHERE id = 'cd-d1';
SELECT is((SELECT issuer FROM public.company_documents WHERE id = 'cd-d1'), 'Acme Mutual Ins.', 'office edits a document');
SELECT throws_ok($$INSERT INTO public.company_documents (id, company_id, kind) VALUES ('cd-bad', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'passport')$$,
  '23514', NULL, 'only the listed kinds');

-- 15-20: staff read
SELECT pg_temp.act_as(:desk::uuid);
SELECT is((SELECT count(*)::int FROM public.company_documents WHERE company_id = :co::uuid), 3, 'office reads every document');
SELECT is((SELECT count(*)::int FROM public.company_document_files WHERE company_id = :co::uuid), 2, 'office reads the files');
SELECT is((SELECT convert_from(decode(data_base64, 'base64'), 'UTF8') FROM public.company_document_files WHERE id = 'cd-f1'),
  '%PDF-1.4 tiny test file', 'the file comes back exactly as uploaded');
SELECT pg_temp.act_as(:mgr::uuid);
SELECT is((SELECT count(*)::int FROM public.company_documents), 3, 'a manager reads every document');
SELECT pg_temp.act_as(:boss::uuid);
SELECT is((SELECT count(*)::int FROM public.company_document_files), 2, 'an owner reads the files');
SELECT is((SELECT count(*)::int FROM public.company_documents), 3, 'an owner reads every document');

-- 21-27: crew get nothing, even their own certification
SELECT pg_temp.act_as(:gus::uuid);
SELECT is((SELECT count(*)::int FROM public.company_documents), 0, 'crew cannot read documents (not even their own)');
SELECT is((SELECT count(*)::int FROM public.company_document_files), 0, 'crew cannot read files');
SELECT throws_ok($$INSERT INTO public.company_documents (id, company_id, kind) VALUES ('cd-c1', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'other')$$,
  '42501', NULL, 'crew cannot add documents');
SELECT throws_ok($$INSERT INTO public.company_document_files (id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('cd-cf', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'application/pdf', 23, pg_temp.pdf())$$,
  '42501', NULL, 'crew cannot upload files');
UPDATE public.company_documents SET name = 'hacked' WHERE id = 'cd-d2';
DELETE FROM public.company_documents WHERE id = 'cd-d1';
DELETE FROM public.company_document_files WHERE id = 'cd-f1';
SELECT pg_temp.as_db();
SELECT is((SELECT name FROM public.company_documents WHERE id = 'cd-d2'), 'RM-0001A', 'crew cannot change documents');
SELECT is((SELECT count(*)::int FROM public.company_documents WHERE id = 'cd-d1'), 1, 'crew cannot delete documents');
SELECT is((SELECT count(*)::int FROM public.company_document_files WHERE id = 'cd-f1'), 1, 'crew cannot delete files');

-- 28-29: signed-out visitors
SELECT pg_temp.as_anon();
SELECT throws_ok($$SELECT count(*) FROM public.company_documents$$, '42501', NULL, 'signed-out visitors cannot read documents');
SELECT throws_ok($$SELECT count(*) FROM public.company_document_files$$, '42501', NULL, 'signed-out visitors cannot read files');

-- 30-34: another company
SELECT pg_temp.act_as(:far::uuid);
SELECT is((SELECT count(*)::int FROM public.company_documents) + (SELECT count(*)::int FROM public.company_document_files), 0,
  'another company''s owner sees no documents or files');
SELECT throws_ok($$INSERT INTO public.company_documents (id, company_id, kind) VALUES ('cd-x1', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'other')$$,
  '42501', NULL, 'another company cannot add a document here');
UPDATE public.company_documents SET name = 'x' WHERE id = 'cd-d1';
DELETE FROM public.company_documents WHERE id = 'cd-d3';
SELECT pg_temp.as_db();
SELECT is((SELECT count(*)::int FROM public.company_documents WHERE (id = 'cd-d1' AND name = 'GL-123') OR id = 'cd-d3'), 2,
  'another company cannot change or delete documents here');
SELECT pg_temp.act_as(:far::uuid);
SELECT lives_ok($$INSERT INTO public.company_document_files (id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('cd-ff', 'aaaaaaaa-0000-4000-8000-0000000cd002', 'application/pdf', 23, pg_temp.pdf())$$,
  'another company uploads its own file');
SELECT pg_temp.act_as(:desk::uuid);
SELECT throws_ok($$UPDATE public.company_documents SET file_id = 'cd-ff' WHERE id = 'cd-d3'$$,
  '23503', NULL, 'a document cannot point at another company''s file');

-- 35-38: size and type are checked by the database
SELECT pg_temp.act_as(:desk::uuid);
SELECT throws_ok($$INSERT INTO public.company_document_files (id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('cd-big', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'application/pdf', 5242881, pg_temp.pdf())$$,
  '23514', NULL, 'a file over 5 MB is refused');
SELECT throws_ok($$INSERT INTO public.company_document_files (id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('cd-lie', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'application/pdf', 3,
    'JVBERi0' || repeat('A', 7000000))$$,
  '23514', NULL, 'the stored text must match the stated size (no hiding a big file behind a small size)');
SELECT throws_ok($$INSERT INTO public.company_document_files (id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('cd-html', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'application/pdf', 15,
    pg_temp.b64(convert_to('<script>x</scri', 'UTF8')))$$,
  '23514', NULL, 'a file that is not really a PDF is refused');
SELECT throws_ok($$INSERT INTO public.company_document_files (id, company_id, mime_type, size_bytes, data_base64)
  VALUES ('cd-svg', 'aaaaaaaa-0000-4000-8000-0000000cd001', 'image/svg+xml', 24, pg_temp.pdf())$$,
  '23514', NULL, 'only PDF, JPEG and PNG');

-- 39-40: replaced and deleted files are removed
SELECT pg_temp.act_as(:desk::uuid);
INSERT INTO public.company_document_files (id, company_id, file_name, mime_type, size_bytes, data_base64)
  VALUES ('cd-f3', :co::uuid, 'gl-2027.pdf', 'application/pdf', 23, pg_temp.pdf());
UPDATE public.company_documents SET file_id = 'cd-f3', file_name = 'gl-2027.pdf' WHERE id = 'cd-d1';
DELETE FROM public.company_documents WHERE id = 'cd-d2';
SELECT pg_temp.as_db();
SELECT is((SELECT array_agg(id ORDER BY id)::text FROM public.company_document_files WHERE company_id = :co::uuid), '{cd-f3}',
  'the replaced file and the deleted document''s file are gone');
SELECT is((SELECT file_id FROM public.company_documents WHERE id = 'cd-d1'), 'cd-f3', 'the document keeps its new file');

SELECT * FROM finish();
ROLLBACK;
