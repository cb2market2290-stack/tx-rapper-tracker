#!/usr/bin/env bash
# End-to-end TOTP 2FA smoke test.
#
# Prereqs:
#   * Backend running on :8787 (npm start)
#   * Same env in this shell as the server's process (SESSION_SECRET in
#     particular — the smoke script uses src/auth/totp.js's
#     generateCurrentCode() to drive the verify endpoint, and the encrypted-
#     secret HKDF derivation needs to match).
#   * Postgres reachable; migration 005 (user_totp + recovery_codes) applied.
#
# Covers the full ladder:
#   1.  signup + first /me works (no 2FA yet)
#   2.  /api/auth/2fa/enroll            -> 200, returns secret
#   3.  /api/auth/2fa/enroll/verify     -> 200, returns 10 recovery codes
#   4.  /me still works post-enroll
#   5.  logout
#   6.  /login with same creds          -> 200 + needs2fa:true (no user echoed)
#   7.  /me with the pre_2fa cookie     -> 401 (pre-session can't authenticate)
#   8.  /verify with WRONG code         -> 401
#   9.  /verify with RIGHT code         -> 200, full session
#  10.  /me with promoted cookie        -> 200
#  11.  logout, login again, /verify with a recovery code -> 200, single-use
#  12.  logout, login again, /verify with the SAME recovery code -> 401
#  13.  /verify with TOTP code          -> 200 (back to a full session)
#  14.  /disable                        -> 200 (password + code required)
#  15.  logout, login                   -> 200 with NO needs2fa flag
#
# The strict auth rate limit is 10 / minute by default. We make ~13 strict-
# bucket calls; on 429 we back off and retry, the same way test-reset.sh
# handles step 11.
#
# Run: bash scripts/test-2fa.sh

set -u

BASE="${BASE:-http://localhost:8787}"
RAND=$RANDOM
EMAIL="2fa-$RAND@example.com"
PW='correct-horse-battery-staple-42'

JAR=/tmp/tx-2fa-jar.txt
JAR_PRE=/tmp/tx-2fa-jar-pre.txt   # used to confirm pre_2fa cookie can't hit /me
RESP=/tmp/tx-2fa.json
PASS=0
FAIL=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()   { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

# Ensure cookie jars are fresh — leftover from a previous run can mask bugs.
rm -f "$JAR" "$JAR_PRE"

# --- helpers ---------------------------------------------------------------

# Print the current TOTP code for a Base32 secret using the SAME totp module
# the server uses. Run from the project root so the relative import resolves.
gen_totp() {
  local secret="$1"
  ( cd "$(dirname "$0")/.." && \
    node --input-type=module -e "
      import { generateCurrentCode } from './src/auth/totp.js';
      process.stdout.write(generateCurrentCode('$secret'));
    " )
}

# Pull a JSON field with python (already used by test-reset.sh).
json_get() {
  python3 -c "import json,sys;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null
}

# json_get_idx KEY INDEX  — for arrays. Used to grab recoveryCodes[0].
json_get_idx() {
  python3 -c "import json;print(json.load(open('$RESP')).get('$1',[])[$2])" 2>/dev/null
}

# Run a curl with retry on 429 (strict-auth bucket is 10/min). Mirrors the
# pattern in scripts/test-reset.sh step 11. Echoes the HTTP code.
do_curl_retry() {
  # do_curl_retry METHOD PATH [DATA] [JAR_FILE]
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

# --- 1. signup + baseline /me --------------------------------------------

hr "1. signup $EMAIL"
CODE=$(do_curl_retry POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 201 "$CODE" "signup"

hr "1b. /me works after signup (no 2FA yet)"
CODE=$(do_curl_retry GET /api/auth/me)
code_eq 200 "$CODE" "/me with fresh signup cookie"
ME_EMAIL=$(json_get email)
[ "$ME_EMAIL" = "$EMAIL" ] && ok "/me returns the right email" || bad "/me email mismatch: $ME_EMAIL"

# --- 2. enroll ------------------------------------------------------------

hr "2. POST /api/auth/2fa/enroll"
CODE=$(do_curl_retry POST /api/auth/2fa/enroll '{}')
code_eq 200 "$CODE" "/2fa/enroll"
SECRET=$(json_get secret)
QR=$(json_get qrDataUrl)
if [ -n "$SECRET" ] && [ ${#SECRET} -ge 16 ]; then
  ok "secret returned (${#SECRET} chars)"
else
  bad "secret missing or too short: $SECRET"
fi
case "$QR" in
  data:image/png\;base64,*) ok "qrDataUrl is a PNG data URL" ;;
  *) bad "qrDataUrl missing or wrong shape" ;;
esac

# --- 3. enroll/verify -----------------------------------------------------

hr "3. POST /api/auth/2fa/enroll/verify (live code)"
CODE_TOTP=$(gen_totp "$SECRET")
if [ ${#CODE_TOTP} -eq 6 ]; then
  ok "generated TOTP $CODE_TOTP"
else
  bad "could not generate TOTP code (got '$CODE_TOTP')"
  echo "summary"; echo "passed: $PASS"; echo "failed: $FAIL"; exit 1
fi
CODE=$(do_curl_retry POST /api/auth/2fa/enroll/verify "{\"code\":\"$CODE_TOTP\"}")
code_eq 200 "$CODE" "/2fa/enroll/verify"
RC0=$(json_get_idx recoveryCodes 0)
RC1=$(json_get_idx recoveryCodes 1)
NRC=$(python3 -c "import json;print(len(json.load(open('$RESP')).get('recoveryCodes',[])))" 2>/dev/null)
[ "$NRC" = "10" ] && ok "10 recovery codes returned" || bad "expected 10 recovery codes, got $NRC"
[ -n "$RC0" ] && ok "got first recovery code (${#RC0} chars)" || bad "no recovery code in response"

# --- 4. /me still works post-enroll --------------------------------------

hr "4. /me still works after enroll"
CODE=$(do_curl_retry GET /api/auth/me)
code_eq 200 "$CODE" "/me with full session post-enroll"
MFA_EN=$(python3 -c "import json;print(json.load(open('$RESP')).get('mfa',{}).get('enrolled',''))" 2>/dev/null)
[ "$MFA_EN" = "True" ] && ok "/me reports mfa.enrolled=true" || bad "/me mfa.enrolled wrong: $MFA_EN"

# --- 5. logout ------------------------------------------------------------

hr "5. logout"
CODE=$(do_curl_retry POST /api/auth/logout '{}')
code_eq 200 "$CODE" "/logout"

# --- 6. login -> needs2fa ------------------------------------------------

hr "6. /login -> 200 + needs2fa:true"
CODE=$(do_curl_retry POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 200 "$CODE" "/login (returns pre_2fa)"
NEEDS=$(json_get needs2fa)
[ "$NEEDS" = "True" ] && ok "needs2fa=true in response" || bad "needs2fa missing/wrong: '$NEEDS'"
USER_FIELD=$(python3 -c "import json;print('user' in json.load(open('$RESP')))" 2>/dev/null)
[ "$USER_FIELD" = "False" ] && ok "user info NOT echoed in pre_2fa login" \
  || bad "pre_2fa login leaked user object"

# Save the pre_2fa cookie jar to a separate file so we can confirm it can't
# authenticate on /me. Curl rewrote $JAR with the pre_2fa cookie just now.
cp "$JAR" "$JAR_PRE"

# --- 7. /me with pre_2fa cookie -> 401 -----------------------------------

hr "7. /me with the pre_2fa cookie -> 401"
CODE=$(do_curl_retry GET /api/auth/me '' "$JAR_PRE")
code_eq 401 "$CODE" "/me blocked while only the pre_2fa cookie is present"

# --- 8. /verify wrong code -> 401 ----------------------------------------

hr "8. /2fa/verify wrong code -> 401"
# Build a wrong code that's still 6 digits (and NOT the right one).
WRONG="000000"
[ "$CODE_TOTP" = "$WRONG" ] && WRONG="111111"
CODE=$(do_curl_retry POST /api/auth/2fa/verify "{\"code\":\"$WRONG\"}")
code_eq 401 "$CODE" "/2fa/verify wrong code"

# --- 9. /verify right code -> 200 ----------------------------------------

hr "9. /2fa/verify right code -> 200"
CODE_TOTP=$(gen_totp "$SECRET")
CODE=$(do_curl_retry POST /api/auth/2fa/verify "{\"code\":\"$CODE_TOTP\"}")
code_eq 200 "$CODE" "/2fa/verify right code"
VUSER=$(python3 -c "import json;print(json.load(open('$RESP')).get('user',{}).get('email',''))" 2>/dev/null)
[ "$VUSER" = "$EMAIL" ] && ok "/verify echoes user object" || bad "/verify user mismatch: $VUSER"

# --- 10. /me works on promoted session -----------------------------------

hr "10. /me works after promotion"
CODE=$(do_curl_retry GET /api/auth/me)
code_eq 200 "$CODE" "/me with full session post-2fa"

# --- 11. recovery code ---------------------------------------------------

hr "11. recovery code single-use: logout, login, verify with RC0"
CODE=$(do_curl_retry POST /api/auth/logout '{}')
code_eq 200 "$CODE" "logout (recovery prep)"
CODE=$(do_curl_retry POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 200 "$CODE" "login (recovery prep, expect needs2fa)"
CODE=$(do_curl_retry POST /api/auth/2fa/verify "{\"recoveryCode\":\"$RC0\"}")
code_eq 200 "$CODE" "/verify with recovery code"
URC=$(python3 -c "import json;print(json.load(open('$RESP')).get('usedRecovery',''))" 2>/dev/null)
[ "$URC" = "True" ] && ok "response flags usedRecovery=true" || bad "usedRecovery missing"
RREM=$(python3 -c "import json;print(json.load(open('$RESP')).get('recoveryCodesRemaining',''))" 2>/dev/null)
[ "$RREM" = "9" ] && ok "9 recovery codes remaining" || bad "wrong remaining count: $RREM"

# --- 12. same recovery code rejected -------------------------------------

hr "12. SAME recovery code -> 401 (single-use)"
CODE=$(do_curl_retry POST /api/auth/logout '{}')
code_eq 200 "$CODE" "logout (replay prep)"
CODE=$(do_curl_retry POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 200 "$CODE" "login (replay prep)"
CODE=$(do_curl_retry POST /api/auth/2fa/verify "{\"recoveryCode\":\"$RC0\"}")
code_eq 401 "$CODE" "/verify with already-used recovery code"

# --- 13. recover the session with TOTP so we can disable -----------------

hr "13. /verify with TOTP -> 200 (back to a full session)"
CODE_TOTP=$(gen_totp "$SECRET")
CODE=$(do_curl_retry POST /api/auth/2fa/verify "{\"code\":\"$CODE_TOTP\"}")
code_eq 200 "$CODE" "/verify with TOTP"

# --- 14. disable ---------------------------------------------------------

hr "14. /2fa/disable (password + code)"
CODE_TOTP=$(gen_totp "$SECRET")
CODE=$(do_curl_retry POST /api/auth/2fa/disable \
  "{\"currentPassword\":\"$PW\",\"code\":\"$CODE_TOTP\"}")
code_eq 200 "$CODE" "/2fa/disable"

# --- 15. login no longer asks for 2FA ------------------------------------

hr "15. logout, login -> NO needs2fa flag"
CODE=$(do_curl_retry POST /api/auth/logout '{}')
code_eq 200 "$CODE" "logout (post-disable)"
CODE=$(do_curl_retry POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 200 "$CODE" "login (post-disable)"
NEEDS=$(json_get needs2fa)
# After disable, response should be a normal full-session shape — no needs2fa.
if [ -z "$NEEDS" ] || [ "$NEEDS" = "False" ]; then
  ok "needs2fa is absent in post-disable login"
else
  bad "needs2fa=$NEEDS after disable (should be missing)"
fi
USER_FIELD=$(python3 -c "import json;print('user' in json.load(open('$RESP')))" 2>/dev/null)
[ "$USER_FIELD" = "True" ] && ok "user object echoed (full session)" \
  || bad "user object missing on post-disable login"

CODE=$(do_curl_retry GET /api/auth/me)
code_eq 200 "$CODE" "/me works on the post-disable session"

# --- summary -------------------------------------------------------------

hr "summary"
echo "passed: $PASS"
echo "failed: $FAIL"
[ "$FAIL" = 0 ] && exit 0 || exit 1
