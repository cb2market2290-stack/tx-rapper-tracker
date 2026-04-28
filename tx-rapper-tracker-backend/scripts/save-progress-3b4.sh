#!/usr/bin/env bash
# scripts/save-progress-3b4.sh
# One-shot stage + commit for Phase 3b.4 — GET /api/artists/:id/brief
# wired up + Premium gate + the route's 200/402/404/503/504/502 status
# mapping. After this commit the brief feature is reachable from
# curl + Premium-only; 3b.5 adds the frontend surface and the
# end-to-end smoke.
#
# Run from anywhere (the script self-anchors via BASH_SOURCE).
#
# After the commit, prints the new HEAD ref.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/routes/artists.js \
  tx-rapper-tracker-backend/scripts/save-progress-3b4.sh

git commit -m "Phase 3b.4: GET /api/artists/:id/brief route + Premium gate

Wires services/briefs.js (3b.3) to a real route. The route is mounted
under the existing /api/artists router so its requireUser() applies;
the route itself adds requirePaid({ minTier: 'premium' }) so Free and
Pro users get the standard 402 dispatch the frontend already knows.

Status mapping is locked here:

  200 + brief                       cache hit OR fresh generation
  200 + briefs.no_data + brief:''   artist has zero snapshots
                                    (friendly empty-state, no Claude
                                    burn — we don't ship a hallucinated
                                    paragraph against missing data)
  402                               Free / Pro user
  404                               artist missing or archived
  503  briefs_unconfigured          cache miss + ANTHROPIC_API_KEY unset
  504  briefs_timeout               Claude > config.briefs.timeoutMs
                                    (default 25s)
  502  briefs_upstream              429 / 5xx / 529 from Anthropic

The 25s timeout is enforced via an AbortController whose signal
threads from the route into services/briefs.js#callClaude. When the
timer fires the in-flight Claude call is canceled — without this, the
SDK connection would linger past the 504 we send back, doubling the
latency the user perceives if they refresh.

Error mapping is by err.code (set by the service module) plus a
defensive AbortError catch for forward-compat with whichever exact
shape the Anthropic SDK rethrows on cancellation. Anything we don't
recognize falls through to the global error handler — same posture as
the rest of the routes.

Response shape on 200:
{
  kind: 'artists.brief',
  artistId, brief, generatedAt, model, promptVersion,
  tokensIn, tokensOut, cacheHit, shapingDegraded, fingerprint
}

cacheHit + tokensIn/Out are surfaced so an admin can eyeball
'how much is this feature costing me this month' without parsing
logs. shapingDegraded lets the frontend render a small note when both
the first call and the retry-at-temperature-0.1 failed evaluation.

Verified the briefs.test.js unit suite still passes (29/29) and the
route module imports cleanly.

3b.5 adds the artist-detail-page surface + the live smoke
(scripts/test-briefs.sh).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
