-- The "promised start time" rules.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(3);
SELECT has_column('public', 'jobs', 'time_promised', 'jobs.time_promised exists');
SELECT col_not_null('public', 'jobs', 'time_promised', 'time_promised is never null');
SELECT col_default_is('public', 'jobs', 'time_promised', 'false', 'existing and new jobs start unticked');
SELECT * FROM finish();
ROLLBACK;
