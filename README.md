# Tree Service App

A web app for running a tree-service business, made to be copied and
used by any tree company. It works on computers and installs on phones
like an app (no app store).

**What it does**

- **Customers**: contact details, several addresses, notes, history,
  a customer map, and suggested changes from the field that the office
  approves.
- **Scheduling**: a drag-and-drop calendar, a day "plan board" that
  suggests who goes where (skills, drivers, trucks, least driving), and
  a crew view on phones with each day's jobs, directions and times.
- **Estimates and invoices**: options, a private "accept online" link
  for customers, invoices made when a job is done, split invoices, how
  to pay, overdue tracking, and optional automatic emails.
- **Crew and time**: clock in and out on the phone, time off, weekly
  pay with overtime, skills, roles (owner, manager, office, crew) and
  optional two-step login.
- **Equipment**: trucks and trailers, maintenance, problem reports with
  photos.
- **Trees and plant health care**: a tree map per property, care
  programs, a field guide, licences and insurance documents.
- **A public booking page** where customers can ask for an estimate.

It starts completely empty. The first time the owner signs in, a setup
wizard asks for the business details.

**How it is built** (you do not need to understand this to set it up):
the website is a React app published on **Netlify**; the data lives in
**Supabase** (a Postgres database with row-level security, so each
login only sees what its role allows); **GitHub Actions** tests and
publishes every change for you.

---

## What you need

All of these have free plans that cover a small crew.

1. A **GitHub** account (where your copy of the app lives).
2. A **Supabase** account: [supabase.com](https://supabase.com) (the
   database and logins).
3. A **Netlify** account: [netlify.com](https://www.netlify.com) (the
   website).
4. Optional: a **Gmail** account for the business, with 2-Step
   Verification on, so you can make a Gmail **app password**. The app
   uses it to send estimates, invoices, day plans and login emails. You
   can add it later.
5. Optional: a **Cloudflare** account for the Turnstile spam check on
   the booking page and the login screen.

A computer for the one-time setup (about an hour). No programming.

---

## Step 1: Make your own copy

1. On this repository's GitHub page, click **Use this template →
   Create a new repository**.
2. Pick the owner (you), give it a name (for example
   `my-tree-app`), choose **Private**, and click **Create repository**.
3. Your copy has its own history and settings. Nothing you do there
   touches the original.

## Step 2: Create your Supabase project (the database)

1. Sign in at [supabase.com](https://supabase.com) and click **New
   project**.
2. Pick a name (your business name is fine), choose a **database
   password** and save it in a password manager: you will paste it into
   GitHub in Step 4. Pick the region closest to you and click **Create
   new project**. It takes a minute or two.
3. In the left sidebar open **Authentication → Sign In / Providers →
   Email** and check that **Confirm email** is **on** (it is on by
   default). **Never turn it off.** The app only trusts an email address
   after its owner clicks the confirmation link; the deploy refuses to
   run while it is off.
4. Write down three things (you will paste them into GitHub in Step 4):
   - **Project ID** (also called the project ref): **Project Settings →
     General → Project ID**. 20 letters and numbers, for example
     `abcdefghijklmnopqrst`.
   - **Publishable key**: **Project Settings → API Keys**, the key that
     starts with `sb_publishable_`. It is meant to be public.
   - An **access token**: click your avatar (top right) → **Account
     preferences → Access Tokens → Generate new token**, name it
     "GitHub deploy". Copy it now; Supabase shows it only once. This
     one is secret.

Do not create any tables by hand and do not paste SQL into the SQL
editor: the deploy builds the whole database from the files in
`supabase/migrations/`.

## Step 3: Create your Netlify site (the website)

The site is published **only** by the GitHub workflow, right after the
database is updated. So you create an empty site by hand and **never
connect it to GitHub**.

1. On your computer, make a folder named `placeholder` with one file
   in it named `index.html` containing the words `Coming soon`.
2. Sign in at [app.netlify.com](https://app.netlify.com). Click **Add
   new project → Deploy manually** and drag the `placeholder` folder
   onto the page.
3. Open the new site → **Project configuration → General → Project
   details → Change project name** (older screens: **Site
   configuration → Change site name**). Pick a name, for example
   `my-tree-app`. Your app's address is then
   `https://my-tree-app.netlify.app`. Write the name down.
4. Make a **personal access token**: your avatar → **User settings →
   Applications → Personal access tokens → New access token**. Name it
   "GitHub deploy", copy it. This one is secret.

Do **not** use "Import from Git" or link the site to your repository:
Netlify would then publish on its own, out of step with the database.

## Step 4: Tell GitHub your settings

In your repository on GitHub open **Settings → Secrets and variables
→ Actions**. There are two tabs: **Secrets** (private, nobody can read
them back) and **Variables** (plain settings). Add each one with **New
repository secret** or **New repository variable**. Names must be
typed exactly as shown.

**Secrets (required)**

| Name | What it is | Where to find it |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Lets the deploy update your database | Step 2.4 (Supabase → Account → Access Tokens) |
| `SUPABASE_DB_PASSWORD` | Your database password | The password you chose in Step 2.2 |
| `NETLIFY_AUTH_TOKEN` | Lets the deploy publish the website | Step 3.4 (Netlify → User settings → Applications) |

**Variables (required)**

| Name | What it is | Example |
|---|---|---|
| `SUPABASE_PROJECT_REF` | Your Supabase Project ID | `abcdefghijklmnopqrst` |
| `SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key | `sb_publishable_...` |
| `NETLIFY_SITE_NAME` | Your Netlify site name (not the whole address) | `my-tree-app` |
| `OWNER_EMAIL` | The email address of the owner's login. When someone signs up with this address and confirms it, they become the owner. | `you@yourcompany.com` |

**Variables (optional)**

| Name | What it is | Default |
|---|---|---|
| `BUSINESS_NAME` | The name emails come from | `Tree Service` |
| `GMAIL_ADDRESS` | The business Gmail that sends emails | none (no emails) |
| `GMAIL_SENDING` | `on` lets the app send through Gmail | off |
| `EMAIL_TEST_MODE` | `off` lets emails reach customers and crew | on (test mode) |
| `EMAIL_TEST_RECIPIENTS` | Your own addresses that may get emails while test mode is on, separated by commas | none |
| `SITE_URL` | Only if you give the site your own web address, e.g. `https://app.yourcompany.com` | `https://<NETLIFY_SITE_NAME>.netlify.app` |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key (spam check) | none |

**Secrets (optional)**

| Name | What it is | Where to find it |
|---|---|---|
| `GMAIL_APP_PASSWORD` | Lets the app send from `GMAIL_ADDRESS` | Google Account → Security → 2-Step Verification → App passwords |
| `TURNSTILE_SECRET_KEY` | Turnstile secret key | Cloudflare → Turnstile → your widget |
| `BACKUP_PASSPHRASE` | Turns on the daily encrypted backup (see "Backups") | Make up a long passphrase and keep a copy in a password manager |

None of these values ever go into the code. The publishable key and
the project ID are public by design; row-level security in the database
is what protects your data.

## Step 5: The first deploy

1. In your repository open the **Actions** tab. If GitHub asks, click
   **I understand my workflows, go ahead and enable them**.
2. Click **Deploy Supabase** on the left, then **Run workflow**. Leave
   the mode on **check** and click the green **Run workflow** button.
   This changes nothing: it checks your settings and rehearses the
   deploy on a throwaway copy. If a step says something is missing,
   fix that setting in Step 4 and run it again.
3. When the check is green, run it again with mode **deploy**. It:
   tests the database rules, builds the website with your settings,
   rehearses on a copy, makes a backup, creates the database, sets up
   the email functions and login settings, publishes the website, and
   checks that everything is live. It takes about 10 minutes.
4. From now on you do not run it by hand: **every change merged into
   `main` deploys by itself**, the same way. Changes only to `.md`
   files skip the deploy.

## Step 6: First login and the setup wizard

1. Open your app at `https://<your site name>.netlify.app`.
2. Tap **Create account** and sign up with exactly the `OWNER_EMAIL`
   address, choose a password (at least 10 characters) and type your
   name.
3. Open the confirmation email and click the link. Only then does the
   login become the **owner**.
   - Until you set up Gmail (Step 7), login emails come from Supabase's
     built-in sender, which only delivers to members of your Supabase
     organization and only a few per hour. Use the email address you
     signed up to Supabase with as `OWNER_EMAIL`, or add your address in
     Supabase → **Organization settings → Team** first.
4. Sign in. The **setup wizard** asks for your business name, phone,
   email, address, shop locations (for clock-in and drive times) and how
   customers pay you. Nothing else opens until it is done; you can
   change all of it later.
5. The Dashboard shows **Finish setting up**: a short checklist (pay
   details, review link, planning shop, truck weights, crew skills,
   insurance on file...). It ticks itself as you go.
6. Add your team: each person signs up on the same page with their own
   email. They appear on the **Users** page as waiting for approval;
   the owner or a manager approves them and picks their role (manager,
   office or crew).

On phones, open the site and use **Add to Home Screen** (iPhone:
Share button; Android: browser menu) to install it like an app.

## Step 7: Turning on email safely

Email is **off** until you switch it on, and then starts in **test
mode**, where only your own addresses can get anything. Nothing can
reach a customer by accident while you try things out.

1. In your Google account (the business Gmail), turn on **2-Step
   Verification**, then create an **App password** (Google Account →
   Security → App passwords). Copy the 16 letters.
2. In GitHub (Step 4): save the secret `GMAIL_APP_PASSWORD`, and the
   variables `GMAIL_ADDRESS` (the Gmail address), `BUSINESS_NAME`,
   `EMAIL_TEST_RECIPIENTS` (your own address, for example) and
   `GMAIL_SENDING` = `on`. Leave `EMAIL_TEST_MODE` unset (that means
   on).
3. Apply it: **Actions → Deploy Supabase → Run workflow**, mode
   **email-settings** (about a minute).
4. Try it: email yourself an estimate or an invoice for a test
   customer whose email is one of your test addresses. Emails to anyone
   else are refused with "Test mode: only test addresses get emails
   right now."
5. When you are happy, set the variable `EMAIL_TEST_MODE` to `off` and
   run **email-settings** again. Now emails reach customers and crew,
   and the login emails (sign-up confirmations, password resets) also go
   out through your Gmail, so they reach anyone.
6. **Automatic customer emails** (reminders, past-due notices, the
   invoice when a job is done) have their own master switch on the
   app's **Automations** page. They stay off until you turn them on there,
   and more than 3 emails at once always wait for you to approve them.

To stop all email at once: set `GMAIL_SENDING` to `off` (or delete
it) and run **email-settings**. The workflow checks that the "off"
really stuck.

## Your location: time zone and overtime

The app ships with **Colorado** settings as an example. Check these
before your crew starts clocking in:

- **Time zone** (clock-in times, the 8 PM automatic clock-out, "today"
  for overdue invoices, the hours automatic emails may go out): set in
  `supabase/functions/_shared/businessSettings.ts` (`BUSINESS_TIME_ZONE`,
  for example `America/Chicago`) **and** in the database function
  `public.business_time_zone()`, which needs a new migration (the header
  of `supabase/migrations/20260101000000_baseline.sql` shows the exact
  lines). A test checks the two agree. Ask an AI assistant: "change the
  business time zone to America/Chicago following CLAUDE.md".
- **Overtime** (Weekly pay): set `OVERTIME_RULES` in
  `src/businessSettings.ts`. `"colorado"` = over 40 hours a week, over
  12 in a day, or over 12 in a row; `"weekly40"` = the federal rule,
  over 40 hours a week only. Some states have their own daily rules;
  check yours. Weekly pay is a helper for payroll, not legal advice.
- **Colorado / Denver extras** that you can keep, ignore or change:
  the tree map's "import from the public record" uses a built-in sample
  of Denver's public tree inventory (TreeKeeper); the field guide and
  tree families are written for Front Range species and hardiness
  zones; one of the default skills is a "municipal arborist licence
  (your city)" (rename it on the Skills grid); the default customer state
  is "CO" (change it in `src/customerEdits.ts` and `src/components/CustomerPicker.tsx`); the backup runs at
  09:17 UTC (night in North America; change the time in
  `.github/workflows/backup.yml`).
- **Logo**: the app uses a plain tree icon (`public/logo.svg` and the
  PNG icons next to it). Upload your own logo in the setup wizard (or
  later in the Company settings on the Schedule page), or replace the
  files in `public/`.

## Optional: spam check (Cloudflare Turnstile)

1. In Cloudflare → **Turnstile → Add widget**, add your site's address
   (for example `my-tree-app.netlify.app`).
2. Save the **site key** as the GitHub variable `TURNSTILE_SITE_KEY` and
   the **secret key** as the GitHub secret `TURNSTILE_SECRET_KEY`.
3. Run the deploy (mode **deploy**). The booking page and the login
   screen then show the check.

## Backups and how to restore one

- **Before every deploy** the workflow copies every table into a
  `backup_<date>` schema inside the database and keeps the newest 5.
- **Daily encrypted backup**: save the secret `BACKUP_PASSPHRASE` (keep
  a copy in a password manager; without it the backups cannot be
  opened). The **Daily backup** workflow then saves an encrypted copy of
  the whole database every day, kept 30 days (Actions → Daily backup →
  a run → Artifacts).

To restore, never overwrite the live project: restore into a **new**
Supabase project (or a local one) and copy back only what you need.

1. Download the artifact and unzip it to get
   `database-backup-....tar.gz.gpg`.
2. Decrypt it with GnuPG and your passphrase:
   `gpg -d database-backup-....tar.gz.gpg > backup.tar.gz` then
   `tar -xzf backup.tar.gz`. The `backup/` folder holds customer data:
   keep it on your own computer and delete it when done.
3. Load it into the empty database, as its admin user:
   ```
   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 \
     -f backup/roles.sql -f backup/schema.sql \
     -c 'SET session_replication_role = replica' -f backup/data.sql
   psql "$DB" -v ON_ERROR_STOP=1 -f backup/auth_triggers.sql
   ```
4. Check the row counts against that day's backup log.

## Making changes

- Every change goes through a **pull request**. The **Checks** workflow
  runs lint, type checks, the build, unit tests, a package audit, the
  database tests and a secret scan. Merging into `main` deploys it.
- Database changes are always **new** files in `supabase/migrations/`
  (never edit one that is already applied, and never paste SQL into the
  Supabase dashboard).
- `CLAUDE.md` has the rules for AI assistants (Claude Code and others).
  Point your assistant at it before asking for changes.
- Dependabot opens weekly update pull requests; they go through the
  same checks and never merge by themselves.

## Running it on your own computer (optional)

You need [Node.js](https://nodejs.org) 22 and, for the database,
Docker.

```bash
npm ci
npm run dev        # the app, with in-browser demo data (nothing saved)
npm run lint
npx tsc -b
npm test           # unit tests
npm run build
npx supabase start -x studio,imgproxy,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
npx supabase test db   # database tests against the local database only
```

To use the local database from the app, create a file `.env.local`
(never committed) with `VITE_SUPABASE_URL=http://127.0.0.1:54321` and
`VITE_SUPABASE_PUBLISHABLE_KEY=` followed by the key that
`npx supabase status` prints.

## Security

See `SECURITY.md`: what to do when someone leaves the team or loses a
phone, how to rotate each key, and which accounts to protect with
two-step login.

## License

No license has been chosen for this template yet. Ask the owner of the
template repository for license terms before using it for your business.
