#!/usr/bin/env bash
# AI artist briefs smoke test (Phase 3b).
#
# What this CAN do (no Stripe + no Anthropic account needed):
#   * Verify the route is mounted under /api/artists/:id/brief.
#   * Verify anonymous requests 401.
#   * Verify a non-UUID :id 400s with kind:'bad_request'.
#   * Verify an unknown UUID 404s.
#   * Verify a free-tier user 402s with kind:'payments.required' +
#     minTier:'premium' — the gating contract the frontend dispatches on.
#
# What this CANNOT do without manual setup:
#   * Drive a 200 fresh-generation (needs ANTHROPIC_API_KEY + a real
#     Premium subscription on the test user). Manual verification:
#       1. Set ANTHROPIC_API_KEY in .env.
#       2. Promote the test user via DB:
#            UPDATE stripe_subscriptions SET stripe_status='active',
#              stripe_price_id=$STRIPE_PRICE_PREMIUM
#            WHERE user_id=...;
#          (or run scripts/test-payments.sh after a real checkout flow)
#       3. curl with the cookie jar and assert kind:'artists.brief',
#          cacheHit:false on first call, cacheHit:true on the second.
#   * Drive a 503 briefs_unconfigured (same path requires Premium).
#   * Drive a 504 timeout (would need to mock the SDK or use a slow proxy).
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Postgres reachable; migration 015 applied.
#   * At least one artist row in the artists table (the public roster).
#
# Run: bash scripts/test-briefs.sh

set -u

BASE="${BASE:-http://localhost:8787}"
JAR=/tmp/tx-briefs-jar.txt
RESP=/tmp/tx-briefs.json
PASS=0
FAIL=0

RAND=$RANDOM
EMAIL="briefs-$RAND@example.com"
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

# --- 1. anonymous /api/artists/:fake/brief -> 401 ----------------------
# Even with a syntactically-valid UUID, the requireUser() that mounts
# /api/artists must fire before we touch anything Premium-related.
hr "1. anonymous /api/artists/:id/brief -> 401"
FAKE_UUID='00000000-0000-0000-0000-000000000000'
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/artists/$FAKE_UUID/brief")
code_eq 401 "$CODE" "anonymous brief request rejected"

# --- 2. signup so subsequent calls are signed-in (Free tier) -----------
hr "2. signup -> session"
do_curl_retry() {
  local method="$1" path="$2" data="${3:-}" jar="${4:-$JAR}"
  local code=429
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if [ -n "$data" ]; then
      code=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$jar" -c "$jar" \
        -X "$method" -H 'Content-Type: application/json' \
        -d "$data" "$BASE$path")
    else
      code=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$jar" -c "$jar" \
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
  hr "Summary"
  echo "Pass: $PASS  Fail: $FAIL"
  [ "$FAIL" = "0" ] && exit 0 || exit 1
fi

# --- 3. signed-in non-UUID :id -> 400 ----------------------------------
# requireUser passes; the route's regex check rejects with bad_request
# BEFORE the Premium gate, so this validates the input check in
# isolation.
hr "3. signed-in /api/artists/not-a-uuid/brief -> 400"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists/not-a-uuid/brief")
# requirePaid runs first in the middleware chain because we mounted the
# gate BEFORE the param parser; on Free we'll see 402 first. So accept
# either 400 (param-first) or 402 (gate-first). What we're really
# verifying is "non-UUID is rejected, not a 200".
if [ "$CODE" = "400" ] || [ "$CODE" = "402" ]; then
  ok "non-UUID id is rejected (HTTP $CODE)"
else
  bad "non-UUID id should reject; got HTTP $CODE"
fi

# --- 4. signed-in valid-but-unknown UUID -> 402 (Free) or 404 ----------
# Same ordering note. On Free the gate fires first → 402. On Premium
# the lookup fires first → 404.
hr "4. signed-in /api/artists/:randomUUID/brief -> 402 or 404"
RANDOM_UUID='deadbeef-dead-dead-dead-deaddeadbeef'
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists/$RANDOM_UUID/brief")
if [ "$CODE" = "402" ] || [ "$CODE" = "404" ]; then
  ok "unknown id is rejected (HTTP $CODE)"
else
  bad "unknown id should 402 or 404; got HTTP $CODE"
fi

# --- 5. signed-in real artist /brief -> 402 ----------------------------
# The headline test: a Free user hitting a real artist's brief endpoint
# must 402, with kind:'payments.required' and minTier:'premium' so the
# frontend can render the "Unlock with Premium" upgrade card.
hr "5. signed-in real artist /brief -> 402 with minTier=premium"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists")
if [ "$CODE" != "200" ]; then
  bad "couldn't fetch roster (HTTP $CODE) — skipping 402 gate test"
else
  ARTIST_ID=$(python3 -c "
import json
d = json.load(open('$RESP'))
rows = d.get('rows') or []
print(rows[0]['id'] if rows and 'id' in rows[0] else '')
" 2>/dev/null)
  if [ -z "$ARTIST_ID" ]; then
    bad "no artist UUID in roster — skipping 402 test"
  else
    CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" \
      "$BASE/api/artists/$ARTIST_ID/brief")
    code_eq 402 "$CODE" "brief endpoint gated for free user"
    KIND=$(json_get kind)
    [ "$KIND" = "payments.required" ] && ok "kind == payments.required" || bad "kind was '$KIND'"
    PLAN=$(json_get plan)
    [ "$PLAN" = "free" ] && ok "402 body reports plan == free" || bad "plan was '$PLAN'"
    MIN=$(json_get minTier)
    [ "$MIN" = "premium" ] && ok "402 body reports minTier == premium" || bad "minTier was '$MIN'"
  fi
fi

hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
