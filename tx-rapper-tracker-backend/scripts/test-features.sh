#!/usr/bin/env bash
# Audio-features endpoint smoke test (Phase 2c).
#
# Hits GET /api/artists and GET /api/artists/:id/features to verify:
#   1. Auth gating         — 401 anonymous on both
#   2. Roster shape        — /api/artists returns {kind:'artists.list', rows:[{id,name,...}]}
#   3. UUID validation     — non-UUID artist id → 400 bad_request
#   4. Not-found path      — well-formed but unknown UUID → 404 not_found
#   5. Happy path          — real artist UUID → 200 with the documented shape:
#                            { kind:'artists.features', artistId, summary:{...}, tracks:[...] }
#   6. Empty queue OK      — even with zero analyzed tracks, summary fields are
#                            null (not undefined) and tracks is an empty array.
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Postgres reachable; migration 009 (track_features + track_extraction_jobs)
#     applied. The roster MUST contain at least one non-archived artist —
#     migration 006 seeds these by default.
#
# Run: bash scripts/test-features.sh

set -u

BASE="${BASE:-http://localhost:8787}"
RAND=$RANDOM
EMAIL="feat-$RAND@example.com"
PW='correct-horse-battery-staple-42'

JAR=/tmp/tx-feat-jar.txt
RESP=/tmp/tx-feat.json
PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()  { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

# Tiny python helpers — the smoke avoids a jq dependency. Mirrors test-webauthn.sh.
json_get()    { python3 -c "import json;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null; }
json_has()    { python3 -c "import json,sys;d=json.load(open('$RESP'));sys.exit(0 if '$1' in d else 1)" 2>/dev/null; }
json_first_artist_id() {
  python3 -c "
import json
d = json.load(open('$RESP'))
rows = d.get('rows') or []
print(rows[0]['id'] if rows and 'id' in rows[0] else '')
" 2>/dev/null
}
json_first_artist_name() {
  python3 -c "
import json
d = json.load(open('$RESP'))
rows = d.get('rows') or []
print(rows[0]['name'] if rows and 'name' in rows[0] else '')
" 2>/dev/null
}
json_summary_field() {
  python3 -c "
import json
d = json.load(open('$RESP'))
s = d.get('summary') or {}
v = s.get('$1')
print('null' if v is None else v)
" 2>/dev/null
}
json_tracks_count() {
  python3 -c "
import json
d = json.load(open('$RESP'))
print(len(d.get('tracks') or []))
" 2>/dev/null
}

rm -f "$JAR"

# Retry helper for the auth bucket (signup gets 429-bucketed by the strict limiter).
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

# --- 1. anonymous /api/artists -> 401 ------------------------------------
hr "1. anonymous /api/artists"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/artists")
code_eq 401 "$CODE" "anonymous artists list rejected"

# --- 2. anonymous /api/artists/:id/features -> 401 -----------------------
hr "2. anonymous /api/artists/:id/features"
FAKE_UUID='11111111-2222-3333-4444-555555555555'
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/artists/$FAKE_UUID/features")
code_eq 401 "$CODE" "anonymous features request rejected"

# --- 3. sign up + auto-session ------------------------------------------
hr "3. signup -> session"
CODE=$(do_curl_retry POST /api/auth/signup \
  "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
code_eq 200 "$CODE" "signup created session"

CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/auth/me")
code_eq 200 "$CODE" "/me confirms signed in"

# --- 4. /api/artists with a session -> 200 + valid roster ---------------
hr "4. signed-in /api/artists shape"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists")
code_eq 200 "$CODE" "roster fetched"
KIND=$(json_get kind)
if [ "$KIND" = "artists.list" ]; then ok "kind == artists.list"; else bad "kind was '$KIND'"; fi
ARTIST_ID=$(json_first_artist_id)
ARTIST_NAME=$(json_first_artist_name)
if [ -n "$ARTIST_ID" ]; then
  ok "first artist has UUID id ($ARTIST_NAME = $ARTIST_ID)"
else
  bad "no artist UUID in roster — features test cannot continue"
  echo "Pass: $PASS  Fail: $FAIL"
  exit 1
fi

# --- 5. UUID validation: non-UUID id -> 400 -----------------------------
hr "5. UUID validation"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists/not-a-uuid/features")
code_eq 400 "$CODE" "non-UUID id rejected"
ERR=$(json_get error)
if [ "$ERR" = "bad_request" ]; then ok "error code == bad_request"; else bad "error code was '$ERR'"; fi

# --- 6. unknown UUID -> 404 ---------------------------------------------
hr "6. unknown UUID"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists/$FAKE_UUID/features")
code_eq 404 "$CODE" "unknown UUID returns not_found"
ERR=$(json_get error)
if [ "$ERR" = "not_found" ]; then ok "error code == not_found"; else bad "error code was '$ERR'"; fi

# --- 7. happy path: real artist UUID -> 200 + documented shape ----------
hr "7. real artist features payload"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" "$BASE/api/artists/$ARTIST_ID/features")
code_eq 200 "$CODE" "features fetched for $ARTIST_NAME"
KIND=$(json_get kind)
if [ "$KIND" = "artists.features" ]; then ok "kind == artists.features"; else bad "kind was '$KIND'"; fi
RESPONSE_ARTIST_ID=$(json_get artistId)
if [ "$RESPONSE_ARTIST_ID" = "$ARTIST_ID" ]; then ok "artistId echoed back"; else bad "artistId echo: $RESPONSE_ARTIST_ID vs $ARTIST_ID"; fi

# Both summary + tracks must be present even if the queue is empty.
if json_has summary; then ok "payload has 'summary'"; else bad "payload missing 'summary'"; fi
if json_has tracks;  then ok "payload has 'tracks'";  else bad "payload missing 'tracks'"; fi

# Track count must be a non-negative integer (0 is valid — empty queue).
TC=$(json_summary_field trackCount)
if [[ "$TC" =~ ^[0-9]+$ ]] || [ "$TC" = "0" ]; then
  ok "summary.trackCount is integer ($TC)"
else
  bad "summary.trackCount not an integer: '$TC'"
fi

# When trackCount is 0, summary.featureBonus MUST be null (not 0) so the
# frontend can distinguish "no data" from "low-energy artist". This is the
# regression we caught in test/features.test.js.
ARRAY_LEN=$(json_tracks_count)
if [ "$TC" = "0" ]; then
  FB=$(json_summary_field featureBonus)
  if [ "$FB" = "null" ]; then
    ok "empty queue: summary.featureBonus == null (regression check)"
  else
    bad "empty queue: summary.featureBonus should be null, got '$FB'"
  fi
  if [ "$ARRAY_LEN" = "0" ]; then
    ok "empty queue: tracks is []"
  else
    bad "empty queue: tracks length != 0 ($ARRAY_LEN)"
  fi
else
  ok "queue not empty: $TC analyzed tracks (skipping null-bonus check)"
fi

# --- summary -------------------------------------------------------------
hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
