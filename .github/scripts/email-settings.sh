#!/usr/bin/env bash
# email-settings.sh — the email switches on the live project, used
# by .github/workflows/deploy.yml (every deploy, and the quick
# "email-settings" run that changes nothing else).
#
#   secrets  hands the edge functions EMAIL_TEST_MODE, EMAIL_TEST_RECIPIENTS,
#            GMAIL_ADDRESS, SENDER_NAME and, only while Gmail sending is on, GMAIL_APP_PASSWORD;
#            with sending off it removes GMAIL_APP_PASSWORD.
#   login    login emails (sign-up, password reset, email change) through
#            the business Gmail only when sending is on AND test mode is
#            off; otherwise Gmail is taken out of them. Also the password
#            rules and the site address used in login email links (SITE_URL).
#   verify   reads both back and FAILS when an "off" switch did not stick:
#            GMAIL_APP_PASSWORD still on the functions while sending is
#            off, or Gmail still the login-email server while it should
#            not be. Never prints secret values or addresses.
#
# Environment: PROJECT_REF, SUPABASE_ACCESS_TOKEN, and
#   GMAIL_APP_PASSWORD        (secrets) "" while GMAIL_SENDING is not "on"
#   EMAIL_TEST_MODE           (secrets) "on" | "off"
#   EMAIL_TEST_RECIPIENTS     (secrets)
#   GMAIL_ADDRESS             (secrets, login) the business Gmail (GitHub variable)
#   SENDER_NAME               (secrets, login) the name emails come from (GitHub variable BUSINESS_NAME)
#   LOGIN_GMAIL_PASSWORD      (login)   "" unless sending is on and test mode off
#   FUNCTIONS_GMAIL           (verify)  "on" | "off": should the functions hold the password
#   LOGIN_GMAIL               (verify)  "on" | "off": should login emails use Gmail
set -euo pipefail

api="https://api.supabase.com/v1/projects/${PROJECT_REF:?}/config/auth"

secrets() {
  local args=(EMAIL_TEST_MODE="${EMAIL_TEST_MODE:?}" EMAIL_TEST_RECIPIENTS="${EMAIL_TEST_RECIPIENTS:-none}"
              GMAIL_ADDRESS="${GMAIL_ADDRESS:-none}" SENDER_NAME="${SENDER_NAME:-Tree Service}")
  [ -n "${GMAIL_APP_PASSWORD:-}" ] && args+=(GMAIL_APP_PASSWORD="$GMAIL_APP_PASSWORD")
  supabase secrets set --remote="$PROJECT_REF" --yes "${args[@]}"
  if [ -z "${GMAIL_APP_PASSWORD:-}" ]; then
    # Gmail sending is off: no function may hold the password. An error
    # here (it may already be gone) is checked by "verify".
    supabase secrets unset --remote="$PROJECT_REF" --yes GMAIL_APP_PASSWORD >/dev/null 2>&1 || true
    echo "Gmail sending is off: GMAIL_APP_PASSWORD removal asked for (checked by the verify step)."
  else
    echo "Gmail sending is on for the email functions."
  fi
}

login() {
  local settings
  if [ -n "${LOGIN_GMAIL_PASSWORD:-}" ]; then
    # Sign-up, password-reset and email-change emails can be asked for by
    # anyone on the internet, so they are capped hard: at most 6 login
    # emails an hour for the whole company, at most one a minute to the
    # same address. This keeps strangers from using up the Gmail quota.
    settings=$(jq -n --arg u "${GMAIL_ADDRESS:?}" --arg p "$LOGIN_GMAIL_PASSWORD" --arg n "${SENDER_NAME:-Tree Service}" \
      --arg s "${SITE_URL:?}" \
      '{site_url: $s, uri_allow_list: ($s + "/**"), password_min_length: 10, smtp_host: "smtp.gmail.com", smtp_port: "465",
        smtp_user: $u, smtp_pass: $p, smtp_admin_email: $u,
        smtp_sender_name: $n,
        rate_limit_email_sent: 6, smtp_max_frequency: 60}')
  else
    echo "::notice::Login emails are not on Gmail (GMAIL_SENDING is not 'on', or EMAIL_TEST_MODE is not 'off'): they use Supabase's limited built-in sender."
    settings=$(jq -n --arg s "${SITE_URL:?}" \
      '{site_url: $s, uri_allow_list: ($s + "/**"), password_min_length: 10, smtp_host: null, smtp_port: null,
        smtp_user: null, smtp_pass: null, smtp_admin_email: null, smtp_sender_name: null}')
  fi
  curl -fsS --retry 5 -X PATCH "$api" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN:?}" -H "Content-Type: application/json" \
    -d "$settings" > auth_after.json \
    || { echo "::error::Could not update the login settings."; exit 1; }
  jq '{site_url, password_min_length, smtp_host, smtp_port, smtp_sender_name, mailer_autoconfirm, rate_limit_email_sent, smtp_max_frequency}' auth_after.json
  if [ -n "${LOGIN_GMAIL_PASSWORD:-}" ] && [ "$(jq -r '.rate_limit_email_sent' auth_after.json)" != "6" ]; then
    # Fail safe: without the cap, take Gmail back out of the login emails.
    curl -fsS --retry 5 -X PATCH "$api" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
      -d '{"smtp_host": null, "smtp_port": null, "smtp_user": null, "smtp_pass": null, "smtp_admin_email": null, "smtp_sender_name": null}' > /dev/null
    echo "::error::The hourly cap on login emails did not stick, so login emails were taken off Gmail again. Estimates and invoices still use Gmail."
    exit 1
  fi
  rm -f auth_after.json
}

verify() {
  local problems=0 list
  if [ "${FUNCTIONS_GMAIL:?}" = "off" ]; then
    # Names only are looked at; the list is never printed.
    if ! list=$(supabase secrets list --remote="$PROJECT_REF" 2>/dev/null); then
      echo "::error::Could not read the function secrets, so Gmail sending cannot be confirmed OFF."
      problems=1
    elif grep -qw GMAIL_APP_PASSWORD <<<"$list"; then
      echo "::error::Gmail sending should be OFF, but the email functions still hold GMAIL_APP_PASSWORD. Run Deploy Supabase with mode email-settings again."
      problems=1
    else
      echo "ok: the email functions hold no Gmail password (sending is off)"
    fi
  fi
  if ! curl -fsS --retry 5 "$api" -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN:?}" > auth_check.json; then
    echo "::error::Could not read the login settings back."
    problems=1
  else
    local host
    host=$(jq -r '.smtp_host // ""' auth_check.json)
    if [ "${LOGIN_GMAIL:?}" = "off" ] && [ -n "$host" ]; then
      echo "::error::Login emails should NOT go through Gmail, but an email server is still set. Run Deploy Supabase with mode email-settings again."
      problems=1
    elif [ "$LOGIN_GMAIL" = "off" ]; then
      echo "ok: login emails are not on Gmail"
    else
      echo "login emails server set: $([ -n "$host" ] && echo yes || echo no)"
    fi
  fi
  rm -f auth_check.json
  [ "$problems" = 0 ]
}

case "${1:-}" in
  secrets) secrets ;;
  login) login ;;
  verify) verify ;;
  *) echo "usage: $0 secrets|login|verify" >&2; exit 2 ;;
esac
