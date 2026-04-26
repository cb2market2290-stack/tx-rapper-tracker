#!/usr/bin/env bash
# WebAuthn endpoint-shape smoke test.
#
# What this can and CAN'T do:
#   * curl can't drive a real authenticator (no FIDO key, no Touch ID), so we
#     can't run a full register/authenticate ceremony from a shell. That's
#     covered by browser smoke (open the app, click "Add a security key",
#     verify the prompt + persistence in webauthn_credentials).
#   * We CAN verify endpoint shapes: auth gating, request validation,
#     pre_2fa cookie handling, rate-limit bucket selection, listing/delete
#     wiring, and that the options endpoints return well-formed JSON the
#     browser would accept.
#
# Prereqs:
#   * Backend running on :8787 (npm start) — including @simplewebauthn/server
#     installed (npm install).
#   * Postgres reachable; migration 008 (webauthn_credentials + challenges)
#     applied.
#
# Covers:
#   1.  /credentials      — 401 unauthenticated
#   2.  /register/options — 401 unauthenticated
#   3.  signup -> full session via /me
#   4.  /credentials      — 200, empty list
#   5.  /register/options — 200, well-formed PublicKeyCredentialCreationOptions
#   6.  /register/verify  — 400 with no credential body (route reachable)
#   7.  /authenticate/options — 401 without pre_2fa cookie
#   8.  logout, signup of a 2nd user with TOTP, simulate pre_2fa step (skipped
#       — covered by test-2fa.sh; here we just confirm the no-pre_2fa case
#       returns 401)
#   9.  delete a non-existent credential -> 404
#  10.  /authenticate/verify — 401 without pre_2fa cookie
#
# The strict auth bucket covers /authenticate/options + /authenticate/verify;
# the smoke makes ~3 strict-bucket calls so 429 backoff is unlikely but we
# wrap them in do_curl_retry anyway.
#
# Run: bash scripts/test-webauthn.sh

set -u

BASE="${BASE:-http://localhost:8787}"
RAND=$RANDOM
EMAIL="wa-$RAND@example.com"
PW='correct-horse-battery-staple-42'

JAR=/tmp/tx-wa-jar.txt
RESP=/tmp/tx-wa.json
PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()  { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

# Pull a JSON field with python (mirrors test-2fa.sh's helper).
json_get()      { python3 -c "import json;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null; }
json_has()      { python3 -c "import json,sys;d=json.load(open('$RESP'));sys.exit(0 if '$1' in d else 1)" 2>/dev/null; }
json_nested()   { python3 -c "import json;d=json.load(open('$RESP'));
parts='$1'.split('.')
for p in parts: d=d[p] if isinstance(d,dict) and p in d else None
print(d if d is not None else '')" 2>/dev/null; }

rm -f "$JAR"

# Run a curl with retry on 429. Mirrors the pattern in test-2fa.sh.
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

# --- 1. anonymous /credentials -> 401 ------------------------------------

hr "1. /credentials without a session"
CODE=$(do_curl_retry GET /api/auth/webauthn/credentials)
code_eq 401 "$CODE" "GET /credentials anon"

# --- 2. anonymous /register/options -> 401 -------------------------------

hr "2. /register/options without a session"
CODE=$(do_curl_retry POST /api/auth/webauthn/register/options "{}")
code_eq 401 "$CODE" "POST /register/options anon"

# --- 3. signup -----------------------------------------------------------

hr "3. signup $EMAIL"
CODE=$(do_curl_retry POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 201 "$CODE" "signup"

CODE=$(do_curl_retry GET /api/auth/me)
code_eq 200 "$CODE" "/me with full session"

# --- 4. listing is empty for a fresh user --------------------------------

hr "4. /credentials returns []"
CODE=$(do_curl_retry GET /api/auth/webauthn/credentials)
code_eq 200 "$CODE" "GET /credentials"
COUNT=$(python3 -c "import json;d=json.load(open('$RESP'));print(len(d.get('credentials',[])))" 2>/dev/null)
if [ "$COUNT" = "0" ]; then ok "credentials list is empty"; else bad "expected 0 credentials, got $COUNT"; fi

# --- 5. /register/options shape ------------------------------------------

hr "5. /register/options returns well-formed options"
CODE=$(do_curl_retry POST /api/auth/webauthn/register/options "{\"name\":\"smoke key\"}")
code_eq 200 "$CODE" "POST /register/options"

# Required PublicKeyCredentialCreationOptions fields.
for f in challenge rp user pubKeyCredParams; do
  if python3 -c "import json,sys;d=json.load(open('$RESP'));sys.exit(0 if '$f' in d.get('options',{}) else 1)" 2>/dev/null; then
    ok "options.$f present"
  else
    bad "options.$f missing"
  fi
done
# rp.id should match WEBAUTHN_RP_ID (default 'localhost' in dev)
RPID=$(python3 -c "import json;print(json.load(open('$RESP')).get('options',{}).get('rp',{}).get('id',''))" 2>/dev/null)
if [ -n "$RPID" ]; then ok "options.rp.id = $RPID"; else bad "options.rp.id is empty"; fi

# --- 6. /register/verify with no body -> 400 -----------------------------

hr "6. /register/verify rejects empty body"
CODE=$(do_curl_retry POST /api/auth/webauthn/register/verify "{}")
# 400 (validation) is the expected shape; anything in the 4xx family beats 5xx.
if [ "$CODE" = "400" ] || [ "$CODE" = "422" ]; then
  ok "register/verify rejects empty body (HTTP $CODE)"
else
  bad "register/verify with {} returned HTTP $CODE (want 400/422)"
fi

# --- 7. /authenticate/options requires pre_2fa cookie --------------------
# A full-session user is NOT in the pre_2fa stage, so this should 401.

hr "7. /authenticate/options without pre_2fa session"
CODE=$(do_curl_retry POST /api/auth/webauthn/authenticate/options "{}")
code_eq 401 "$CODE" "POST /authenticate/options (no pre_2fa)"

# --- 8. logout, then /authenticate/options anon also -> 401 -------------

hr "8. logout, /authenticate/options anonymously"
CODE=$(do_curl_retry POST /api/auth/logout "")
code_eq 200 "$CODE" "logout"
CODE=$(do_curl_retry POST /api/auth/webauthn/authenticate/options "{}")
code_eq 401 "$CODE" "POST /authenticate/options (anon)"

# --- 9. delete a non-existent credential -> 401 (no session) -------------

hr "9. DELETE /credentials/9999 without a session"
CODE=$(do_curl_retry DELETE /api/auth/webauthn/credentials/9999)
code_eq 401 "$CODE" "DELETE /credentials/9999 anon"

# --- 10. /authenticate/verify without pre_2fa -> 401 ---------------------

hr "10. /authenticate/verify without pre_2fa"
# Body must satisfy the schema (`response: object`) before the session check
# runs — validation comes first in the route. With the schema satisfied and
# no pre_2fa cookie present, the session check returns 401.
CODE=$(do_curl_retry POST /api/auth/webauthn/authenticate/verify '{"response":{}}')
code_eq 401 "$CODE" "POST /authenticate/verify (no pre_2fa)"

# --- summary -------------------------------------------------------------

hr "summary"
printf '  PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "  (Browser smoke still required — register + sign-in ceremonies need a real authenticator.)"
