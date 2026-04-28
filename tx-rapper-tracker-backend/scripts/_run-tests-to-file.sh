#!/usr/bin/env bash
# osascript-friendly wrapper: runs the test runner and dumps the
# output to .last-test-run.txt. Hard-bounded at 60s so osascript's
# internal timeout never trips. Always exits 0.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
( "$HERE/_run-tests-tail.sh" ) > "$HERE/../.last-test-run.txt" 2>&1 &
PID=$!
SECS=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 1
  SECS=$((SECS+1))
  if [ "$SECS" -ge 60 ]; then
    kill -9 "$PID" 2>/dev/null || true
    echo "(timeout after 60s)" >> "$HERE/../.last-test-run.txt"
    break
  fi
done
exit 0
