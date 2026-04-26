#!/usr/bin/env bash
# Auth smoke test — exercises the full signup → login → me → logout cycle
# against a running server. Requires a running server on :8787 and a live
# Postgres with the migration applied.
#
# Usage:
#   bash scripts/auth-smoke.sh
#
# Idempotent: uses a unique email per run so it can be re-run without
# bumping into the UNIQUE constraint.

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
JAR="$(mktemp -t tx-auth-smoke.XXXXXX)"
EMAIL="smoke+$(date +%s)@example.com"
PASSWORD="correct horse battery staple"

hr() { printf '\n--- %s ---\n' "$*"; }
req() {
  # req METHOD PATH [DATA]
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -w '\n[status=%{http_code}]\n' -X "$method" -b "$JAR" -c "$JAR"
              -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080'
              "${BASE}${path}")
  if [ -n "$data" ]; then
    args+=(--data "$data")
  fi
  curl "${args[@]}"
}

hr "1. /health"
curl -sS "${BASE}/health" | head -c 400; echo

hr "2. POST /api/auth/signup  ($EMAIL)"
req POST /api/auth/signup "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"displayName\":\"Smoke Test\"}"

hr "3. GET /api/auth/me  (should show the user)"
req GET /api/auth/me

hr "4. POST /api/auth/logout"
req POST /api/auth/logout

hr "5. GET /api/auth/me  (should be 401 now)"
req GET /api/auth/me || true

hr "6. POST /api/auth/login  (same creds)"
req POST /api/auth/login "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}"

hr "7. GET /api/auth/me  (authed again)"
req GET /api/auth/me

hr "8. POST /api/auth/login  (wrong password → 401)"
req POST /api/auth/login "{\"email\":\"${EMAIL}\",\"password\":\"not-the-right-password\"}" || true

hr "9. POST /api/auth/signup  (duplicate email → 409)"
req POST /api/auth/signup "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" || true

hr "done"
rm -f "$JAR"
