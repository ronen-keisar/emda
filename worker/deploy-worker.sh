#!/usr/bin/env bash
# Use after deploy-securely.sh has stored the Worker secrets for the first time.
set -euo pipefail

PNPM="/Users/ronenkeisar/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
read -r -s -p "Cloudflare API token (emda-worker-deploy): " CLOUDFLARE_API_TOKEN
echo
if [[ -z "$CLOUDFLARE_API_TOKEN" || "$CLOUDFLARE_API_TOKEN" =~ [[:space:]] ]]; then
  echo "Token format error: paste only the raw token value, without 'Bearer', labels, spaces or line breaks." >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN
"$PNPM" exec wrangler deploy
unset CLOUDFLARE_API_TOKEN
