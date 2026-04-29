#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled 3.5.2 / 3.5.3 /
# 3.5.4 / 3d.1.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3-5-and-3d1.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3-5-and-3d1.sh

git commit -m "Phase 3 docs: log-obsidian backfill for 3.5.2-3.5.4 + 3d.1

Picks up where log-obsidian-phase-3c.py left off. 4 Build Log rows
(3.5.2 CSP nonces, 3.5.3 cron alerting, 3.5.4 deep health, 3d.1
design doc) + 3 Error Log rows (heredoc nested-double-quote bug,
cspNonce ordering note, /api/health/deep DB-timeout choice).

Run history:
  python3 scripts/log-obsidian-phase-3-5-and-3d1.py
  -> build-log: +4 row(s)
  -> error-log: +3 row(s)

Going forward (per the user standing instruction): every completed
task gets its own Obsidian update + an explicit acknowledgment in
the summary.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
