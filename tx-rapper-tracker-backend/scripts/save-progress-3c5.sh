#!/usr/bin/env bash
# scripts/save-progress-3c5.sh
# Stage + commit Phase 3c.5 — the curl smoke for the public surface.
# Closes Phase 3c end-to-end. Live verify against the running backend
# is documented inline in the script.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/test-public-pages.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3c5.sh

git commit -m "Phase 3c.5: public-pages smoke (closes Phase 3c)

Closes Phase 3c end-to-end. The backend (3c.3) and frontend (3c.4)
are wired up; this commit adds the curl smoke that confirms the
public surface behaves correctly without any auth.

* scripts/test-public-pages.sh

  Eight subtests, all reachable anonymously (no signup required —
  these pages ARE the funnel surface):

    1. GET /a/megan-thee-stallion → 200, Content-Type=text/html,
       <title> contains the artist name, page contains a <table>
       (proves SSR snapshot data is present, not JS-only),
       rel=canonical present, sign-up CTA links present.
    2. GET /a/this-doesnt-exist → 404.
    3. GET /a/has%3Bsemicolon → 404 (defense-in-depth: invalid slug
       shape never reaches the DB; isValidSlug short-circuits).
    4. GET /compare/megan-thee-stallion+glorilla → 200 + both
       artist names appear in the body.
    5. GET /compare/a+b+c+d+e+f → 400 + kind:'compare.too_many'
       (cap of 5 enforced).
    6. GET /compare/foo+bar → 404 (zero recognized slugs).
    7. GET /robots.txt → 200, contains 'Allow: /a/',
       'Allow: /compare/', 'Disallow: /admin', 'Disallow: /api/',
       and a 'Sitemap:' advertisement.
    8. GET /sitemap.xml → 200, valid <urlset> element, at least
       one <loc>, changefreq=daily.

Live verify steps for the user:
  npm run migrate                       # apply 016
  bash scripts/test-public-pages.sh     # 8/8 pass expected
  open the app, drill into Megan, click Share — toast w/ URL
  paste URL incognito → public profile renders
  pick 2 artists, click Share in compare bar — same flow

After this commit, Phase 3c (public profile pages + shareable
compare) is closed. Next up per the agreed plan: Phase 3.5
hardening pass (3.5.1 launchd backend supervisor, 3.5.2 CSP nonce
migration, 3.5.3 cron failure alerting, 3.5.4 /api/health/deep)
before Phase 3d.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
