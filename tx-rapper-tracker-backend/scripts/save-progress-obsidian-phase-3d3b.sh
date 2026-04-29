#!/usr/bin/env bash
# Stage + commit the Obsidian logger that backfilled Phase 3d.3b.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3d3b.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3d3b.sh

git commit -m "Phase 3d.3b docs: log-obsidian-phase-3d3b.py — Build Log row + 1 error

Per the standing rule (every completed task gets a fresh Obsidian
backfill).

  build-log: +1 row (referral routes + signup wiring + webhook hook,
             mirroring the commit message)
  error-log: +1 row (anti-fraud IP guard cannot run inside the Stripe
             webhook because the source IP is Stripe-s — design
             decision to wire it at signup time instead, where req.ip
             is the real client IP)

Run history:
  python3 scripts/log-obsidian-phase-3d3b.py
  -> build-log: +1 row(s)
  -> error-log: +1 row(s)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
