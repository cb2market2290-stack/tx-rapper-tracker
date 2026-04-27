#!/usr/bin/env bash
# scripts/save-progress-3a1.sh
# One-shot stage + commit for Phase 3a.1 (breakout signals + dashboard
# movers strip). Mirrors the save-progress-2d.sh / save-progress-2e.sh
# pattern: explicit-add to avoid accidentally committing sibling
# projects, .env, __pycache__, etc.
#
# Run from the repo root (the parent of tx-rapper-tracker-backend/).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

# Resolve the repo root from this script's location — running from osascript
# starts in a directory without a .git, so an unanchored
# `git rev-parse --show-toplevel` would fail.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/013_breakout_signals.sql \
  tx-rapper-tracker-backend/src/services/breakout.js \
  tx-rapper-tracker-backend/src/routes/insights.js \
  tx-rapper-tracker-backend/src/index.js \
  tx-rapper-tracker-backend/scripts/snapshot-stats.js \
  tx-rapper-tracker-backend/scripts/test-insights.sh \
  tx-rapper-tracker-backend/test/breakout.test.js \
  tx-rapper-tracker-backend/scripts/save-progress-3a1.sh \
  tx-rapper-tracker/app.html

git commit -m "Phase 3a.1: breakout signals + dashboard movers strip

Adds the 7-day movement-signal pipeline that powers the public 'Movers
this week' strip on the dashboard.

Backend:
* migrations/013_breakout_signals.sql — materialized view aggregating
  artist_stats_daily into per-artist views_now / views_7d_ago /
  views_14d_ago / view_growth_7d / pct_growth_7d / acceleration_7d /
  has_full_window. Unique index on artist_id (required for
  REFRESH ... CONCURRENTLY) plus three sort indices (growth, pct,
  acceleration), all WHERE has_full_window with NULLS LAST.
* src/services/breakout.js — refreshBreakoutSignals (CONCURRENTLY
  refresh wrapper), getTopMovers({limit, sortBy, includePartial}),
  getAllSignals(), shapeRow() snake→camel + BIGINT-as-string handling.
  VALID_SORTS = ['growth', 'percentage', 'acceleration'].
* src/routes/insights.js — GET /api/insights/breakout. Anonymous-OK on
  purpose: per PHASE_3_BRAINSTORM.md Track A, this is the public
  funnel hook so signed-out landing visitors see live data. Cost is
  bounded by the precomputed matview.
* src/index.js — mounts /api/insights without requireUser().
* scripts/snapshot-stats.js — calls refreshBreakoutSignals() after
  the snapshot upserts land, before pruneOld(). Wrapped in try/catch
  so a refresh failure logs and swallows rather than tanking the
  snapshot run.
* scripts/test-insights.sh — 8-section smoke (anonymous 200, default
  shape, limit honored, limit out-of-bounds → 400, all three sortBy
  modes, unknown sortBy → 400, includePartial flag, per-row shape).
* test/breakout.test.js — 18 unit tests covering shapeRow,
  getTopMovers input validation, BreakoutQuery zod schema. All pass
  offline (no DB hits).

Frontend:
* tx-rapper-tracker/app.html — 'Movers this week' strip between the
  status bar and metrics row. Three sort tabs (growth / percentage /
  acceleration) flip the underlying API sortBy. Cards render rank,
  artist name, primary delta + sub-line, and drill into the artist
  detail view on click. Empty-state message when the matview hasn't
  filled out yet.

Tests: 150/155 unit (5 pre-existing cache.test.js failures, all
DB-connection-required, unchanged from prior runs).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
