-- Read-only fingerprint of the public schema (structure only, never row
-- data). One sorted line per object; bodies are reduced to md5 so the
-- output stays short. Used by the deploy "check" run to compare the live
-- project with the migrations before anything is deployed.
with lines as (
  select 'table ' || c.relname || ' rls=' || c.relrowsecurity as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
  union all
  select 'view ' || c.relname || ' ' || md5(pg_get_viewdef(c.oid))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
  union all
  select 'column ' || table_name || '.' || column_name || ' ' || data_type
         || ' null=' || is_nullable || ' default=' || coalesce(column_default, '')
    from information_schema.columns where table_schema = 'public'
  union all
  select 'policy ' || tablename || ' | ' || policyname || ' | ' || cmd || ' | '
         || array_to_string(roles, ',') || ' | '
         || md5(coalesce(qual, '') || '//' || coalesce(with_check, ''))
    from pg_policies where schemaname = 'public'
  union all
  select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
         || md5(p.prosrc) || ' secdef=' || p.prosecdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
  union all
  select 'trigger ' || n.nspname || '.' || c.relname || ' ' || t.tgname || ' '
         || md5(pg_get_triggerdef(t.oid))
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal and n.nspname in ('public', 'auth')
  union all
  select 'constraint ' || conrelid::regclass::text || ' ' || conname || ' '
         || md5(pg_get_constraintdef(oid))
    from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select 'index ' || indexname || ' ' || md5(indexdef)
    from pg_indexes where schemaname = 'public'
  union all
  select 'realtime ' || tablename
    from pg_publication_tables where pubname = 'supabase_realtime'
)
select string_agg(line, E'\n' order by line) as fingerprint from lines;
