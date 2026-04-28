#!/usr/bin/env bash
# scripts/save-progress-obsidian-phase-3.sh
# Stage + commit the Obsidian logger script that backfilled the Phase 3
# Build Log + Error Log rows. The vault file itself lives outside the
# repo (under ~/Documents/Obsidian Vault/) so we don't commit it; what
# we commit is the idempotent script that produced the rows, so the
# work is reproducible from the repo alone.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/log-obsidian-phase-3.py \
  tx-rapper-tracker-backend/scripts/save-progress-obsidian-phase-3.sh

git commit -m "Phase 3 docs: log-obsidian-phase-3.py — Build Log backfill for 3a + 3b

The Obsidian Build Log was current through Phase 2e + the Phase 3
brainstorm doc, but the entire Phase 3a chain (3a.1-3a.5) and Phase
3b chain (3b.1-3b.5) shipped without a corresponding Build Log
update. This commit adds the idempotent logger that backfills them
in one pass.

* scripts/log-obsidian-phase-3.py
  Same shape as scripts/log-obsidian-phase-2e.py: a Python script
  with BUILD_ROWS + ERROR_ROWS literals, an ensure_row() helper that
  inserts each row under its section header only if not already
  present (exact-line match), and a dedupe pass that collapses any
  duplicate today-rows from prior reruns. Safe to re-run.

  10 BUILD_ROWS land in this pass:
    Phase 3a.1 — breakout signals + dashboard movers strip
    Phase 3a.2 — saved searches CRUD + tier caps
    Phase 3a.3 — email alerts evaluator + mailer
    Phase 3a.4 — Phase 3a live-verify + migration-013 fix
    Phase 3a.5 — saved-searches frontend (alerts modal)
    Phase 3b.1 — design + Claude prompt lock-in
    Phase 3b.2 — artist_briefs cache table
    Phase 3b.3 — services/briefs.js + 29 unit tests
    Phase 3b.4 — GET /api/artists/:id/brief + Premium gate
    Phase 3b.5 — artist detail page brief surface + smoke

  7 ERROR_ROWS for the genuinely-noteworthy issues:
    * migration 013 date-arithmetic bug (date - date is INTEGER days,
      not INTERVAL — only fired on populated DBs which is why hermetic
      unit tests didn't catch it)
    * pino-on-stdout polluting the smoke parser (LOG_LEVEL=silent fix)
    * artistName resolution choice (frontend cache vs backend JOIN)
    * latest_snapshot_id → latest_snapshot_at correction in 3b design
      (artist_stats_daily has no surrogate id)
    * @anthropic-ai/sdk dynamic-import posture (matches optional
      stripe package)
    * osascript shell quirk running npm test from non-login shell
    * 25s timeout placement at route layer not service layer
      (AbortSignal threads from route into callClaude so we cancel
      the in-flight request when we 504)

  Date used for every row: 2026-04-28 (the date the backfill ran;
  one block per major phase, like 2e did).

* scripts/save-progress-obsidian-phase-3.sh
  This commit script. The vault file itself (~/Documents/Obsidian
  Vault/tx-rapper-tracker.md) lives outside the repo so we don't
  commit it; what we commit is the idempotent script that produced
  the rows, so the Build Log work is reproducible from the repo
  alone.

Run history:
  python3 scripts/log-obsidian-phase-3.py
  → build-log: +10 row(s)
  → error-log: +7 row(s)
  → duplicates removed: 0

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
