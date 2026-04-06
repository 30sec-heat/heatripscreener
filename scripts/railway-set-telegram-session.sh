#!/usr/bin/env bash
# After: TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:login
# Paste the printed session into TELEGRAM_SESSION_STRING and run:
#   ./scripts/railway-set-telegram-session.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${TELEGRAM_SESSION_STRING:-}" ]]; then
  echo "Export TELEGRAM_SESSION_STRING first (full string from telegram:login)."
  exit 1
fi
printf '%s' "$TELEGRAM_SESSION_STRING" | railway variable set TELEGRAM_SESSION_STRING --stdin --service heatripscreener -e production
echo "TELEGRAM_SESSION_STRING set on Railway (production / heatripscreener)."
