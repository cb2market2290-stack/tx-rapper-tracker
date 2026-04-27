#!/usr/bin/env bash
# scripts/quick-movers-check.sh
# Quick smoke against /api/insights/breakout for the dashboard movers
# strip. Used during the Phase 3a live-verify pass to confirm the
# matview-backed read endpoint serves real data after a snapshot run.
# Not part of the test suite — just a one-shot inspector.

set -u
BASE="${BASE:-http://localhost:8787}"
JAR=/tmp/tx-mvr-jar.txt
RAND=$RANDOM
EMAIL="mvr-$RAND@example.com"
PW='correct-horse-battery-staple-42'
rm -f "$JAR"
for _ in 1 2 3 4 5; do
  CODE=$(curl -sS -o /tmp/mvr.json -w '%{http_code}' -c "$JAR" -b "$JAR" \
    -X POST -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" \
    "$BASE/api/auth/signup")
  [ "$CODE" != "429" ] && break
  sleep 6
done
echo "signup=$CODE"
echo '---movers (growth)---'
curl -sS -b "$JAR" "$BASE/api/insights/breakout?limit=3&sortBy=growth" | python3 -m json.tool
echo '---movers (pct)---'
curl -sS -b "$JAR" "$BASE/api/insights/breakout?limit=3&sortBy=pct" | python3 -m json.tool
echo '---movers (acceleration)---'
curl -sS -b "$JAR" "$BASE/api/insights/breakout?limit=3&sortBy=acceleration" | python3 -m json.tool
