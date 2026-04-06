#!/usr/bin/env bash
# Drop newest Railway deployments until the top of the list is not QUEUED / INITIALIZING / BUILDING / DEPLOYING.
# Use when Git deploys pile up behind a stuck deploy. Run from your machine: bash scripts/railway-unstick-queue.sh
# Requires: railway CLI logged in and this repo linked (`railway status` shows the service).

set -euo pipefail
cd "$(dirname "$0")/.."

MAX="${1:-10}"
if ! railway status >/dev/null 2>&1; then
  echo "railway: not linked in this directory. Run: cd $(pwd) && railway link"
  exit 1
fi

for ((i = 1; i <= MAX; i++)); do
  first="$(
    railway deployment list --json --limit 1 |
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0][\"status\"] if d else \"NONE\")"
  )"
  case "$first" in
    SUCCESS | REMOVED | FAILED | CRASHED | SKIPPED | SLEEPING | NONE)
      echo "Top deployment is \"$first\" — queue clear or stable."
      break
      ;;
  esac
  echo "[$i/$MAX] railway down -y (top status was: $first)"
  railway down -y
  sleep 2
done

echo ""
echo "--- railway deployment list (top 8) ---"
railway deployment list --limit 8
