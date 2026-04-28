#!/usr/bin/env bash
# scripts/save-progress-3c2.sh
# Stage + commit Phase 3c.2 — migration 016 adding slug + is_public
# to the artists table. Schema-only commit; nothing reads the new
# columns yet. 3c.3 wires the public routes that query against them.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/016_artist_slugs.sql \
  tx-rapper-tracker-backend/scripts/save-progress-3c2.sh

git commit -m "Phase 3c.2: migration 016 — artists.slug + artists.is_public

Adds the two columns the Phase 3c public route + sitemap need.
Schema-only commit; the public routes (3c.3) and the slugify service
module (also 3c.3) implement against this.

* migrations/016_artist_slugs.sql

  artists.slug TEXT UNIQUE NOT NULL — URL identifier for /a/:slug
  and /compare/:slugs. Derivation rules locked at v1 in
  PHASE_3C_DESIGN.md (NFKD-fold → ASCII → lowercase → hyphenate).
  Postgres-side backfill mirrors the JS slugify for the diacritics
  on the actual roster via translate() + lower() + regexp_replace.
  No JS-side data migration needed; the SQL covers everything in
  the seed list.

  artists.is_public BOOLEAN NOT NULL DEFAULT TRUE — admin-flippable
  visibility flag. FALSE hides the artist from /a/:slug + the
  sitemap; signed-in users still see them on the dashboard. Default
  TRUE because the roster is curated (closes open question 3 from
  PHASE_3_BRAINSTORM.md — opt-in feels right).

  Backfill safety: any leftover empty-string slug (degenerate
  all-symbol name) falls back to the first 8 chars of the artist
  UUID so the UNIQUE constraint passes. Real collisions blow up
  the migration loudly, which is the desired outcome — admin
  disambiguates by editing one of the names rather than us
  silently picking a winner.

  Plus a partial index artists_public_slug_idx ON (slug)
  WHERE is_public AND NOT is_archived for the sitemap + public-list
  queries. Postgres auto-creates the unique-constraint index on
  slug separately.

Live verify (deferred to 3c.5):
  npm run migrate    # applies 016
  psql -c \"SELECT name, slug, is_public FROM artists ORDER BY name\"
                    # eyeballs the backfill produced reasonable slugs

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
