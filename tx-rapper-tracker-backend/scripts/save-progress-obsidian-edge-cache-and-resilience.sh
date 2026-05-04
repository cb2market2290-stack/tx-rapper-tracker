#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled the edge-cache +
# power-resilience commit (60ba140).
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-edge-cache-and-resilience.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-edge-cache-and-resilience.sh

git commit -m "Edge-cache + resilience docs: log-obsidian backfill

Per the standing rule. Build Log row covers the edge-cache headers +
POWER_RESILIENCE.md as one combined commit. Error Log row records
the heredoc nested-double-quote pitfall recurrence (pattern was
already documented but slipped through).

Run history:
  python3 scripts/log-obsidian-edge-cache-and-resilience.py
  -> build-log: +1 row(s)
  -> error-log: +1 row(s)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
