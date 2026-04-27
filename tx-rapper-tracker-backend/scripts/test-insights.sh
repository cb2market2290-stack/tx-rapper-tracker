#!/usr/bin/env bash
# Phase 3a.1 — /api/insights/breakout endpoint smoke test.
#
# Hits GET /api/insights/breakout to verify:
#   1. Anonymous access works (this is a public funnel-hook endpoint)
#   2. Default response shape: {kind:'insights.breakout', sortBy, limit, rows}
#   3. limit is honored (smaller cap → fewer rows)
#   4. limit out-of-bounds (0, 51, 'lots') → 400 bad_request
#   5. sortBy=growth|percentage|acceleration each return 200
#   6. sortBy=nope → 400 bad_request
#   7. includePartial=true|false both return 200
#   8. Each returned row has the documented camelCase shape:
#      artistId, artistName, asOf, viewsNow, views7dAgo, views14dAgo,
#      viewGrowth7d, pctGrowth7d, acceleration7d, hasFullWindow, computedAt
#
# Prereqs:
#   * Backend running on :8787 (npm start).
#   * Migration 013 applied (CREATE MATERIALIZED VIEW breakout_signals).
#   * artist_stats_daily has at least one row (otherwise the matview is
#     empty and rows is []; the shape checks then short-circuit).
#
# Run: bash scripts/test-insights.sh

set -u

BASE="${BASE:-http://localhost:8787}"
RESP=/tmp/tx-insights.json
PASS=0
FAIL=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
hr()  { printf '\n===== %s =====\n' "$*"; }

code_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$got" = "$want" ]; then ok "$name (HTTP $got)"; else bad "$name: expected $want, got $got"; fi
}

# Tiny python helpers — same pattern as test-features.sh.
json_get()    { python3 -c "import json;print(json.load(open('$RESP')).get('$1',''))" 2>/dev/null; }
json_rows_count() {
  python3 -c "
import json
d = json.load(open('$RESP'))
print(len(d.get('rows') or []))
" 2>/dev/null
}
json_first_row_has_field() {
  python3 -c "
import json,sys
d = json.load(open('$RESP'))
rows = d.get('rows') or []
if not rows:
    sys.exit(2)
sys.exit(0 if '$1' in rows[0] else 1)
" 2>/dev/null
}

# --- 1. anonymous /api/insights/breakout -> 200 ------------------------------
hr "1. anonymous breakout"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout")
code_eq 200 "$CODE" "anonymous breakout request"

KIND=$(json_get kind)
if [ "$KIND" = "insights.breakout" ]; then ok "kind == insights.breakout"; else bad "kind was '$KIND'"; fi

LIMIT=$(json_get limit)
if [ "$LIMIT" = "5" ]; then ok "default limit == 5"; else bad "default limit was '$LIMIT'"; fi

SORT=$(json_get sortBy)
if [ "$SORT" = "growth" ]; then ok "default sortBy == growth"; else bad "default sortBy was '$SORT'"; fi

ROW_COUNT=$(json_rows_count)
if [[ "$ROW_COUNT" =~ ^[0-9]+$ ]]; then
  ok "rows is an array (length $ROW_COUNT)"
else
  bad "rows count is not numeric: '$ROW_COUNT'"
fi

# --- 2. limit honored ---------------------------------------------------------
hr "2. limit honored"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout?limit=2")
code_eq 200 "$CODE" "limit=2"
LEN=$(json_rows_count)
if [ "$LEN" -le 2 ]; then ok "rows length $LEN <= requested limit 2"; else bad "rows length $LEN > 2"; fi

# --- 3. limit out of bounds -> 400 -------------------------------------------
hr "3. limit out of bounds"
for BAD in 0 51 lots; do
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout?limit=$BAD")
  code_eq 400 "$CODE" "limit=$BAD rejected"
  ERR=$(json_get error)
  if [ "$ERR" = "bad_request" ]; then ok "  error == bad_request"; else bad "  error was '$ERR'"; fi
done

# --- 4. each sortBy mode returns 200 -----------------------------------------
hr "4. sortBy modes"
for SORT in growth percentage acceleration; do
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout?sortBy=$SORT")
  code_eq 200 "$CODE" "sortBy=$SORT"
  ECHOED=$(json_get sortBy)
  if [ "$ECHOED" = "$SORT" ]; then ok "  sortBy echoed back as '$SORT'"; else bad "  sortBy was '$ECHOED'"; fi
done

# --- 5. unknown sortBy -> 400 ------------------------------------------------
hr "5. unknown sortBy"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout?sortBy=velocity")
code_eq 400 "$CODE" "sortBy=velocity rejected"
ERR=$(json_get error)
if [ "$ERR" = "bad_request" ]; then ok "error == bad_request"; else bad "error was '$ERR'"; fi

# --- 6. includePartial flag works -------------------------------------------
hr "6. includePartial"
for FLAG in true false; do
  CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout?includePartial=$FLAG")
  code_eq 200 "$CODE" "includePartial=$FLAG"
done

# --- 7. row shape (only if there's at least one row) ------------------------
hr "7. row shape"
CODE=$(curl -sS -o "$RESP" -w '%{http_code}' "$BASE/api/insights/breakout?limit=1&includePartial=true")
code_eq 200 "$CODE" "fetch one row for shape check"
LEN=$(json_rows_count)
if [ "$LEN" = "0" ]; then
  ok "no rows yet (matview is empty — skipping per-field shape checks)"
else
  for FIELD in artistId artistName asOf viewsNow views7dAgo views14dAgo \
               viewGrowth7d pctGrowth7d acceleration7d hasFullWindow computedAt; do
    if json_first_row_has_field "$FIELD"; then
      ok "  row has $FIELD"
    else
      bad "  row missing $FIELD"
    fi
  done
fi

# --- summary -----------------------------------------------------------------
hr "Summary"
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
