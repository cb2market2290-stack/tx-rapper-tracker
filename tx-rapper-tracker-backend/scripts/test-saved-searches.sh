#!/usr/bin/env bash
# Phase 3a.2 — /api/saved-searches CRUD smoke test.
#
# Exercises the full HTTP surface of the saved-searches feature against
# a running backend + real Postgres:
#
#   1. Anonymous everything → 401 (the route is requireUser-gated)
#   2. Signup → session
#   3. GET /api/saved-searches → empty list with tier context
#   4. POST creates the first search → 201 + shaped row
#   5. POST a second search at the free cap → 403 with kind=savedsearches.tier_cap
#   6. PATCH disables the search → 200, enabled flips to false
#   7. PATCH a bad payload → 400 bad_request
#   8. GET /api/saved-searches/:id of a foreign UUID → 404
#   9. GET /api/saved-searches/oops → 400 (invalid UUID)
#  10. Owner isolation: a SECOND user cannot list / get / patch / delete
#      the first user's row. (We need a separate session jar.)
#  11. DELETE removes the row → 200, list is back to empty
#  12. DELETE again → 404
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Migrations 011 + 014 applied.
#
# Run: bash scripts/test-saved-searches.sh

set -u

BASE="${BASE:-http://localhost:8787}"
JAR_A=/tmp/tx-saved-jar-a.txt
JAR_B=/tmp/tx-saved-jar-b.txt
RESP=/tmp/tx-saved.json
PASS=0
FAIL=0

RAND=$RANDOM
EMAIL_A="ss-a-$RAND@example.com"
EMAIL_B="ss-b-$RAND@example.com"
PW='correct-horse-battery-staple-42'

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()  { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

json_get()       { python3 -c "import json;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null; }
json_row_field() { python3 -c "import json;print(json.load(open('$RESP')).get('row',{}).get('$1',''))" 2>/dev/null; }
json_rows_count() {
  python3 -c "
import json
d = json.load(open('$RESP'))
print(len(d.get('rows') or []))
" 2>/dev/null
}
json_get_first_id() {
  python3 -c "
import json
d = json.load(open('$RESP'))
rows = d.get('rows') or []
print(rows[0].get('id','') if rows else '')
" 2>/dev/null
}

rm -f "$JAR_A" "$JAR_B"

# Auth-bucket retry — the strict limiter on /api/auth/* may bounce signup.
do_curl_retry() {
  local method="$1" path="$2" data="${3:-}" jar="${4:-$JAR_A}"
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

# --- 1. anonymous everything -> 401 ----------------------------------------
hr "1. anonymous endpoints reject"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/saved-searches")
code_eq 401 "$CODE" "anonymous GET /api/saved-searches"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  "$BASE/api/saved-searches")
code_eq 401 "$CODE" "anonymous POST /api/saved-searches"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' \
  -X DELETE "$BASE/api/saved-searches/00000000-0000-0000-0000-000000000000")
code_eq 401 "$CODE" "anonymous DELETE /api/saved-searches/:id"

# --- 2. signup user A ------------------------------------------------------
hr "2. signup user A"
CODE=$(do_curl_retry POST /api/auth/signup \
  "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}" "$JAR_A")
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  ok "user A signed up (HTTP $CODE)"
else
  bad "user A signup failed: HTTP $CODE — aborting"
  hr "Summary"
  echo "Pass: $PASS  Fail: $FAIL"
  exit 1
fi

# --- 3. GET empty list, tier context present -------------------------------
hr "3. empty list + tier context"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" "$BASE/api/saved-searches")
code_eq 200 "$CODE" "list endpoint reachable"

KIND=$(json_get kind)
[ "$KIND" = "savedsearches.list" ] && ok "kind == savedsearches.list" || bad "kind was '$KIND'"

PLAN=$(json_get planSlug)
[ "$PLAN" = "free" ] && ok "planSlug == free for new user" || bad "planSlug was '$PLAN'"

CAP=$(json_get cap)
[ "$CAP" = "1" ] && ok "free cap == 1" || bad "cap was '$CAP'"

COUNT=$(json_get count)
[ "$COUNT" = "0" ] && ok "count == 0 for empty list" || bad "count was '$COUNT'"

ATCAP=$(json_get atCap)
[ "$ATCAP" = "False" ] && ok "atCap == false for empty list" || bad "atCap was '$ATCAP'"

LEN=$(json_rows_count)
[ "$LEN" = "0" ] && ok "rows is empty" || bad "rows length was '$LEN'"

# --- 4. POST first saved search -> 201 -------------------------------------
hr "4. create first saved search"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"Megan over 1M","metric":"view_growth_7d","threshold":1000000,"comparator":">"}' \
  "$BASE/api/saved-searches")
code_eq 201 "$CODE" "first create returns 201"

KIND=$(json_get kind)
[ "$KIND" = "savedsearches.created" ] && ok "kind == savedsearches.created" || bad "kind was '$KIND'"

ID_1=$(json_row_field id)
if [ -n "$ID_1" ]; then ok "row has id ($ID_1)"; else bad "row missing id"; fi

NAME=$(json_row_field name)
[ "$NAME" = "Megan over 1M" ] && ok "row.name preserved" || bad "row.name was '$NAME'"

ENABLED=$(json_row_field enabled)
[ "$ENABLED" = "True" ] && ok "row.enabled defaults to true" || bad "row.enabled was '$ENABLED'"

# --- 5. second create at free cap -> 403 -----------------------------------
hr "5. second create over free cap"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"GloRilla pct","metric":"pct_growth_7d","threshold":0.05,"comparator":">="}' \
  "$BASE/api/saved-searches")
code_eq 403 "$CODE" "second create at cap returns 403"

KIND=$(json_get kind)
[ "$KIND" = "savedsearches.tier_cap" ] && ok "kind == savedsearches.tier_cap" || bad "kind was '$KIND'"

ERR=$(json_get error)
[ "$ERR" = "tier_cap" ] && ok "error == tier_cap" || bad "error was '$ERR'"

CAPV=$(json_get cap)
[ "$CAPV" = "1" ] && ok "response cap == 1" || bad "cap was '$CAPV'"

CNTV=$(json_get count)
[ "$CNTV" = "1" ] && ok "response count == 1" || bad "count was '$CNTV'"

# --- 6. PATCH disables the search -----------------------------------------
hr "6. PATCH enabled=false"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X PATCH -H 'Content-Type: application/json' \
  -d '{"enabled":false}' \
  "$BASE/api/saved-searches/$ID_1")
code_eq 200 "$CODE" "PATCH succeeds"

KIND=$(json_get kind)
[ "$KIND" = "savedsearches.updated" ] && ok "kind == savedsearches.updated" || bad "kind was '$KIND'"

ENABLED=$(json_row_field enabled)
[ "$ENABLED" = "False" ] && ok "row.enabled flipped to false" || bad "row.enabled was '$ENABLED'"

# --- 7. PATCH bad payload -> 400 ------------------------------------------
hr "7. PATCH bad payload rejected"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X PATCH -H 'Content-Type: application/json' \
  -d '{"comparator":"=="}' \
  "$BASE/api/saved-searches/$ID_1")
code_eq 400 "$CODE" "bad comparator rejected"
ERR=$(json_get error)
[ "$ERR" = "bad_request" ] && ok "error == bad_request" || bad "error was '$ERR'"

# Empty body (no fields) -> 400
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X PATCH -H 'Content-Type: application/json' \
  -d '{}' \
  "$BASE/api/saved-searches/$ID_1")
code_eq 400 "$CODE" "empty patch rejected"

# --- 8. GET foreign UUID -> 404 -------------------------------------------
hr "8. GET foreign UUID -> 404"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  "$BASE/api/saved-searches/00000000-0000-0000-0000-000000000000")
code_eq 404 "$CODE" "foreign UUID returns 404"

# --- 9. GET non-UUID -> 400 ------------------------------------------------
hr "9. non-UUID id -> 400"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  "$BASE/api/saved-searches/oops")
code_eq 400 "$CODE" "non-UUID id rejected"

# --- 10. owner isolation (signup user B) -----------------------------------
hr "10. owner isolation"
CODE=$(do_curl_retry POST /api/auth/signup \
  "{\"email\":\"$EMAIL_B\",\"password\":\"$PW\"}" "$JAR_B")
if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
  bad "user B signup failed: HTTP $CODE — skipping isolation tests"
else
  ok "user B signed up (HTTP $CODE)"

  # B's list is empty — A's row is invisible
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_B" "$BASE/api/saved-searches")
  code_eq 200 "$CODE" "user B can list (empty)"
  LEN=$(json_rows_count)
  [ "$LEN" = "0" ] && ok "user B sees no rows" || bad "user B sees $LEN rows"

  # B can't GET A's id
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_B" \
    "$BASE/api/saved-searches/$ID_1")
  code_eq 404 "$CODE" "user B GET of A's row → 404"

  # B can't PATCH A's id
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_B" \
    -X PATCH -H 'Content-Type: application/json' \
    -d '{"enabled":true}' \
    "$BASE/api/saved-searches/$ID_1")
  code_eq 404 "$CODE" "user B PATCH of A's row → 404"

  # B can't DELETE A's id
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_B" \
    -X DELETE "$BASE/api/saved-searches/$ID_1")
  code_eq 404 "$CODE" "user B DELETE of A's row → 404"

  # And A's row is still there
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
    "$BASE/api/saved-searches/$ID_1")
  code_eq 200 "$CODE" "user A's row survives B's attempts"
fi

# --- 11. DELETE removes the row -------------------------------------------
hr "11. DELETE removes A's row"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X DELETE "$BASE/api/saved-searches/$ID_1")
code_eq 200 "$CODE" "delete succeeds"
KIND=$(json_get kind)
[ "$KIND" = "savedsearches.deleted" ] && ok "kind == savedsearches.deleted" || bad "kind was '$KIND'"

# List is empty again
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" "$BASE/api/saved-searches")
code_eq 200 "$CODE" "list reachable after delete"
LEN=$(json_rows_count)
[ "$LEN" = "0" ] && ok "list is empty after delete" || bad "list length was '$LEN'"

# --- 12. DELETE again -> 404 ----------------------------------------------
hr "12. second DELETE -> 404"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR_A" \
  -X DELETE "$BASE/api/saved-searches/$ID_1")
code_eq 404 "$CODE" "deleting nonexistent row returns 404"

# --- summary --------------------------------------------------------------
hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
