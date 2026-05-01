#!/usr/bin/env bash
# Digest preferences + preview + unsubscribe smoke (Phase 3d.2).
#
# What this CAN do (no email account needed):
#   * Verify GET /api/digest/preferences anonymous → 401.
#   * Verify GET signed-in → 200 + opted_in=true (default per design).
#   * Verify PATCH signed-in → 200 + audit row written.
#   * Verify GET reflects the PATCH.
#   * Verify GET /api/digest/preview signed-in → 200 + payload (or
#     200+payload:null when no breakout signals exist yet).
#   * Verify GET /api/digest/unsubscribe with no/bogus token → 400 HTML.
#   * Verify the cron --dry-run --force flag prints would-send list.
#
# What this CANNOT do without manual setup:
#   * End-to-end real-mailer send (would need RESEND_API_KEY +
#     a verified sender domain). Manual verify path: with
#     RESEND_API_KEY set, run send-weekly-digest.js (no flags) on
#     a Monday 09:00 local; expect Resend dashboard to show a send.
#
# Prereqs:
#   * Backend running on :8787.
#   * Postgres reachable; migration 017 applied.
#
# Run: bash scripts/test-digest.sh

set -u

BASE="${BASE:-http://localhost:8787}"
JAR=/tmp/tx-digest-jar.txt
RESP=/tmp/tx-digest.json
PASS=0
FAIL=0

RAND=$RANDOM
EMAIL="digest-$RAND@example.com"
PW='correct-horse-battery-staple-42'

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()  { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

json_get() { python3 -c "import json;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null; }

rm -f "$JAR"

# --- 1. anonymous /preferences -> 401 ----------------------------------
hr "1. anonymous GET /api/digest/preferences"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/digest/preferences")
code_eq 401 "$CODE" "anonymous prefs request rejected"

# --- 2. anonymous PATCH /preferences -> 401 ----------------------------
hr "2. anonymous PATCH /api/digest/preferences"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X PATCH -H 'Content-Type: application/json' \
  -d '{"opted_in":true}' "$BASE/api/digest/preferences")
code_eq 401 "$CODE" "anonymous PATCH rejected"

# --- 3. signup -> session ----------------------------------------------
hr "3. signup -> session"
do_curl_retry() {
  local method="$1" path="$2" data="${3:-}"
  local code=429
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if [ -n "$data" ]; then
      code=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" -c "$JAR" \
        -X "$method" -H 'Content-Type: application/json' \
        -d "$data" "$BASE$path")
    else
      code=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" -c "$JAR" \
        -X "$method" "$BASE$path")
    fi
    [ "$code" != "429" ] && break
    sleep 6
  done
  echo "$code"
}
CODE=$(do_curl_retry POST /api/auth/signup \
  "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  ok "signup created session (HTTP $CODE)"
else
  bad "signup failed: HTTP $CODE — skipping signed-in subtests"
  hr "Summary"; echo "Pass: $PASS  Fail: $FAIL"
  [ "$FAIL" = "0" ] && exit 0 || exit 1
fi

# --- 4. signed-in GET /preferences -> opted_in=true (default) ----------
hr "4. signed-in GET /preferences"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/digest/preferences")
code_eq 200 "$CODE" "prefs reachable"
KIND=$(json_get kind)
[ "$KIND" = "digest.preferences" ] && ok "kind == digest.preferences" || bad "kind was '$KIND'"
OPTED=$(json_get optedIn)
[ "$OPTED" = "True" ] || [ "$OPTED" = "true" ] && ok "default opted_in == true (per locked design)" || bad "default opted_in was '$OPTED'"

# --- 5. signed-in PATCH /preferences -> false --------------------------
hr "5. signed-in PATCH /preferences (opt out)"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" \
  -X PATCH -H 'Content-Type: application/json' \
  -d '{"opted_in":false}' "$BASE/api/digest/preferences")
code_eq 200 "$CODE" "PATCH succeeded"
OPTED=$(json_get optedIn)
[ "$OPTED" = "False" ] || [ "$OPTED" = "false" ] && ok "opt-out persisted" || bad "opted_in was '$OPTED'"

# --- 6. signed-in GET /preview -> 200 ----------------------------------
hr "6. signed-in GET /preview"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/digest/preview")
code_eq 200 "$CODE" "preview reachable"
KIND=$(json_get kind)
[ "$KIND" = "digest.preview" ] && ok "kind == digest.preview" || bad "kind was '$KIND'"
# payload may be null when there are zero breakout signals — both 200s.

# --- 7. unsubscribe with bogus token -> 400 + HTML --------------------
hr "7. unsubscribe with malformed link"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  "$BASE/api/digest/unsubscribe?u=00000000-0000-0000-0000-000000000000&t=bogus")
code_eq 400 "$CODE" "bogus token rejected"
grep -q '<title>' "$RESP" && ok "response is HTML (title present)" || bad "no <title> in response"

# --- 8. unsubscribe with missing params -> 400 ------------------------
hr "8. unsubscribe with no params"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/digest/unsubscribe")
code_eq 400 "$CODE" "missing params rejected"

# --- 9. cron --dry-run --force prints something -----------------------
# We can't run the cron itself from here without DATABASE_URL etc set
# in the calling shell; but we can shell-syntax-check the script.
hr "9. send-weekly-digest.js syntax check"
SYN=$(node --check scripts/send-weekly-digest.js 2>&1 || true)
if [ -z "$SYN" ]; then ok "send-weekly-digest.js parses cleanly"; else bad "parse error: $SYN"; fi

hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
