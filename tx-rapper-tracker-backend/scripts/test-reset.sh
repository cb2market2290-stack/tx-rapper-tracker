#!/usr/bin/env bash
# Password-reset flow smoke test.
# Assumes the backend is running on :8787 and the ConsoleMailer is active
# (i.e. RESEND_API_KEY is empty). Reads the reset URL out of the file the
# ConsoleMailer writes: /tmp/last-reset-email.txt.
#
# Covers:
#   1. signup with a throwaway email
#   2. login (baseline: current password works)
#   3. POST /forgot for an UNKNOWN email -> 202 (enumeration-safe)
#   4. POST /forgot for the real email     -> 202, mail file populated
#   5. GET  /reset/check with the token    -> 200, returns email
#   6. POST /reset with a weak password    -> 400 (policy holds)
#   7. POST /reset with a strong password  -> 200
#   8. old cookie (from step 2) -> 401 (all sessions revoked)
#   9. login with OLD password              -> 401 (was replaced)
#  10. login with NEW password              -> 200
#  11. second /reset with the now-used token -> 400 (single-use)
set -u
BASE="${BASE:-http://localhost:8787}"
RAND=$RANDOM
EMAIL="reset-$RAND@example.com"
OLD_PW='correct-horse-battery-staple-42'
WEAK_PW='password12345'
NEW_PW='my-new-strong-passphrase-9876'
MAIL_FILE=/tmp/last-reset-email.txt
PASS=0
FAIL=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()   { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

hr "1. signup $EMAIL"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -c /tmp/r-jar.txt -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$OLD_PW\"}")
code_eq 201 "$CODE" "signup"

hr "2. baseline login (old password)"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -c /tmp/r-jar.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$OLD_PW\"}")
code_eq 200 "$CODE" "baseline login with old password"

hr "3. /forgot for UNKNOWN email -> 202 (enumeration-safe)"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/forgot" \
  -H 'Content-Type: application/json' -d '{"email":"nobody-'$RAND'@example.com"}')
code_eq 202 "$CODE" "/forgot unknown email returns 202"

hr "4. /forgot for REAL email -> 202"
rm -f "$MAIL_FILE"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/forgot" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")
code_eq 202 "$CODE" "/forgot real email returns 202"

# Give the async mailer a beat to flush the file.
for i in 1 2 3 4 5; do [ -s "$MAIL_FILE" ] && break; sleep 0.3; done
if [ -s "$MAIL_FILE" ]; then ok "mail file populated at $MAIL_FILE"; else bad "mail file not written"; fi

TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' "$MAIL_FILE" | head -1 | cut -d= -f2)
if [ -n "$TOKEN" ]; then ok "extracted token (${#TOKEN} chars)"; else bad "could not extract token from mail file"; fi

hr "5. /reset/check with token -> 200"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' "$BASE/api/auth/reset/check?token=$TOKEN")
code_eq 200 "$CODE" "/reset/check returns 200"
CHECK_EMAIL=$(python3 -c "import json;print(json.load(open('/tmp/r.json')).get('email',''))" 2>/dev/null)
if [ "$CHECK_EMAIL" = "$EMAIL" ]; then ok "/reset/check returns the right email"; else bad "/reset/check email mismatch: $CHECK_EMAIL"; fi

hr "6. /reset with WEAK password -> 400"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/reset" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"newPassword\":\"$WEAK_PW\"}")
code_eq 400 "$CODE" "/reset with weak password rejected"

hr "7. /reset with STRONG password -> 200"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/reset" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"newPassword\":\"$NEW_PW\"}")
code_eq 200 "$CODE" "/reset succeeds with strong password"

hr "8. old cookie -> 401 (all sessions revoked)"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -b /tmp/r-jar.txt "$BASE/api/auth/me")
code_eq 401 "$CODE" "old cookie invalidated"

hr "9. login with OLD password -> 401"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$OLD_PW\"}")
code_eq 401 "$CODE" "old password no longer accepted"

hr "10. login with NEW password -> 200"
CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$NEW_PW\"}")
code_eq 200 "$CODE" "new password accepted"

hr "11. /reset with same token twice -> 400 (single-use)"
# After ~10 auth requests in this window we may hit the strict-auth rate
# bucket. Retry with small backoffs while we see 429; bail once we get a
# non-429 answer (which should be 400).
CODE=429
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  CODE=$(curl -sS -o /tmp/r.json -w '%{http_code}' -X POST "$BASE/api/auth/reset" \
    -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"newPassword\":\"another-strong-passphrase-88\"}")
  [ "$CODE" != "429" ] && break
  sleep 6
done
code_eq 400 "$CODE" "used token rejected on second try"

hr "summary"
echo "passed: $PASS"
echo "failed: $FAIL"
[ "$FAIL" = 0 ] && exit 0 || exit 1
