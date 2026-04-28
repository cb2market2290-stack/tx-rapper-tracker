#!/usr/bin/env bash
# scripts/save-progress-3b3.sh
# One-shot stage + commit for Phase 3b.3 — services/briefs.js, the
# Claude SDK client, and 29 unit tests covering the pure surface.
# After this commit the cache + generation logic is real; the only
# missing piece is the route (3b.4) and the frontend (3b.5).
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref. Apply the dep with
# `npm install @anthropic-ai/sdk` in the backend dir before
# /api/artists/:id/brief lands — the SDK is dynamically imported
# (same pattern as the optional `stripe` package).

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/services/briefs.js \
  tx-rapper-tracker-backend/src/config.js \
  tx-rapper-tracker-backend/.env.example \
  tx-rapper-tracker-backend/test/briefs.test.js \
  tx-rapper-tracker-backend/scripts/save-progress-3b3.sh \
  tx-rapper-tracker-backend/scripts/_run-tests-tail.sh \
  tx-rapper-tracker-backend/scripts/_run-tests-to-file.sh

git commit -m "Phase 3b.3: services/briefs.js + Claude SDK client + 29 unit tests

The cache + generation half of the AI artist brief feature. After this
commit getOrGenerateBrief(artistId) is callable end-to-end; 3b.4 wires
it up to a route and 3b.5 surfaces it on the artist detail page.

Module map:

* src/services/briefs.js (new, ~520 lines)

  Pure surface (no I/O, exported for tests):
  - PROMPT_VERSION, DEFAULT_MODEL, MAX_TOKENS, TEMPERATURE,
    RETRY_TEMPERATURE — locked constants. Bumping any of these
    requires a PROMPT_VERSION bump too; the cache key folds in
    PROMPT_VERSION + model so the rollout is clean.
  - The locked v1 SYSTEM_PROMPT, embedded verbatim from
    PHASE_3B_DESIGN.md.
  - keyInputs(...) — normalize the cache-key inputs into a stable
    shape (DATE → 'YYYY-MM-DD', TIMESTAMPTZ → ISO).
  - canonicalize(value) — recursive JSON serializer that sorts
    object keys at every level. Defends against JS engine quirks
    where object insertion order can leak into the fingerprint.
  - fingerprint(inputs) — sha256 hex of canonicalize(keyInputs(...)).
    64 chars; matches the CHECK on artist_briefs.fingerprint.
  - stripNulls(value) — drops null + undefined keys recursively
    (preserves zero/false/empty string + array nulls).
  - buildUserMessage({...}) — assembles the user-message JSON
    payload Claude sees. No DB; takes already-fetched inputs.
  - evaluateBrief(s) — { ok, reason }. Reasons: 'too_short',
    'too_long', 'forbidden_pattern' (bullets, numbered lists,
    headers, code fences, URLs).
  - wordCount(s) — trim-aware whitespace split.

  I/O surface:
  - getAnthropic() — lazy-init, dynamic-import the
    @anthropic-ai/sdk. Same posture as services/stripe.js: SDK is
    optional in dev, throws on cache-miss generation when
    ANTHROPIC_API_KEY is unset, never crashes at module load.
  - callClaude({ userMessage, model, temperature, signal }) — one
    Anthropic call. Accepts an AbortSignal so the route can wire
    in the 25s timeout from config.briefs.timeoutMs without the
    service knowing about Express.
  - readCache / writeCache — (artist_id, fingerprint) lookup +
    INSERT...ON CONFLICT DO NOTHING for the race-safe write.
  - getOrGenerateBrief(artistId, opts) — read-through entry point.
    Throws 'artist_not_found' / 'insufficient_data' /
    'briefs_unconfigured' as Error.code values that the route
    maps to 404 / 200+empty / 503.

  Retry orchestration: first call at TEMPERATURE=0.3, evaluate
  output. On failure, retry once at RETRY_TEMPERATURE=0.1. If both
  fail, pick whichever is windowed (50-180 words) and surface
  shapingDegraded:true so the frontend can render a small note.
  Hard upper trim at MAX_WORDS=180 at sentence boundary if the
  model massively overshoots.

  _generateForTests(...) — test seam that bypasses the SDK by
  taking a fakeClaude callback. Used by the unit tests to assert
  retry behavior without the network.

* src/config.js
  New ANTHROPIC_API_KEY / ANTHROPIC_BRIEF_MODEL /
  ANTHROPIC_BRIEF_TIMEOUT_MS env vars + a frozen config.briefs
  block + redacted() handling for the API key. enabled is a
  convenience flag the rest of the app reads (cache hits still
  serve when enabled is false; cache misses 503).

* .env.example
  Phase 3b section with the three new vars + the same posture-and-
  feature-flag commentary the Stripe section uses.

* test/briefs.test.js (new, 29 tests, all passing)
  - fingerprint determinism (1) + sensitivity to artistId,
    snapshot date, features ts, prompt_version, model (5).
  - null vs undefined latestFeaturesExtractedAt collapses to the
    same hash (1).
  - keyInputs date normalization (2).
  - canonicalize key-order stability + nested + primitives (3).
  - evaluateBrief: ok, too_short, too_long, bullets, numbered
    lists, headers, code fences, URLs (8).
  - wordCount edge cases (1).
  - stripNulls drops null/undefined recursively + preserves
    falsy values + preserves array nulls (2).
  - buildUserMessage includes artist name + payload + handles
    missing breakout/features + drops nulls but keeps false (3).
  - _generateForTests: first-pass success skips retry (1);
    first-pass fail triggers retry; retry success returns clean
    (1); both fail → shapingDegraded=true (1).

  Confirmed pre-existing tests still pass (auth, breakout,
  features, savedsearches, savedsearch-evaluator, stripe spot-
  checked).

* scripts/_run-tests-tail.sh, scripts/_run-tests-to-file.sh
  Internal helpers for running 'npm test' from osascript — node
  isn't on PATH in a non-login shell, and AppleScript's redirect
  syntax fights with bash one-liners. Not part of any release
  path; useful during development.

Dep posture (intentionally NOT in package.json):

  @anthropic-ai/sdk is dynamically imported in services/briefs.js,
  same as stripe is in services/stripe.js. Production envs that
  enable briefs must run 'npm install @anthropic-ai/sdk' separately.
  This keeps the module installable without an Anthropic account
  configured — the test suite + the rest of the API run fine
  without the SDK present.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
