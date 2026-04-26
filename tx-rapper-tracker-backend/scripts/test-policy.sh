#!/usr/bin/env bash
# Smoke test Phase 2b.2 password policy + change-password.
#   (a) signup with weak password -> 400 weak_password
#   (b) signup with strong password -> 201
#   (c) change-password wrong current -> 401
#   (d) change-password weak new -> 400 weak_password
#   (e) change-password success -> 200, revokes other sessions
#   (f) HIBP breach check -> 400 pwned_password (if online)
set -u
BASE="${BASE:-http://localhost:8787}"
RAND=$RANDOM
EMAIL="policy-${RAND}@example.com"
STRONG='correct-horse-battery-staple-42'
STRONG2='trombone-banana-midnight-sparrow-88'

hr() { printf '\n===== %s =====\n' "$*"; }

hr "(a) signup weak password (should be 400 weak_password)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"weak-$RAND@example.com\",\"password\":\"password1234\"}"
cat /tmp/r.json; echo

hr "(f) signup HIBP-breached password (should be 400 pwned_password)"
# "Tr0ub4dor&3" is famously in breach corpora; length-12, looks strong to zxcvbn.
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"pwned-$RAND@example.com\",\"password\":\"Tr0ub4dor&3xyz\"}"
cat /tmp/r.json; echo

hr "(b) signup strong password (should be 201, sets cookie)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -c /tmp/jar1.txt -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$STRONG\"}"
cat /tmp/r.json; echo

hr "second login (second device, separate jar)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -c /tmp/jar2.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$STRONG\"}"
cat /tmp/r.json; echo

hr "(c) change-password with wrong current (should be 401)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar1.txt -X POST "$BASE/api/auth/change-password" \
  -H 'Content-Type: application/json' \
  -d "{\"currentPassword\":\"wrongwrong123\",\"newPassword\":\"$STRONG2\"}"
cat /tmp/r.json; echo

hr "(d) change-password with weak new (should be 400 weak_password)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar1.txt -X POST "$BASE/api/auth/change-password" \
  -H 'Content-Type: application/json' \
  -d "{\"currentPassword\":\"$STRONG\",\"newPassword\":\"password12345\"}"
cat /tmp/r.json; echo

hr "(e) change-password success (should be 200)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar1.txt -X POST "$BASE/api/auth/change-password" \
  -H 'Content-Type: application/json' \
  -d "{\"currentPassword\":\"$STRONG\",\"newPassword\":\"$STRONG2\"}"
cat /tmp/r.json; echo

hr "(e1) jar1 /me still works (current session preserved)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar1.txt "$BASE/api/auth/me"
cat /tmp/r.json; echo

hr "(e2) jar2 /me should now be 401 (other session revoked)"
curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' -b /tmp/jar2.txt "$BASE/api/auth/me"
cat /tmp/r.json; echo

hr "done"
