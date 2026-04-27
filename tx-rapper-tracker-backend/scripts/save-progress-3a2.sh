#!/usr/bin/env bash
# scripts/save-progress-3a2.sh
# One-shot stage + commit for Phase 3a.2 (saved searches CRUD + tier
# caps). Backend-only — the saved-searches UI lands with the email
# evaluator in 3a.3 so users can create + receive alerts in one push.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/014_saved_searches.sql \
  tx-rapper-tracker-backend/src/services/savedsearches.js \
  tx-rapper-tracker-backend/src/routes/saved-searches.js \
  tx-rapper-tracker-backend/src/index.js \
  tx-rapper-tracker-backend/test/savedsearches.test.js \
  tx-rapper-tracker-backend/scripts/test-saved-searches.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3a2.sh

git commit -m "Phase 3a.2: saved searches CRUD + tier caps (Free 1 / Pro 5 / Premium ∞)

Backend foundation for the per-user alert system. Phase 3a.3 reuses
this storage as the input to the email evaluator; the saved-searches
UI ships alongside 3a.3 so create + receive land together.

Backend:
* migrations/014_saved_searches.sql — saved_searches table (user_id
  CASCADE, artist_id SET NULL so archiving an artist unscopes a
  search rather than nuking it). Three indices: (user_id) for cap
  counting, partial (enabled, user_id) WHERE enabled for the
  evaluator hot path, (user_id, id) for owner-scoped lookups. Plus
  a touch_updated_at trigger and CHECKs on metric/comparator/name
  bounds. Tier caps live in JS, not the DB — changing them is a
  deploy not a migration.
* src/services/savedsearches.js — TIER_CAPS (free:1, pro:5, paid:5,
  premium:null), capForPlanSlug fails CLOSED on unknown slugs.
  ValidationError + TierCapError typed for clean route mapping.
  normalizeCreatePayload validates name 1–80, metric/comparator
  enums, threshold finiteness + per-metric range (pct_growth_7d
  bounded -1…100 catches unit confusion; lifetime_views >= 0;
  view_growth_7d / acceleration_7d unbounded so 'cooling-off'
  alerts work). normalizeUpdatePayload allows any non-empty subset
  and re-range-checks threshold against the new metric when metric
  is being patched. shapeRow snake→camel + node-pg BIGINT-as-string
  / 't'-as-bool tolerance. listForUser / countForUser /
  getByIdForUser / create (cap-checked) / update / remove (all
  owner-scoped).
* src/routes/saved-searches.js — GET /, GET /:id, POST /, PATCH /:id,
  DELETE /:id. All owner-scoped. POST returns 201 + shaped row;
  cap-exceeded → 403 with kind:'savedsearches.tier_cap' and
  planSlug/cap/count/upgrade payload the frontend can render into
  an upgrade nudge. Foreign UUID and non-UUID id both return 404
  (no leaking other-user existence). PATCH on bad payload → 400
  bad_request via ValidationError → HttpError mapper.
* src/index.js — mounts /api/saved-searches behind requireUser().
* test/savedsearches.test.js — 30 unit tests covering all of:
  TIER_CAPS / capForPlanSlug / isOverCap, normalizeCreatePayload
  (every required field, every range check, every error path,
  string-numeric threshold coercion, artistId UUID/null/empty
  handling, enabled coercion), normalizeUpdatePayload (single-field
  patches, empty-patch rejection, all enum / threshold rejections),
  shapeRow (BIGINT-as-string, 't' boolean), TierCapError shape.
* scripts/test-saved-searches.sh — 12-section live smoke: anonymous
  401 sweep, signup → empty list with tier context, create returns
  201, second create at free cap → 403 tier_cap, PATCH enabled,
  bad-payload PATCH → 400, foreign-UUID GET → 404, non-UUID id →
  400, owner isolation (user B can't list/get/patch/delete user A's
  rows), DELETE → list empty → second DELETE → 404.

Tests: 180/185 unit (5 pre-existing cache.test.js failures, all
DB-connection-required, unchanged from prior runs). +30 new.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
