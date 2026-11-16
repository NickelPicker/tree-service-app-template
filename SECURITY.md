# Security

## Reporting a problem

If you find a security problem in this app, tell the business that runs
it directly (put your contact address here, e.g. owner@example.com). Do
not open a public issue.

## Someone leaves the team, or loses their phone

1. In the app, open **Users**, find the person, and tap **Remove from
   team**. Their access to company data stops at once: the database
   checks access on every request, so an old session on their phone
   gets nothing back.
2. If a phone is lost, also change that person's password (they can
   use "Forgot password" on the login screen once email sending is set
   up). Signing out on a phone wipes its copy of company data.
3. If they had two-step login on and lost the phone with their
   authenticator app: an owner or manager opens **Users** and taps
   **Reset two-step login** next to them. This also signs them out on
   every device, the lost phone included (a sign-in already open there
   stops working within the hour). They then sign in with just their
   password and can turn it on again with the new phone. Only an
   owner can reset another owner's.

## Rotating keys (do this if a key may have leaked)

| Key | Where it lives | How to rotate |
|---|---|---|
| Supabase access token | GitHub secret `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens: create a new one, save it in the GitHub secret, then delete the old token. |
| Netlify token | GitHub secret `NETLIFY_AUTH_TOKEN` | Netlify → User settings → Applications → Personal access tokens: create, save in GitHub, delete the old one. |
| Gmail app password | GitHub secret `GMAIL_APP_PASSWORD` | myaccount.google.com/apppasswords: remove the old one, create a new one, save it in GitHub, then re-run the deploy. |
| Turnstile secret | GitHub secret `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → the widget → rotate secret; save it in GitHub, re-run the deploy. |
| Supabase publishable key | GitHub variable `SUPABASE_PUBLISHABLE_KEY` (public by design) | Only if abused: Supabase → Project Settings → API Keys → create a new publishable key, save it in the GitHub variable, run the deploy (Actions → Deploy Supabase → Run workflow → deploy), then disable the old key. |
| Supabase secret / service_role key | Not used by the app | If it may have leaked: Supabase → API Keys → rotate it. Nothing in the app needs changing. |

GitHub secrets: repo → Settings → Secrets and variables → Actions.

## Restoring data

On the free Supabase plan there is no one-click restore. Before every deploy, the deploy copies every table into a
`backup_<date>` schema inside the database (for example
`backup_20261113_181154`). The newest 5 copies are kept; older ones
are removed automatically after a successful deploy (the free plan's
database is limited to 500 MB). To restore rows from one of these copies,
ask your developer or AI assistant to write a migration that copies the
needed rows back, rehearse it like any other change, and merge it.
Upgrading to Supabase Pro adds daily backups with one-click restore.

## Two-step login in the app

Optional for everyone, strongly recommended for owners and managers. In the app, tap **🔐 Two-step login** at the top,
then **Turn on two-step login**, scan the QR code with an authenticator
app (Google Authenticator, Microsoft Authenticator, 1Password...) and
type the code it shows. From then on, signing in asks for a fresh code
after the password. The database enforces it: with only the password,
that login sees no company data at all.

## Accounts to protect

Turn on two-step login for every account that can change the app:
GitHub, Supabase, Netlify, Cloudflare, and the business Google account.
