#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled Phase 3d.3c.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3d3c.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3d3c.sh

git commit -m "Phase 3d.3c docs: log-obsidian-phase-3d3c.py — Build Log row + 2 errors

Per the standing rule.

  build-log: +1 row (frontend bundle for digest + referral)
  error-log: +2 rows
    * onboardingCard initial placement was at body-level adjacent to
      modals; moved to inline inside .container above movers strip
      because hint cards live in document flow, not modal overlays
    * captureReferralFromUrl runs FIRST in window.onload — before
      checkSession — so the cookie is set before any signup attempt;
      wrapped in try/catch so a malformed token never breaks page load

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
