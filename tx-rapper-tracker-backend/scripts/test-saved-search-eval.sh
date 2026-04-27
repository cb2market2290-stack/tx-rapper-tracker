#!/usr/bin/env bash
# Phase 3a.3 — saved-search evaluator live smoke.
#
# Exercises the evaluator end-to-end against a running backend + real
# Postgres + the breakout_signals matview. The unit tests in
# test/savedsearch-evaluator.test.js cover the pure helpers (metric/
# comparator/format/build-payload); this smoke covers the parts that
# unit tests can't:
#
#   1. The SQL paths (loadDueSavedSearches, findMatches, recordAlert)
#      against a real `breakout_signals` matview and `saved_searches`
#      row.
#   2. The mailer integration (ConsoleMailer in dev — we verify that
#      /tmp/last-reset-email.txt gets a saved-search-shaped email after
#      a fire).
#   3. The 24h cooling-off cap: a second invocation right after the
#      first must NOT re-fire and must NOT update last_alerted_at.
#
# Strategy:
#
#   * Sign up user A, create one saved search whose threshold is set
#     trivially low (-1 view_growth_7d, > -1 catches everything in the
#     matview, including artists with zero growth).
#   * Invoke evaluateAllSavedSearches via a small inline Node bridge
#     that imports the service module directly. We don't go through the
#     snapshot cron because we want a deterministic single-shot trigger.
#   * Verify result.fired ≥ 1 and the saved_searches row's
#     last_alerted_at is non-null.
#   * Invoke a second time. Verify result.fired === 0 (cooling-off
#     blocked it) and last_alerted_at is unchanged.
#   * Tear down the saved_search row so we don't leave litter.
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Migrations 011 + 014 applied.
#   * At least one snapshot has run so breakout_signals is non-empty.
#     If the matview is empty the evaluator will return fired=0 and the
#     test will report SKIP (not FAIL) since there's nothing to match
#     against.
#
# Run: bash scripts/test-saved-search-eval.sh

set -u

BASE="${BASE:-http://localhost:8787}"
JAR=/tmp/tx-eval-jar.txt
RESP=/tmp/tx-eval.json
NODE_OUT=/tmp/tx-eval-node.json
LAST_EMAIL=/tmp/last-reset-email.txt
PASS=0
FAIL=0
SKIP=0

RAND=$RANDOM
EMAIL="ss-eval-$RAND@example.com"
PW='correct-horse-battery-staple-42'

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$*"; SKIP=$((SKIP+1)); }
hr()   { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

json_get()       { python3 -c "import json;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null; }
json_row_field() { python3 -c "import json;print(json.load(open('$RESP')).get('row',{}).get('$1',''))" 2>/dev/null; }

rm -f "$JAR" "$LAST_EMAIL"

# Auth-bucket retry — same pattern as test-saved-searches.sh.
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

# --- 1. signup user --------------------------------------------------------
hr "1. signup user"
CODE=$(do_curl_retry POST /api/auth/signup \
  "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  ok "user signed up (HTTP $CODE)"
else
  bad "signup failed: HTTP $CODE — aborting"
  hr "Summary"
  echo "Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 1
fi

# --- 2. create one wide-catching saved search ------------------------------
hr "2. create saved search (catches everything)"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"Eval smoke (catch-all)","metric":"view_growth_7d","threshold":-1,"comparator":">"}' \
  "$BASE/api/saved-searches")
code_eq 201 "$CODE" "saved search created"

SS_ID=$(json_row_field id)
if [ -z "$SS_ID" ]; then
  bad "no saved-search id returned — aborting"
  hr "Summary"
  echo "Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 1
fi
ok "saved-search id = $SS_ID"

# --- 3. preflight: is breakout_signals non-empty? --------------------------
# If the matview is empty (no snapshots run yet on this DB) the evaluator
# has nothing to match against and the rest of the test is moot. We
# inspect via a tiny Node bridge so we don't need a psql client in PATH.
hr "3. preflight: matview row count"
LOG_LEVEL=silent node --input-type=module -e "
import { query, closePool } from './src/db/pool.js';
const r = await query('SELECT COUNT(*)::int AS n FROM breakout_signals');
console.log(JSON.stringify({ n: r.rows[0].n }));
await closePool();
" > "$NODE_OUT" 2>/dev/null

MV_N=$(python3 -c "import json;print(json.load(open('$NODE_OUT')).get('n',0))" 2>/dev/null || echo 0)
echo "  breakout_signals rows: $MV_N"

if [ "$MV_N" -eq 0 ]; then
  skip "breakout_signals is empty — run a snapshot first; skipping fire-path tests"
  # Still tear down the saved search before we exit.
  curl -sS -o /dev/null -b "$JAR" -X DELETE "$BASE/api/saved-searches/$SS_ID"
  hr "Summary"
  echo "Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi

# --- 4. invoke evaluator (first run, expect fired ≥ 1) --------------------
# We silence pino with LOG_LEVEL=silent so the only thing on stdout is the
# JSON.stringify of the orchestrator return. Without this, pino's structured
# logs interleave with the result and json.load chokes (it grabs the first
# log line and reports evaluated=0/fired=0 even when the run succeeded).
hr "4. invoke evaluator — should fire"
LOG_LEVEL=silent node --input-type=module -e "
import { evaluateAllSavedSearches } from './src/services/savedsearch-evaluator.js';
import { closePool } from './src/db/pool.js';
const out = await evaluateAllSavedSearches({ baseUrl: '$BASE' });
console.log(JSON.stringify(out));
await closePool();
" > "$NODE_OUT" 2>/dev/null

EVAL=$(python3 -c "import json;d=json.load(open('$NODE_OUT'));print(d.get('evaluated',0))" 2>/dev/null || echo 0)
FIRED=$(python3 -c "import json;d=json.load(open('$NODE_OUT'));print(d.get('fired',0))" 2>/dev/null || echo 0)
ERRS=$(python3 -c "import json;d=json.load(open('$NODE_OUT'));print(d.get('errors',0))" 2>/dev/null || echo 0)

echo "  evaluator returned: evaluated=$EVAL fired=$FIRED errors=$ERRS"
[ "$EVAL" -ge 1 ] && ok "evaluated ≥ 1 (saw our saved_search)" || bad "evaluated was $EVAL (expected ≥ 1)"
[ "$FIRED" -ge 1 ] && ok "fired ≥ 1 (matched against matview)" || bad "fired was $FIRED (expected ≥ 1)"
[ "$ERRS" = "0" ]  && ok "errors == 0" || bad "errors was $ERRS"

# --- 5. last_alerted_at should now be set ---------------------------------
hr "5. last_alerted_at set after fire"
LOG_LEVEL=silent node --input-type=module -e "
import { query, closePool } from './src/db/pool.js';
const r = await query('SELECT last_alerted_at, last_match_artist_id, last_match_value FROM saved_searches WHERE id = \$1', ['$SS_ID']);
console.log(JSON.stringify(r.rows[0] || {}));
await closePool();
" > "$NODE_OUT" 2>/dev/null

LAA=$(python3 -c "import json;print(json.load(open('$NODE_OUT')).get('last_alerted_at') or '')" 2>/dev/null)
LMV=$(python3 -c "import json;print(json.load(open('$NODE_OUT')).get('last_match_value') or '')" 2>/dev/null)
echo "  last_alerted_at: $LAA"
echo "  last_match_value: $LMV"
[ -n "$LAA" ] && ok "last_alerted_at populated" || bad "last_alerted_at is still NULL"
[ -n "$LMV" ] && ok "last_match_value populated" || bad "last_match_value is still NULL"

# --- 6. ConsoleMailer wrote the email file --------------------------------
hr "6. ConsoleMailer wrote alert email"
if [ -f "$LAST_EMAIL" ]; then
  ok "$LAST_EMAIL exists"
  if grep -q "Eval smoke" "$LAST_EMAIL"; then
    ok "email subject/body mentions our saved search"
  else
    bad "email file exists but doesn't mention 'Eval smoke'"
    head -20 "$LAST_EMAIL" | sed 's/^/    | /'
  fi
else
  # In production with Resend the file won't exist — that's fine, the
  # SQL breadcrumb is the source of truth. But in dev this should fire.
  skip "$LAST_EMAIL not present (Resend prod path?)"
fi

# --- 7. second invocation: cooling-off blocks re-fire ---------------------
hr "7. second invocation — cooling-off"
LAA_BEFORE="$LAA"
LOG_LEVEL=silent node --input-type=module -e "
import { evaluateAllSavedSearches } from './src/services/savedsearch-evaluator.js';
import { closePool } from './src/db/pool.js';
const out = await evaluateAllSavedSearches({ baseUrl: '$BASE' });
console.log(JSON.stringify(out));
await closePool();
" > "$NODE_OUT" 2>/dev/null

EVAL2=$(python3 -c "import json;d=json.load(open('$NODE_OUT'));print(d.get('evaluated',0))" 2>/dev/null || echo 0)
FIRED2=$(python3 -c "import json;d=json.load(open('$NODE_OUT'));print(d.get('fired',0))" 2>/dev/null || echo 0)

echo "  second evaluator returned: evaluated=$EVAL2 fired=$FIRED2"
[ "$EVAL2" = "0" ] && ok "second run: evaluated == 0 (filtered out by cooling-off)" \
                  || bad "second run: evaluated was $EVAL2 (expected 0)"
[ "$FIRED2" = "0" ] && ok "second run: fired == 0" || bad "second run: fired was $FIRED2"

# Confirm last_alerted_at didn't move forward (it was filtered out, so
# the row never went through findMatches/recordAlert again).
LOG_LEVEL=silent node --input-type=module -e "
import { query, closePool } from './src/db/pool.js';
const r = await query('SELECT last_alerted_at FROM saved_searches WHERE id = \$1', ['$SS_ID']);
console.log(JSON.stringify(r.rows[0] || {}));
await closePool();
" > "$NODE_OUT" 2>/dev/null

LAA_AFTER=$(python3 -c "import json;print(json.load(open('$NODE_OUT')).get('last_alerted_at') or '')" 2>/dev/null)
[ "$LAA_BEFORE" = "$LAA_AFTER" ] && ok "last_alerted_at unchanged" \
                                 || bad "last_alerted_at moved: '$LAA_BEFORE' -> '$LAA_AFTER'"

# --- 8. teardown ----------------------------------------------------------
hr "8. teardown"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' -b "$JAR" \
  -X DELETE "$BASE/api/saved-searches/$SS_ID")
code_eq 200 "$CODE" "delete saved_search row"

# --- summary --------------------------------------------------------------
hr "Summary"
echo "Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
[ "$FAIL" = "0" ] && exit 0 || exit 1
