#!/usr/bin/env bash
# scripts/save-progress-3a4.sh
# One-shot stage + commit for Phase 3a.4 — the live-verify pass that
# closes out Phase 3a (breakout signals + saved searches + email
# alerts evaluator).
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/013_breakout_signals.sql \
  tx-rapper-tracker-backend/scripts/test-saved-search-eval.sh \
  tx-rapper-tracker-backend/scripts/quick-movers-check.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3a4.sh

git commit -m "Phase 3a.4: live-verify fixes — 013 has_full_window operator + smoke pino noise

Two fixes uncovered while live-verifying Phase 3a end-to-end against
real Postgres + the in-process backend, plus a tiny inspection helper.

* migrations/013_breakout_signals.sql — has_full_window was computed
  with '(as_of - first_snapshot) >= INTERVAL \'14 days\''. Both
  columns are DATE, and date - date in Postgres yields integer days,
  not interval, so applying the migration on a populated DB errored:

    operator does not exist: integer >= interval

  The fix compares against the integer literal 14 instead. Behavior
  is unchanged when the migration runs on an empty DB (no snapshots
  yet, the points CTE has zero rows so the offending expression is
  never evaluated) — which is why our 3a.1 unit tests didn't catch
  it. Verified by re-running 'npm run migrate' and confirming 013 +
  014 both apply, then querying the matview to see 6 expected rows
  (one per active artist).

* scripts/test-saved-search-eval.sh — the four inline 'node -e'
  bridges that the smoke uses to invoke the evaluator and inspect
  saved_searches were emitting pino logs to stdout interleaved with
  the JSON.stringify of the orchestrator return. python3's
  json.load(file) reads only the first JSON document, which was a
  pino log, so 'evaluated' / 'fired' came back as 0 even when the
  alert fired correctly (last_alerted_at WAS being written and the
  ConsoleMailer WAS writing /tmp/last-reset-email.txt). Prefixing
  each bridge with LOG_LEVEL=silent silences pino so stdout contains
  only the JSON we want to parse. After the fix the smoke runs
  14/14 PASS — confirming evaluated=1, fired=1, errors=0,
  last_alerted_at populated, email written, and the second
  invocation correctly filtered out by the 24h cooling-off cap.

* scripts/quick-movers-check.sh — one-shot inspector that signs up
  a user and hits /api/insights/breakout with the three valid
  sortBy values (growth / percentage / acceleration), printing the
  JSON for visual inspection. Used during the verify pass to
  confirm the matview-backed read endpoint serves real data after
  a snapshot run. Not part of the test suite — just a quick way to
  eyeball the dashboard movers strip backend.

Live-verify summary (Phase 3a end-to-end):
  * Migrations 013 + 014 applied to live DB.
  * Backend restarted with new code (PID 19683).
  * test-saved-searches.sh:        41/41 PASS — CRUD + tier caps +
                                    owner isolation.
  * test-saved-search-eval.sh:     14/14 PASS — evaluator fires,
                                    last_alerted_at populated,
                                    email file written, second
                                    invocation cooled off.
  * /api/insights/breakout:        returns live matview data
                                    (Megan 39M, GloRilla 19M,
                                    KenTheMan 2.2M with
                                    includePartial=true; defaults
                                    to has_full_window-only which
                                    is empty until day 14).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
