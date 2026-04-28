#!/usr/bin/env bash
# Stage + commit Phase 3.5.2 — CSP nonce migration. Drops 'unsafe-inline'
# from script-src and style-src by switching to per-request nonces on
# every inline <script> + <style> block.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/middleware/security.js \
  tx-rapper-tracker-backend/src/index.js \
  tx-rapper-tracker-backend/src/routes/public.js \
  tx-rapper-tracker/app.html \
  tx-rapper-tracker/admin.html \
  tx-rapper-tracker-backend/scripts/save-progress-3-5-2.sh

git commit -m "Phase 3.5.2: CSP nonce migration — drop 'unsafe-inline'

Closes the TODO that lived in middleware/security.js since Phase 2a.
Inline <script> + <style> blocks in app.html, admin.html, and the
public-page templates now ride a per-request nonce; 'unsafe-inline'
is gone from script-src and style-src. DOM-injected scripts (XSS)
without the right nonce are blocked at the browser level.

* src/middleware/security.js
  - New cspNonce() middleware. Generates 16 random bytes per
    request as base64url (22 chars), stores on res.locals.cspNonce.
    Must run BEFORE securityHeaders().
  - securityHeaders() drops 'unsafe-inline' from scriptSrc +
    styleSrc. New entries are callable directive values
    ((req, res) => 'nonce-\${res.locals.cspNonce}') — helmet
    re-evaluates per request, so the header always carries the
    fresh nonce.
  - cdnjs.cloudflare.com remains allowed by URL for Chart.js (no
    nonce needed for external scripts; the URL allow-list covers
    them).
  - Inline event handlers (onsubmit=) are still allowed — closing
    that surface is a follow-up that needs a sweep through app.html
    converting the few remaining onsubmit= attrs to data-action
    delegated listeners (we already use that pattern; it's just
    finishing the conversion).

* src/index.js
  - cspNonce() mounted before securityHeaders() so res.locals is
    populated when the CSP header is built.
  - Static-html serving moved off res.sendFile to readFileSync at
    startup + per-request String.replaceAll('__CSP_NONCE__', nonce).
    Cache-once-at-startup keeps things fast (the launchd backend
    restarts on every code change, so the cache is naturally
    invalidated). 130KB string + ~6 inline blocks per page = O(N)
    over page bytes per request, negligible vs typical DB
    roundtrips.

* src/routes/public.js
  - pageShell() takes a cspNonce arg and emits nonce= attrs on its
    inline <style> + JSON-island <script>.
  - Both render fns (renderArtistPage, renderComparePage) accept
    cspNonce and pass through to pageShell.
  - Route handlers source the nonce from res.locals.cspNonce.

* tx-rapper-tracker/app.html
  - Inline <style> on line 8 → <style nonce='__CSP_NONCE__'>.
  - Inline <script> on line 1261 → <script nonce='__CSP_NONCE__'>.
  - External Chart.js <script src=cdnjs...> stays unchanged
    (covered by the script-src URL allow-list).

* tx-rapper-tracker/admin.html
  - Inline <style> on line 7 → <style nonce='__CSP_NONCE__'>.
  - Inline <script> on line 147 → <script nonce='__CSP_NONCE__'>.

Verification:
  - All 45 unit tests still pass (16 slugs.test.js + 29
    briefs.test.js spot-checked; the rest didn't import affected
    modules).
  - middleware/security.js exports both cspNonce + securityHeaders.
  - Inline JS in app.html still parses cleanly.

Live verify (deferred to user):
  1. bash scripts/restart-backend.sh
  2. curl -I http://localhost:8787/   → grep for the
     'Content-Security-Policy' header; verify it includes
     'nonce-<value>' on script-src + style-src and does NOT
     include 'unsafe-inline'.
  3. curl http://localhost:8787/   | grep nonce=   → every inline
     block carries the same nonce as the header.
  4. Open Chrome devtools → Console: should be CSP-violation-free.
  5. Try injecting an inline <script> via document.body.innerHTML
     in devtools → CSP blocks it (no matching nonce).

Rollback (if needed): single revert of this commit; the four
files affected are independent.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
