#!/usr/bin/env bash
# Stage + commit Phase 3.5.3 — snapshot + cron failure alerting via the
# existing Phase 2b mailer. Closes the silent-failure gaps (stale data,
# matview refresh failure, evaluator failure) that alertOnFailure
# wasn't covering.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/snapshot-stats.js \
  tx-rapper-tracker-backend/scripts/save-progress-3-5-3.sh

git commit -m "Phase 3.5.3: cron failure alerting — stale data + aux failures

The existing alertOnFailure() covered the path where the snapshot
run itself failed. Three silent-failure modes were still escaping
notice and just wrote logger.warn lines that nobody reads:

  1. The run reports status=ok but the most-recent
     artist_stats_daily.captured_on is > 36h old. (Two cron passes
     both no-op'd; YouTube API quota exhausted across both retries;
     a roster mismatch where every artist returned no search results.)
     Dashboard reads stale data; nobody notices until the freshness
     badge starts visibly aging.

  2. breakout_signals matview refresh fails. Saved-search alerts +
     the dashboard movers strip are now reading yesterday's deltas
     for the rest of the day. Users won't notice until they hit the
     page, by which point the trend window they cared about has
     shifted.

  3. saved-search evaluator fails. Saved-search alerts are a paid
     feature; silent failure means a Pro/Premium user paid for
     something that didn't fire.

* scripts/snapshot-stats.js — three additions:

  - sendAdminAlert({subject, lines}) generic helper. One email per
    recipient with a tiny try/catch wrapper so an SMTP blip never
    tanks the snapshot run itself. The DB breadcrumb (snapshot_runs
    row) already captured the work; this is best-effort notification
    on top.

  - alertOnStaleSnapshots(startedAt) called after the run when
    status === 'ok'. Queries MAX(captured_on) + age_hours via
    EXTRACT(EPOCH FROM (now() - MAX)). When age > 36h, fires
    sendAdminAlert with a body that explains the likely causes
    (YouTube auth/quota, roster mismatch). Skips when there are
    zero snapshots ever — first-run state shouldn't false-alarm.

  - The breakout_signals refresh + savedsearch evaluator try/catch
    blocks now also call sendAdminAlert on error (still wrapped in
    try/catch around the email send so a mailer failure doesn't
    cascade). logger.warn lines retained for log-aggregation
    ingestion.

Wiring (no behavior change for the success path):
  main() ->  snapshot work -> recordRun -> matview refresh
       -> savedsearch evaluator -> alertOnFailure (existing,
       fires when status is not ok) -> alertOnStaleSnapshots (new,
       fires when status=ok but data is > 36h old) -> pruneOld.

  Best-effort alerting throughout — none of these can throw out
  of main(); if anything in the alert path blows up the script
  still exits cleanly with the original status.

Verification:
  - node --check scripts/snapshot-stats.js → OK.
  - All 45 unit tests still pass.
  - Live verify (deferred to user): force a stale state by
    pausing the cron for 2 days, re-run, expect a stale-data
    email to land.

Rollback: revert this commit. The three new alert paths each
add code; removing them puts behavior back to where it was.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
