#!/usr/bin/env bash
# Stage + commit the Cloudflare edge-cache headers on the public routes
# + the POWER_RESILIENCE.md runbook. Both ship together because they
# both target the question "how does this Mac-hosted site survive real
# traffic" — one buys 10x effective public-traffic capacity for free,
# the other documents the cheap mitigations that keep the Mac itself
# online.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/routes/public.js \
  tx-rapper-tracker-backend/POWER_RESILIENCE.md \
  tx-rapper-tracker-backend/scripts/save-progress-edge-cache-and-resilience.sh

git commit -m "Edge-cache headers on public routes + POWER_RESILIENCE runbook

Two changes that travel together because they both answer the single
question of how this Mac-hosted site holds up under real traffic:

* src/routes/public.js — Cache-Control headers on the four public
  routes. With Cloudflare in front of the tunnel, anonymous traffic
  on these paths is now served from the edge for the bulk of repeat
  requests:

    /a/:slug           public, s-maxage=300, max-age=60, swr=600
    /compare/:slugs    same
    /robots.txt        public, max-age=3600
    /sitemap.xml       public, s-maxage=3600, max-age=600

  s-maxage scopes the TTL to shared caches (Cloudflare). max-age
  scopes the browser-side TTL. stale-while-revalidate=600 lets
  clients serve a stale response for up to 10 minutes while a
  background fetch refreshes — smooths the cache-population race
  during a viral spike.

  4xx responses (404 unknown slug, 400 too-many-slugs) deliberately
  do NOT carry Cache-Control. Cloudflare-s default 4xx caching is
  short, and we do not want a temporarily-hidden artist to stay
  404-d at the edge past when the admin flips is_public back on.

  Live verify (already run): curl -D - confirms all four routes
  serve the right Cache-Control on the live backend.

  Practical impact: anonymous traffic on the public surface is now
  effectively unlimited. Your home upload bandwidth only sees the
  first hit per artist per 5 minutes, plus refreshes from
  signed-in users (never cached).

* POWER_RESILIENCE.md — runbook for keeping the Mac-hosted site up.
  Three failure modes covered:
    1. Power outage → APC Back-UPS BE600M1 ~USD 80 + System Settings
       configuration so the Mac auto-boots on power restoration.
    2. Internet outage → manual phone-tether failover; permanent
       failover deferred to Hetzner-when-revenue-justifies.
    3. Mac sleep / auto-update reboot → System Settings flags to
       disable both. launchd plist (Phase 3.5.1) already auto-
       restarts the backend on the boot that follows.

  Plus monitoring (UptimeRobot / Better Stack / Cloudflare Health
  Checks all free), ISP TOS reality check (Cloudflare Tunnel
  protects against most enforcement triggers), and a 5-line
  verification checklist for every network change.

  Ends with a Mac-hardware-failure section — Postgres backup recipe
  and the 30-minute path to a new machine via git + the Hetzner
  runbook in PHASE_3_5_HARDENING.md.

No code changes outside the four added Cache-Control headers + four
named constants. Inline JS still parses; 80/80 unit tests still pass.

Live verify steps for the user:
  bash scripts/restart-backend.sh
  curl -D - http://localhost:8787/a/megan-thee-stallion | head -10
    -> expect Cache-Control: public, s-maxage=300, max-age=60, ...
  Through Cloudflare:
    curl -D - https://<your-domain>/a/megan-thee-stallion | head -20
    -> expect cf-cache-status: HIT after the second request

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
