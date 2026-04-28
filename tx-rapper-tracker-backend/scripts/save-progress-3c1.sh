#!/usr/bin/env bash
# scripts/save-progress-3c1.sh
# Stage + commit Phase 3c.1 — the design + decisions doc for public
# profile pages and shareable compare links. No code changes; 3c.2-3c.5
# implement against the spec in this commit.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/PHASE_3C_DESIGN.md \
  tx-rapper-tracker-backend/scripts/save-progress-3c1.sh

git commit -m "Phase 3c.1: design + decisions for public profile pages

Locks the design for Phase 3c — public, un-gated, server-rendered
artist profile pages and shareable compare links. No code changes;
3c.2 (migration) through 3c.5 (tests + smoke + commit) implement
against the spec below.

Decisions captured in PHASE_3C_DESIGN.md:

* Surface
  GET /a/:slug                      — 200 text/html, indexable
  GET /compare/:slugs               — 200 text/html, +-separated slugs,
                                      max 5
  GET /robots.txt + /sitemap.xml    — static + auto-generated from
                                      the artists table

  All four mount BEFORE requireUser() so the cookie isn't required.

* Slug format — locked at v1, never changes silently (anyone who
  shares a link expects it to keep working). NFKD-fold → strip
  diacritics → lowercase → '&'→'and' → drop quotes/parens/dots →
  whitespace→hyphen → collapse runs → trim. Stored on artists.slug
  as UNIQUE. Backfill aborts loudly on collision.

* Visibility — per-artist is_public BOOLEAN, default TRUE. Roster
  is small + curated; opt-in feels right (closes open question 3
  from PHASE_3_BRAINSTORM.md). Admin flips is_public=false to hide
  individual artists; the public route 404s but the artist stays
  in the in-app roster (signed-in users still see them).

* Compare URL — '+'-separated slugs in the path (semicolons fight
  with old curl + some CDN edge configs; '+' is unambiguous and
  URL-safe with no encoding step). Max 5 (matches existing
  COMPARE_MAX in app.html). Order preserved exactly as URL
  specifies — useful for screenshots. Unknown slugs silently
  dropped; zero recognized → 404.

* SSR vs hydration — server renders the snapshot table as proper
  <table> HTML so crawlers see structured data. Chart hydrates
  client-side via /public-pages.js reading the same data from a
  <script type=\"application/json\"> block. JS-disabled clients
  still see the table. Page never calls /api/* — all content
  inlined at render time, no CORS, no auth, no client-side state.

* What's public — snapshot chart + table + lifetime views + 7-day
  growth + sign-up CTA. NOT briefs (Premium-only stays Premium),
  NOT audio features, NOT ranking, NOT video feed (bandwidth +
  hotlink-y; defer to v2).

* Frontend (3c.4) — Share button on artist detail page +
  compare-bar Share button. Clicking copies the public URL to
  clipboard with a 2s 'Copied' toast. No URL navigation; the
  shared link points outward.

* Tests — slugs.test.js for determinism + 8 example cases +
  reverse-lookup edge cases. test-public-pages.sh smoke for
  200/404/400 paths + robots.txt + sitemap.xml.

Explicitly deferred to 3d / Phase 4:
* Per-artist robots.txt allow-list (one flag is enough for v1)
* OG image generation (basic OG meta is there; SVG endpoint later)
* Login-via-shared-link UX (stays a query param for now)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
