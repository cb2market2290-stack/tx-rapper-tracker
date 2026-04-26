#!/usr/bin/env bash
# Run the full node --test suite. Tolerates failures so the caller gets
# the output back via the log file even when tests fail.
set +e
cd "$(dirname "$0")/.."
/usr/local/bin/node --test test/*.test.js > /tmp/tx-test.log 2>&1
echo "EXIT=$?"
tail -20 /tmp/tx-test.log
