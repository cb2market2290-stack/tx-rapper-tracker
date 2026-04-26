#!/usr/bin/env bash
# Stripe payments smoke test (Phase 2c + Phase 2d).
#
# What this CAN do:
#   * Verify the route mounting + body-parser ordering (the Stripe webhook
#     MUST come before express.json() — easy to break in a refactor).
#   * Verify GET /api/payments/status reports the configured state.
#   * Verify the webhook returns 503 when STRIPE_SECRET_KEY is unset
#     (default in dev) — the deliberate "off" state.
#   * Verify the webhook returns 400 on missing/bad signature when keys
#     ARE set (without needing a real Stripe account).
#   * Phase 2d: anonymous /plan + /checkout reject (401), signed-in /plan
#     default-resolves to 'free', /checkout + /portal return 503 when
#     Stripe is disabled, and the audio-features endpoint returns 402
#     for the free tier (the gating contract that drives the upgrade UI).
#
# What this CANNOT do (without a real Stripe account):
#   * End-to-end signature verification with a generated event.
#   * Subscription create → upsert into stripe_subscriptions.
#   * Drive a /checkout that actually returns a Stripe-hosted URL.
# All three are covered by `stripe listen` + the SDK in real environments.
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Postgres reachable; migrations 010 + 011 applied.
#
# Run: bash scripts/test-payments.sh

set -u

BASE="${BASE:-http://localhost:8787}"
JAR=/tmp/tx-pay-jar.txt
RESP=/tmp/tx-pay.json
PASS=0
FAIL=0

# Random-ish creds for the signed-in section. Reusing the
# do_curl_retry pattern from test-features.sh.
RAND=$RANDOM
EMAIL="pay-$RAND@example.com"
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

# --- 1. /api/payments/status reachable + well-formed ---------------------
hr "1. /api/payments/status"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/payments/status")
code_eq 200 "$CODE" "status endpoint reachable"
KIND=$(json_get kind)
[ "$KIND" = "payments.status" ] && ok "kind == payments.status" || bad "kind was '$KIND'"

# enabled, hasSecretKey, hasWebhookSecret, hasPriceId, apiVersion all present
for f in enabled hasSecretKey hasWebhookSecret hasPriceId apiVersion; do
  V=$(json_get "$f")
  if [ -n "$V" ]; then ok "status has '$f' (= $V)"; else bad "status missing '$f'"; fi
done

ENABLED=$(json_get enabled)

# --- 2. webhook with no signature ---------------------------------------
hr "2. webhook missing signature"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d '{"id":"evt_test","type":"customer.subscription.created","data":{"object":{}}}' \
  "$BASE/api/payments/webhook")
if [ "$ENABLED" = "True" ] || [ "$ENABLED" = "true" ]; then
  # Stripe is configured — webhook should reject for missing signature with 400.
  code_eq 400 "$CODE" "webhook rejects missing signature"
else
  # Stripe is disabled — webhook returns 503 before even checking signatures.
  code_eq 503 "$CODE" "webhook returns 503 when Stripe disabled"
  KIND=$(json_get kind)
  [ "$KIND" = "payments.disabled" ] && ok "kind == payments.disabled" || bad "kind was '$KIND'"
fi

# --- 3. webhook with bogus signature ------------------------------------
hr "3. webhook with bogus signature"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Stripe-Signature: t=1700000000,v1=deadbeef,v0=deadbeef' \
  -d '{"id":"evt_test","type":"customer.subscription.created","data":{"object":{}}}' \
  "$BASE/api/payments/webhook")
if [ "$ENABLED" = "True" ] || [ "$ENABLED" = "true" ]; then
  # SDK rejects bogus signature → 400 invalid_signature
  code_eq 400 "$CODE" "webhook rejects bad signature"
  ERR=$(json_get error)
  [ "$ERR" = "invalid_signature" ] && ok "error == invalid_signature" || bad "error was '$ERR'"
else
  # Disabled — still 503 regardless of signature header
  code_eq 503 "$CODE" "webhook 503 (disabled)"
fi

# --- 4. global JSON parser is NOT eating webhook bytes ------------------
# Indirect check: a path that DOES use express.json() should still work.
# If the payments mount accidentally captured /, this would 503.
hr "4. JSON parser still works for /api/auth/me"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/auth/me")
# Anonymous /me returns 401 with a JSON body — confirms downstream routing
# is intact. (If we'd broken express.json mounting, we'd get 500 or hang.)
code_eq 401 "$CODE" "auth/me unaffected by payments mount"

# ============================================================================
# Phase 2d additions — plan tier, checkout, portal, paid-tier gating
# ============================================================================

# Auth-bucket retry — the strict limiter on /api/auth/* may bounce signup.
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

# --- 5. anonymous /api/payments/plan -> 401 -----------------------------
# /plan is gated by requireUser(); anonymous requests must 401, not 200
# with a "free" payload (would leak the existence of the endpoint).
hr "5. anonymous /api/payments/plan"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/payments/plan")
code_eq 401 "$CODE" "anonymous plan request rejected"

# --- 6. anonymous /api/payments/checkout -> 401 -------------------------
hr "6. anonymous POST /api/payments/checkout"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  "$BASE/api/payments/checkout")
code_eq 401 "$CODE" "anonymous checkout rejected"

# --- 7. anonymous POST /api/payments/portal -> 401 ----------------------
hr "7. anonymous POST /api/payments/portal"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  "$BASE/api/payments/portal")
code_eq 401 "$CODE" "anonymous portal rejected"

# --- 8. signup so subsequent calls are signed-in ------------------------
hr "8. signup -> session"
rm -f "$JAR"
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

# --- 9. signed-in /api/payments/plan defaults to 'free' -----------------
# Brand-new user with no Stripe state → active_user_plan view yields 'free'.
hr "9. signed-in /api/payments/plan -> free"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/payments/plan")
code_eq 200 "$CODE" "plan endpoint reachable"
KIND=$(json_get kind)
[ "$KIND" = "payments.plan" ] && ok "kind == payments.plan" || bad "kind was '$KIND'"
PLAN=$(json_get plan)
[ "$PLAN" = "free" ] && ok "plan defaults to 'free' for new user" || bad "plan was '$PLAN'"
STATUS=$(json_get stripeStatus)
# stripe_status is 'free' from the COALESCE in the view's SELECT.
[ "$STATUS" = "free" ] && ok "stripeStatus == free for new user" || bad "stripeStatus was '$STATUS'"

# --- 10. signed-in /checkout when Stripe disabled -> 503 ----------------
# The 503 comes from the route's config.stripe.enabled check, not from
# the SDK trying to call out. This is the deliberate "off" posture.
hr "10. /checkout returns 503 when Stripe disabled"
if [ "$ENABLED" = "True" ] || [ "$ENABLED" = "true" ]; then
  ok "Stripe enabled — skipping disabled-state checkout test"
else
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" \
    -X POST -H 'Content-Type: application/json' \
    -d '{}' "$BASE/api/payments/checkout")
  code_eq 503 "$CODE" "checkout 503 when disabled"
  KIND=$(json_get kind)
  [ "$KIND" = "payments.disabled" ] && ok "kind == payments.disabled" || bad "kind was '$KIND'"
fi

# --- 11. signed-in /portal when Stripe disabled -> 503 ------------------
hr "11. /portal returns 503 when Stripe disabled"
if [ "$ENABLED" = "True" ] || [ "$ENABLED" = "true" ]; then
  ok "Stripe enabled — skipping disabled-state portal test"
else
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" \
    -X POST -H 'Content-Type: application/json' \
    -d '{}' "$BASE/api/payments/portal")
  code_eq 503 "$CODE" "portal 503 when disabled"
  KIND=$(json_get kind)
  [ "$KIND" = "payments.disabled" ] && ok "kind == payments.disabled" || bad "kind was '$KIND'"
fi

# --- 12. paid-tier gate on audio features: free user -> 402 -------------
# The gate IS independent of Stripe enablement: requirePaid() reads the
# active_user_plan view, not the SDK. So this should 402 even when keys
# are unset. Pull a real artist id first via the (free) roster endpoint.
hr "12. /api/artists/:id/features returns 402 for free users"
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
      "$BASE/api/artists/$ARTIST_ID/features")
    code_eq 402 "$CODE" "features endpoint gated for free user"
    KIND=$(json_get kind)
    [ "$KIND" = "payments.required" ] && ok "kind == payments.required" || bad "kind was '$KIND'"
    PLAN=$(json_get plan)
    [ "$PLAN" = "free" ] && ok "402 body reports plan == free" || bad "plan was '$PLAN'"
  fi
fi

# --- summary -------------------------------------------------------------
hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
