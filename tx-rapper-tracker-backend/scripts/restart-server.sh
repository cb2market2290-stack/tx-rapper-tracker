#!/usr/bin/env bash
# Helper: kill whatever is listening on :8787 and relaunch the server
# in the background. Logs go to /tmp/server.log. Prints the new PID.
#
# Usage: bash scripts/restart-server.sh

set -u

PORT=8787
cd "$(dirname "$0")/.."

PIDS="$(lsof -iTCP:${PORT} -sTCP:LISTEN -n 2>/dev/null | awk 'NR>1 {print $2}' | sort -u | tr '\n' ' ')"
if [ -n "${PIDS// }" ]; then
  echo "killing PIDs on :${PORT}: ${PIDS}"
  kill -TERM ${PIDS} 2>/dev/null || true
  sleep 2
  kill -9    ${PIDS} 2>/dev/null || true
fi

nohup node src/index.js > /tmp/server.log 2>&1 &
NEW_PID=$!
disown || true
sleep 2
echo "new pid: ${NEW_PID}"
lsof -iTCP:${PORT} -sTCP:LISTEN -n 2>/dev/null || echo "WARN: nothing listening on :${PORT}"
