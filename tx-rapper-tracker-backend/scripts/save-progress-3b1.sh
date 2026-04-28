#!/usr/bin/env bash
# scripts/save-progress-3b1.sh
# One-shot stage + commit for Phase 3b.1 — the design + Claude prompt
# lock-in for the AI artist briefs feature. No code changes; this
# commit is just the design doc that 3b.2-3b.5 implement against.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/PHASE_3B_DESIGN.md \
  tx-rapper-tracker-backend/scripts/save-progress-3b1.sh

git commit -m "Phase 3b.1: design + Claude prompt lock-in for AI artist briefs

Locks the design for Phase 3b — Premium-only AI artist briefs that turn
the dashboard's snapshot + audio-feature data into a one-paragraph
narrative for label A&R teams. No code changes in this commit; 3b.2
through 3b.5 implement against the spec below.

Key decisions captured in PHASE_3B_DESIGN.md:

* Surface: GET /api/artists/:id/brief, gated by
  requirePaid({ minTier:'premium' }). Returns
  { brief, generatedAt, cacheHit, model, tokensIn, tokensOut }.

* Inputs to the prompt are deliberately bounded: artist name, last 14
  daily snapshots, the breakout_signals row, and the features
  aggregate (no per-track rows). Anything not in this list is not in
  the cache key — keeping both the prompt and the key small.

* Cache key: sha256 over { artist_id, latest_snapshot_id,
  latest_features_extracted_at, prompt_version, model }. Stored in a
  new artist_briefs table (3b.2) with a UNIQUE (artist_id,
  fingerprint) constraint. The breakout_signals matview is downstream
  of latest_snapshot_id so it's NOT in the key — including it would
  cause spurious cache misses.

* prompt_version='v1' for this design. Bumping invalidates every
  cached row in one move. Same logic for the model field — Anthropic
  shipping a new Haiku rolls the cache cleanly.

* Model: claude-haiku-4-5-20251001 (env-overridable). Temperature 0.3
  for consistent voice across regenerations. max_tokens 320 — caps
  spend and gives Claude room to overshoot the 80-120 word target,
  which the post-call shaper then enforces.

* The system + user prompts are reproduced verbatim in the doc. They
  forbid markdown formatting, list markers, and made-up facts; they
  require present tense and a forward-looking close. Bumping any of
  these requires a prompt_version bump.

* Output shaping: trim, reject + retry once at temperature 0.1 if
  the word count is <50 or >180 or the response contains URLs / list
  markers / code fences / headers.

* Frontend (3b.5): one card on the artist detail page. Premium users
  see the brief + a 'Generated <when>' caption. Free / Pro users see
  the existing 402 upgrade-card pattern with 'Unlock AI briefs with
  Premium'. No manual Refresh button — cache invalidation drives
  regeneration so users can't burn API credits on unchanged inputs.

* Errors: 402 (Premium gate), 404 (artist not found), 503 (no API
  key on cache miss; cache hits still serve), 504 (>25s timeout).

* Open questions from the Phase 3 brainstorm are explicitly closed:
  prompt locked; cache key locked; Haiku 4.5; non-streaming; no
  manual refresh.

* Explicitly deferred: token-by-token streaming, thumbs-up/down
  feedback, digest emails (that's Phase 3d), TikTok/Spotify inputs
  (Phase 4 platform expansion).

This is the doc 3b.2 (migration), 3b.3 (service + SDK), 3b.4 (route +
gate), and 3b.5 (frontend + tests + smoke) implement against. With
the prompt + cache key both locked here, the rest of 3b is
mechanical.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
