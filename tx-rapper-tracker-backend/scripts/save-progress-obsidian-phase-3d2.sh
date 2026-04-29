#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled Phase 3d.2.
# Per the standing rule: every completed task gets its own logger
# committed alongside the work itself.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3d2.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3d2.sh

git commit -m "Phase 3d.2 docs: log-obsidian-phase-3d2.py — Build Log row + 2 errors

Per the standing rule (every completed task gets a fresh Obsidian
backfill), this commit records the 3d.2 work:

  build-log: +1 row (digest backend — migration + service + routes
             + cron + 22 unit tests, mirroring the commit message)
  error-log: +2 rows (writeAuditEvent import that did not exist —
             fixed by inlining the audit() helper pattern from
             routes/auth.js; users.tz column missing — fall back
             to DEFAULT_TZ until a future signup-flow change
             collects it)

Run history:
  python3 scripts/log-obsidian-phase-3d2.py
  -> build-log: +1 row(s)
  -> error-log: +2 row(s)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
