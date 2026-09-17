#!/usr/bin/env bash
# This script deliberately prompts in the terminal. It never writes credentials
# to the repository, the Worker source, or a shell history entry.
set -euo pipefail

PNPM="/Users/ronenkeisar/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
if [[ ! -x "$PNPM" ]]; then
  echo "The bundled pnpm runtime was not found. Open this project in Codex and run the deployment there."
  exit 1
fi

read -r -s -p "Cloudflare API token (emda-worker-deploy): " CLOUDFLARE_API_TOKEN
echo
read -r -s -p "Resend API key (emda-alerts): " RESEND_API_KEY
echo
read -r -p "Email address for quota alerts: " ALERT_EMAIL
echo

RATE_LIMIT_SALT="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export CLOUDFLARE_API_TOKEN

printf '%s' "$RESEND_API_KEY" | "$PNPM" exec wrangler secret put RESEND_API_KEY
printf '%s' "$ALERT_EMAIL" | "$PNPM" exec wrangler secret put ALERT_EMAIL
printf '%s' "$RATE_LIMIT_SALT" | "$PNPM" exec wrangler secret put RATE_LIMIT_SALT
"$PNPM" exec wrangler deploy

unset CLOUDFLARE_API_TOKEN RESEND_API_KEY ALERT_EMAIL RATE_LIMIT_SALT
echo "Deployment complete. Your credentials were supplied only to this process."
