#!/usr/bin/env bash
# scripts/save-progress-3b5.sh
# One-shot stage + commit for Phase 3b.5 — the artist detail page
# brief surface + the curl smoke. Closes Phase 3b end-to-end.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref. Live verify with:
#   1. npm run migrate          (applies migration 015_artist_briefs)
#   2. npm install @anthropic-ai/sdk
#   3. set ANTHROPIC_API_KEY in .env, restart the backend
#   4. bash scripts/test-briefs.sh  (smokes 401/400/402/404 paths)
#   5. open the app, drill into an artist with snapshots, see the brief

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker/app.html \
  tx-rapper-tracker-backend/scripts/test-briefs.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3b5.sh

git commit -m "Phase 3b.5: artist detail page brief surface + curl smoke

Closes Phase 3b end-to-end. The backend route from 3b.4 is now
reachable through the UI: signed-in Premium users see the brief in
its own card on the artist detail page; Free / Pro users see the
upgrade card; the empty-state and error paths each render their own
copy without leaving the surface.

Frontend changes (app.html):

* Detail-page panel
  New <div class=\"detail-panel\" id=\"detailBriefPanel\"> inserted
  above the audio-features panel. Same demo-mode hide rule —
  briefPanel.style.display='none' when a.id is null, since
  /api/artists/:id/brief is UUID-keyed and won't resolve in demo.

* CSS additions
  .brief-text (paragraph block, white-space:pre-wrap so a stray
  newline doesn't collapse), .brief-meta (small caption row of
  'Generated 2h ago · claude-haiku-4-5 · cached' with thin dot
  separators), .brief-degraded (warning amber for
  shapingDegraded:true responses), .brief-badge (the Premium pill
  next to the panel header), .brief-empty / .brief-error.

* renderArtistBrief(a)
  Parallel to renderArtistFeatures. Hits GET
  /api/artists/:id/brief and dispatches on the response shape +
  HTTP status:

    200 + brief                → render paragraph + meta row
    200 + briefs.no_data       → 'No snapshots yet' empty state
    402                        → reuse renderFeatureGate with
                                  brief-specific body copy
                                  ('Unlock AI briefs with Premium')
    503  briefs_unconfigured   → 'AI briefs aren't configured on
                                  this server' note pointing at
                                  the env var the owner needs to set
    504  briefs_timeout        → 'Refresh to try again' note
    502  briefs_upstream       → 'Anthropic upstream error' note
    other / network            → 'Couldn't load the brief' note

  fmtBriefRelative() is a small inline 'X min/h/days ago'
  formatter — we don't need a full Intl.RelativeTimeFormat
  surface for one caption, and the existing freshness badge
  doesn't expose a helper.

  Model display strips the dated suffix ('-20251001') so users
  see 'claude-haiku-4-5' not the full pin. Falls back to the raw
  string if the regex doesn't match — forward-compat with future
  model id shapes.

Backend smoke (scripts/test-briefs.sh, new):

  Five subtests covering what's reachable without a real Stripe +
  Anthropic setup:

    1. anonymous /brief → 401  (requireUser fires)
    2. signup → session         (Free tier by default)
    3. signed-in non-UUID id    → 400 or 402 (param-first vs
                                  gate-first ordering)
    4. signed-in unknown UUID   → 402 (Free) or 404 (Premium)
    5. signed-in real artist    → 402 + kind=payments.required +
                                  minTier=premium

  The 200 fresh-generation, cacheHit:true second-call, and 503
  briefs_unconfigured paths are documented as manual-verify steps
  in the script header — they need ANTHROPIC_API_KEY + a real
  Premium subscription on the test user, neither of which the
  smoke can fake without DB write privileges.

Verified the inline JS in app.html still parses (single 132KB
script block, no syntax errors). All 29 briefs.test.js unit tests
remain passing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
