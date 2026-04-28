#!/usr/bin/env bash
# scripts/save-progress-3c3.sh
# Stage + commit Phase 3c.3 — services/slugs.js + routes/public.js +
# 16 unit tests. After this commit the public surface is reachable
# through the backend; 3c.4 adds frontend Share buttons in app.html
# and 3c.5 adds the curl smoke + live verify.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/services/slugs.js \
  tx-rapper-tracker-backend/src/routes/public.js \
  tx-rapper-tracker-backend/src/index.js \
  tx-rapper-tracker-backend/test/slugs.test.js \
  tx-rapper-tracker-backend/scripts/save-progress-3c3.sh

git commit -m "Phase 3c.3: services/slugs.js + routes/public.js + 16 unit tests

The backend half of Phase 3c. After this commit the public surface
is reachable from curl — anonymous, server-rendered, indexable.
3c.4 adds the frontend Share buttons; 3c.5 adds the live smoke.

* src/services/slugs.js (new)
  Pure: slugify(name) — locked v1 rules from PHASE_3C_DESIGN.md.
  NFKD-fold → strip combining marks → lowercase → '&'→' and ' →
  drop everything outside [a-z 0-9 whitespace -] → whitespace-to-
  hyphen → collapse hyphen runs → trim. Drops underscores to match
  migration 016's Postgres-side backfill exactly.

  isValidSlug(s) — alphanumeric + hyphens, 1-100 chars, must start
  alnum. Cheap reject before DB lookup.

  DB-touching:
  - getPublicArtistBySlug(slug) — filters is_public=TRUE AND NOT
    is_archived; returns null on miss (route 404s).
  - getPublicArtistsBySlugs(slugs) — same filter; preserves input
    order via Map<slug, row> sort so /compare/<a>+<b>+<c> keeps
    the user's left-to-right ordering. Silently drops unknowns
    (same posture as the in-app compare's unknown-name handling).
  - getPublicArtistRoster() — every is_public + non-archived row
    sorted by slug (deterministic sitemap output).

* src/routes/public.js (new, ~430 lines)
  Mounted in src/index.js BEFORE the /api/* gates and BEFORE the
  static-frontend handler so /a/:slug + /compare/:slugs win route
  matching. Anonymous-OK; the rate limiter (already mounted at
  app level) covers anon abuse.

  Server-renders pure HTML via template literals. No template
  engine. escapeHtml on every interpolation point (defense in
  depth — slug + slugs are already validated, but compare-route
  user names come from the DB so they get escaped too). Inline
  CSS in the page <style> for offline-friendliness; no external
  fonts; pages render with JS disabled.

  Routes:
  - GET /a/:slug → 200 text/html (artist + 365-day snapshot table
    + headline lifetime/subs/7-day-growth + 'Sign up free' CTA top
    + bottom + JSON island for client-side hydration); 404 on
    unknown / private / archived slug.
  - GET /compare/:slugs → 200 text/html with N adjacent stat
    cards (max 5; 400 with kind:'compare.too_many' over the cap;
    404 if zero recognized slugs).
  - GET /robots.txt → 200 text/plain. Allow /a/, /compare/.
    Disallow /admin, /api/, /reset.
  - GET /sitemap.xml → 200 application/xml. One <url> per
    is_public + non-archived artist; <changefreq>daily.

  computeHeadline(snapshots) is exported pure for tests; walks
  back through the snapshot history to find the most-recent
  entry ≤ 7 days old (handles sparse history gracefully when the
  exact-7-day-prior datapoint is missing).

  originFor(req) honors X-Forwarded-Proto + Host so the
  <link rel='canonical'> + Open Graph URLs match what Cloudflare
  actually serves.

* test/slugs.test.js (new, 16 tests, all passing)
  - slugify is deterministic (1).
  - slugify matches the seed-roster examples verbatim — Megan
    Thee Stallion, Tay Money, Asian Doll, Cuban Doll, KenTheMan,
    GloRilla (1 test, 6 assertions).
  - slugify ASCII-folds Latin diacritics — Beyoncé / Chlöe /
    Renée (1).
  - slugify expands & to ' and ' so meaning isn't lost — Chloe &
    Halle / Salt & Pepa (1).
  - slugify drops quotes / parens / dots / slashes — D'Angelo,
    Megan (Thee Stallion), Big.K.R.I.T., AC/DC (1).
  - slugify collapses whitespace + hyphen runs + trims edges (1).
  - slugify drops underscores (matches Postgres backfill — these
    MUST stay in lockstep) (1).
  - slugify returns '' for non-string / empty / whitespace-only /
    all-symbol input (2).
  - isValidSlug accepts realistic slugs (1).
  - isValidSlug rejects non-string / empty / leading-hyphen / bad
    chars / 100-char cap (1).
  - computeHeadline: empty / single-row / 14-day-grow / sparse-
    history (4).
  - COMPARE_MAX matches the frontend cap of 5 (1).

  16/16 PASS. Pre-existing breakout/savedsearches/savedsearch-
  evaluator/auth/features/stripe/briefs still PASS.

Wiring (src/index.js):
  app.use('/', publicRoutes) is mounted AFTER /api/* and BEFORE
  the static-frontend sendFile routes for / and /reset. The Express
  route table picks /a/:slug + /compare/:slugs + /robots.txt +
  /sitemap.xml from publicRoutes; everything else falls through
  to the SPA, exactly like before.

Live verify deferred to 3c.5:
  npm run migrate    # applies 016
  curl /a/megan-thee-stallion          # → 200 text/html
  curl /a/this-doesnt-exist            # → 404
  curl /compare/megan-thee-stallion+glorilla   # → 200
  curl /robots.txt                     # → 200
  curl /sitemap.xml                    # → 200

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
