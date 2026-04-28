#!/usr/bin/env bash
# scripts/save-progress-3b2.sh
# One-shot stage + commit for Phase 3b.2 — the artist_briefs cache
# table that backs the AI brief feature. Schema-only commit; the
# service module (3b.3) and route (3b.4) wire it up.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref. Run `npm run migrate`
# against the live DB to apply.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/015_artist_briefs.sql \
  tx-rapper-tracker-backend/PHASE_3B_DESIGN.md \
  tx-rapper-tracker-backend/scripts/save-progress-3b2.sh

git commit -m "Phase 3b.2: artist_briefs cache table for AI brief generation

Adds the cache table that the 3b.3 service module reads from + writes
to. Schema-only commit; nothing reads the table yet.

* migrations/015_artist_briefs.sql

  Single table with a UNIQUE (artist_id, fingerprint) constraint that
  doubles as the cache-key lookup index. Stores the brief, the model
  + prompt_version that produced it, billing telemetry (tokens_in /
  tokens_out, both nullable so old rows from before we tracked
  tokens stay valid), and generated_at.

  fingerprint is sha256-hex (CHECK length=64) of canonicalized
  key_inputs JSON: { artist_id, latest_snapshot_at,
  latest_features_extracted_at, prompt_version, model }. The
  service module owns canonicalization + hashing; the DB just
  stores the result.

  artist_id has ON DELETE CASCADE so archiving an artist drops
  their cached briefs cleanly. brief is CHECK length>0 so a
  corrupted-write doesn't park an empty paragraph in the cache —
  the service module does word-count shaping before insert anyway,
  but defense in depth.

  Also adds an artist_briefs_artist_recent_idx (artist_id,
  generated_at DESC) for the rare 'show me the latest brief I have
  for this artist regardless of cache key' admin / debug query.
  One small btree on a small table — cheap.

* PHASE_3B_DESIGN.md
  Two corrections after reading the actual schema:

  - latest_snapshot_at is a DATE (MAX(captured_on) from
    artist_stats_daily), not a bigint id — the snapshots table is
    keyed (artist_name, captured_on) with no surrogate id. Same
    semantic role in the cache key, just a different column name.

  - The 'Cache table' section now points at the migration as the
    canonical schema rather than reproducing the SQL inline; the
    migration's comments are richer than the doc was.

No live verify in this commit — the migration runs against an empty
table (no existing data to break) and is a pure CREATE. We'll apply
+ verify as part of the 3b.3 / 3b.4 integration work.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
