#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled Phase 3d.3a.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3d3a.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3d3a.sh

git commit -m "Phase 3d.3a docs: log-obsidian-phase-3d3a.py — Build Log row + 2 errors

Per the standing rule (every completed task gets a fresh Obsidian
backfill).

  build-log: +1 row (referral schema + service + 11 unit tests,
             mirroring the commit message)
  error-log: +2 rows (users.last_signup_ip column did not exist —
             swapped to audit_log query; commit-message dollar-sign
             expansion footgun caught and codified)

Run history:
  python3 scripts/log-obsidian-phase-3d3a.py
  -> build-log: +1 row(s)
  -> error-log: +2 row(s)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
