#!/usr/bin/env bash
# Use after deploy-securely.sh has stored the Worker secrets for the first time.
set -euo pipefail

PNPM="/Users/ronenkeisar/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
read -r -s -p "Cloudflare API token (emda-worker-deploy): " CLOUDFLARE_API_TOKEN
echo
export CLOUDFLARE_API_TOKEN
"$PNPM" exec wrangler deploy
unset CLOUDFLARE_API_TOKEN
