#!/usr/bin/env bash
# Referral program smoke (Phase 3d.3).
#
# What this CAN do (no Stripe account needed):
#   * Verify GET /api/referrals/me anonymous → 401.
#   * Verify GET /api/referrals/me signed-in → 200 + token + link + zero stats.
#   * Verify second GET returns the SAME token (stable per user).
#   * Verify POST /api/referrals/click with bad token → 200 (no leak).
#   * Verify POST /api/referrals/click with good token → 200 +
#     kind:referrals.click_recorded.
#   * Verify second POST same-IP within 24h → 200 +
#     kind:referrals.click_deduped.
#
# What this CANNOT do without manual setup:
#   * End-to-end Stripe coupon issuance (would need STRIPE_SECRET_KEY +
#     a real conversion). Manual verify path: with Stripe configured,
#     run scripts/test-payments.sh for a referred user, then check
#     SELECT * FROM referral_coupons WHERE referred_user_id = ...
#
# Prereqs:
#   * Backend running on :8787.
#   * Postgres reachable; migration 018 applied.
#
# Run: bash scripts/test-referrals.sh

set -u

BASE="${BASE:-http://localhost:8787}"
JAR=/tmp/tx-ref-jar.txt
RESP=/tmp/tx-ref.json
PASS=0
FAIL=0

RAND=$RANDOM
EMAIL="ref-$RAND@example.com"
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

# --- 1. anonymous /me -> 401 -------------------------------------------
hr "1. anonymous GET /api/referrals/me"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/referrals/me")
code_eq 401 "$CODE" "anonymous /me rejected"

# --- 2. signup -> session ----------------------------------------------
hr "2. signup -> session"
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

# --- 3. signed-in /me -> 200 + token + link + zero stats ---------------
hr "3. signed-in GET /me"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/referrals/me")
code_eq 200 "$CODE" "/me reachable"
KIND=$(json_get kind)
[ "$KIND" = "referrals.me" ] && ok "kind == referrals.me" || bad "kind was '$KIND'"
TOK=$(json_get token)
LINK=$(json_get link)
[ -n "$TOK" ] && ok "token present (= $TOK)" || bad "token was empty"
case "$LINK" in
  *"?ref=$TOK") ok "link contains the token in ?ref=" ;;
  *)            bad "link missing ?ref=<token>: $LINK"  ;;
esac
# stats is a nested object; check it's there + clicks=0 for fresh user.
CLICKS=$(python3 -c "import json;d=json.load(open('$RESP'));print(d.get('stats',{}).get('clicks',-1))" 2>/dev/null)
[ "$CLICKS" = "0" ] && ok "fresh user has 0 clicks" || bad "clicks was '$CLICKS'"

# --- 4. token is stable across calls -----------------------------------
hr "4. /me returns the SAME token on second call"
curl -sS -o "$RESP" -b "$JAR" "$BASE/api/referrals/me" >/dev/null
TOK2=$(json_get token)
[ "$TOK" = "$TOK2" ] && ok "token stable (= $TOK)" || bad "token changed: '$TOK' -> '$TOK2'"

# --- 5. POST /click with bad token -> 200 (deduped, no leak) ----------
hr "5. POST /click with malformed token"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d '{"token":"!!!"}' "$BASE/api/referrals/click")
code_eq 200 "$CODE" "malformed token soft-handled"
KIND=$(json_get kind)
[ "$KIND" = "referrals.click_deduped" ] && ok "malformed -> click_deduped (no-op)" || bad "kind was '$KIND'"

# --- 6. POST /click with bogus-but-shape-OK token -> 200 deduped -------
hr "6. POST /click with non-existent token"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d '{"token":"AAAAAAAAAAAA"}' "$BASE/api/referrals/click")
code_eq 200 "$CODE" "non-existent token soft-handled"
KIND=$(json_get kind)
[ "$KIND" = "referrals.click_deduped" ] && ok "non-existent -> click_deduped" || bad "kind was '$KIND'"

# --- 7. POST /click with the real token -> 200 click_recorded ---------
hr "7. POST /click with real token"
PAYLOAD=$(python3 -c "import json;print(json.dumps({'token':'$TOK'}))")
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" "$BASE/api/referrals/click")
code_eq 200 "$CODE" "click POST succeeded"
KIND=$(json_get kind)
[ "$KIND" = "referrals.click_recorded" ] && ok "kind == referrals.click_recorded" || bad "kind was '$KIND'"

# --- 8. POST /click again, same IP within 24h -> deduped --------------
hr "8. POST /click again -> dedup"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" "$BASE/api/referrals/click")
code_eq 200 "$CODE" "second click also returns 200"
KIND=$(json_get kind)
[ "$KIND" = "referrals.click_deduped" ] && ok "second click within 24h deduped" || bad "kind was '$KIND'"

# --- 9. /me reflects the recorded click in stats ----------------------
hr "9. /me stats reflect the recorded click"
curl -sS -o "$RESP" -b "$JAR" "$BASE/api/referrals/me" >/dev/null
CLICKS=$(python3 -c "import json;d=json.load(open('$RESP'));print(d.get('stats',{}).get('clicks',-1))" 2>/dev/null)
[ "$CLICKS" = "1" ] && ok "stats.clicks == 1 after dedup-aware insert" || bad "stats.clicks was '$CLICKS'"

hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
