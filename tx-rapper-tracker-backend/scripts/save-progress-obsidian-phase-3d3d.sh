#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled Phase 3d.3d.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3d3d.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3d3d.sh

git commit -m "Phase 3d.3d docs: log-obsidian-phase-3d3d.py — Phase 3d close-out

Per the standing rule. Build Log row records the close-out (9-subtest
test-digest.sh + 9-subtest test-referrals.sh) and lists the seven
commits that make up Phase 3d (3d.1 design through 3d.3d smoke).

No Error Log entries — close-out commit had no notable issues.

Run history:
  python3 scripts/log-obsidian-phase-3d3d.py
  -> build-log: +1 row(s)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
