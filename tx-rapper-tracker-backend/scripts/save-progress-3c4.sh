#!/usr/bin/env bash
# scripts/save-progress-3c4.sh
# Stage + commit Phase 3c.4 — frontend Share buttons (artist detail
# header + compare bar) + the toast helper. Plumbing-only commit;
# 3c.5 adds the curl smoke + live-verify pass.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker/app.html \
  tx-rapper-tracker-backend/src/routes/artists.js \
  tx-rapper-tracker-backend/scripts/save-progress-3c4.sh

git commit -m "Phase 3c.4: frontend Share buttons + slug plumbing

Wires the public profile + compare URLs (3c.3) into the signed-in
app. Two new affordances + the underlying data plumbing:

* Detail-page header — new 'Share' button next to '+ Add to compare.'
  Hidden when the artist has no slug (= demo-mode SEED_NAMES rows).
  Click copies <origin>/a/<slug> to the clipboard and surfaces a 2.2s
  bottom-center toast with the URL. Re-using the same data-action
  dispatcher pattern as the rest of the app (no inline onclick).

* Compare bar — new 'Share' button between 'Compare →' and 'clear.'
  Visible only when EVERY picked artist has a slug; if any picked
  member is demo-mode the share button hides (don't ship a URL that
  404s on the public route). Click copies
  <origin>/compare/<slug1>+<slug2>+... to the clipboard, toast shows
  the count of artists in the link.

Backend plumbing:

* src/routes/artists.js — GET /api/artists now returns slug +
  is_public alongside the existing id/name/sort_order. Migration 016
  guarantees both columns are NOT NULL so older clients that don't
  read them simply ignore the extras (additive, no breaking change).

Frontend plumbing (app.html):

* buildArtistData carries slug + isPublic through to artistData[i]
  so renderArtistDetail can decide whether to show the Share button
  per-artist.

* compareSlugsForCurrentSet() resolves compareSet (which holds
  artist NAMES, kept that way to survive grid re-sorts) to slugs
  via lookup against artistData. Used by both the share-compare
  flow and the cb-share visibility check.

* renderCompareBar() now toggles .cb-share visibility based on
  'every picked artist has a slug.' Mismatch hides the button so
  we never produce a broken share URL.

* renderArtistDetail() shows the detail-share-btn when a.slug
  exists, hides otherwise. data-arg=slug so the dispatcher can
  shareCurrentArtist() without a separate global.

JS surface:

* copyToClipboard(text) — async; prefers navigator.clipboard +
  isSecureContext, falls back to a hidden-textarea + execCommand
  shim for older browsers / non-HTTPS dev contexts. Always
  resolves to a boolean so callers don't have to branch on
  Promise vs sync return.

* showShareToast(msg, isError?) — shared between share-artist and
  share-compare. Two-frame nudge for the .show transition (avoids
  the display:none → opacity:1 same-frame swallow). 2.2s normal,
  3s on error. Single global timer so a quick second click cancels
  the prior fade.

* shareCurrentArtist / shareCurrentCompare — entry points for the
  data-action dispatcher. Toast with the actual URL on copy
  failure (rare; helps users long-press / select manually).

CSS additions (~50 lines):

* .detail-share-btn (mirrors .detail-compare-toggle geometry,
  muted color so Compare stays the primary affordance)
* #compareBar .cb-share (secondary against cb-go)
* .share-toast (fixed bottom-center, fade in/out via .show)

Inline JS still parses cleanly (138KB single script block); 16/16
slugs.test.js still passing.

Live verify deferred to 3c.5:
  1. npm run migrate            # apply 016
  2. open the app, drill into Megan, click Share — toast shows URL
  3. paste URL into incognito — public profile renders
  4. pick 2 artists, click Share in compare bar — same flow
  5. /compare/megan-thee-stallion+glorilla → public compare view

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
