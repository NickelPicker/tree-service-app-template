# Rules for AI assistants working on this repo

Read `README.md` first: it describes what the app does, how it is set
up (Supabase, Netlify, GitHub Actions), the security model and how
changes ship. When a business rule is unclear, ask the owner of this
copy instead of guessing.

## Database
1. Every database change is a **new** file in `supabase/migrations/`
   (`npx supabase migration new <name>`). Never edit a migration that is
   already applied (that includes `20260101000000_baseline.sql`). Never
   tell the owner to paste SQL into the Supabase dashboard.
2. Every new table gets `alter table ... enable row level security;`,
   role-based policies, and pgTAP tests in `supabase/tests/database/`,
   all in the same pull request.
3. Never weaken or remove a row-level security policy without a pgTAP
   test that proves the new rule.
4. Test against a local Supabase only: `npx supabase start`, then
   `npx supabase test db`. Supabase CLI 3 targets the local database
   unless `--remote` is given; never pass `--remote` from a laptop or an
   agent session: the deploy workflow is the only thing that changes the
   live project.
5. After a migration that changes structure, regenerate
   `.github/diagnostics/expected_after_deploy.txt` from a fresh local
   database (`npx supabase db reset`, then run
   `.github/diagnostics/structure_fingerprint.sql` with
   `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -Atq -f ...`).
   If a migration changes someone's role on purpose, list it in
   `.github/diagnostics/expected_role_changes.txt`
   (`<login id> <company id> <old role> <new role>`, one per line).
6. The business time zone lives in three places that must agree:
   `supabase/functions/_shared/businessSettings.ts`
   (`BUSINESS_TIME_ZONE`, re-exported by `src/businessSettings.ts`) and
   the database function `public.business_time_zone()` (changed only by
   a new migration). `src/__tests__/businessSettings.test.ts` checks it.

## Secrets and config
7. Never put the `service_role` / secret key or any other secret in
   `src/`, `public/`, a migration, or the git history. Secrets live only
   in GitHub Actions secrets and Supabase function secrets.
8. `src/config.ts` holds no values of its own: the deploy builds the site
   with the public GitHub variables `SUPABASE_PROJECT_REF`,
   `SUPABASE_PUBLISHABLE_KEY` and `TURNSTILE_SITE_KEY`. The company id is
   fixed (`11111111-1111-4111-8111-111111111111`) and must match the
   baseline migration.
9. Never print customer data or email addresses in CI logs. Read-only
   reports print counts, names and roles only.

## Shipping
10. One pull request per change. The **Checks** workflow (lint, types,
    build, unit tests, package audit, database tests, secret scan) must
    pass.
11. Merging to `main` deploys (tests → rehearsal on a copy of the live
    data → backup → migrations → website → verify). Never push straight
    to `main`. Do not connect the Netlify site to GitHub.
12. When the app starts using a new outside service (image host, API,
    script), add its address to the Content-Security-Policy in
    `netlify.toml`, or the browser will block it.
13. Email safety: the GitHub variables `GMAIL_SENDING` (default off) and
    `EMAIL_TEST_MODE` (default on) are the owner's switches. Never change
    their defaults in the workflows or the functions.

## Running locally
- `npm ci`, then `npm run dev`. Without a `.env.local` the app runs on
  the in-browser demo adapter. For a local Supabase, put
  `VITE_SUPABASE_URL=http://127.0.0.1:54321` and
  `VITE_SUPABASE_PUBLISHABLE_KEY=<from npx supabase status>` in
  `.env.local` (never committed).
- `npm run lint`, `npx tsc -b`, `npm test`, `npm run build`.
- `npx supabase start -x studio,imgproxy,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit`
  then `npx supabase test db`.
