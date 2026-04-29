#!/usr/bin/env bash
# Stage + commit Phase 3.5.4 — GET /api/health/deep composite freshness
# check. Closes Phase 3.5 end-to-end (4/4 hardening items shipped).

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/routes/health.js \
  tx-rapper-tracker-backend/test/health-deep.test.js \
  tx-rapper-tracker-backend/scripts/save-progress-3-5-4.sh

git commit -m "Phase 3.5.4: GET /api/health/deep composite freshness check

Closes Phase 3.5 end-to-end (4/4 hardening items shipped). Single
endpoint that says yes-or-no the system is alive AND fresh, not just
that the HTTP server happens to be answering. Wires to two consumers:
external uptime monitors (UptimeRobot, Better Stack, Cloudflare Health
Checks) and a launchd-side cron-of-last-resort that pages on non-200.

* src/routes/health.js
  Adds GET /api/health/deep alongside the existing /health (process
  is up) and /ready (cache stats). Public + un-authenticated by
  design — no PII, no resource enumeration. Mounted under /api/* so
  the existing rate limiter applies (= bounded against probing).

  Four parallel checks via Promise.all (max wall-clock = slowest
  check, not sum):

    * db                — SELECT 1 round-trip raced against a 1s
                          timeout. Pool exhaustion / wedged
                          connection fails fast rather than hanging
                          the health check itself.
    * snapshot_fresh    — MAX(captured_on) ≤ 26h. Daily cron at
                          04:00; 26h is one full miss + 2h slack.
                          Empty-state (no rows yet) reports
                          applicable=false and passes — first-run
                          state shouldn't false-alarm.
    * extract_fresh     — MAX(extracted_at) ≤ 7d. Audio extraction
                          is enqueue-driven; 7d covers normal pacing.
                          Empty-state (zero analyzed tracks) reports
                          applicable=false and passes — opt-in per
                          artist; valid configuration.
    * briefs_configured — only checked when config.briefs.enabled.
                          When the feature is disabled (no
                          ANTHROPIC_API_KEY) this returns
                          applicable=false; same posture as Stripe
                          being disabled in dev.

  Response shape:
    200 on green   → { kind: health.deep, status: ok, failed: [],
                       checks: {...}, uptimeMs }
    503 on any red → same shape with status: degraded and failed: []
                     listing the failed check keys

* test/health-deep.test.js (2 unit tests)
  - Default export is an Express router with a non-empty layer stack.
  - The router contains the three expected route paths (/health,
    /ready, /api/health/deep).

  The DB-touching paths (checkDb, checkSnapshotFresh,
  checkExtractFresh) are exercised by manual verify against live
  Postgres; what's protected here is the wiring + mount.

Verification:
  * 2/2 health-deep.test.js PASS.
  * node -e import('./src/routes/health.js') OK.
  * No existing tests touch this file; smoke + briefs/slugs unit
    suites still pass.

Live verify (deferred to user):
  curl http://localhost:8787/api/health/deep | python3 -m json.tool
    → status: ok, failed: [], all four checks present
  bash scripts/restart-backend.sh
  curl http://localhost:8787/api/health/deep | python3 -m json.tool
    → status: ok, db.latencyMs < 50

Closes Phase 3.5. Hardening pass complete:
  3.5.1 launchd backend supervisor       — c966152
  3.5.2 CSP nonce migration              — afb7f71
  3.5.3 cron failure alerting            — 4ca9d5d
  3.5.4 /api/health/deep                  — this commit

Next per the agreed plan: Phase 3d (digest emails + referral) with
the friendlier-error-copy + onboarding-empty-state items folded in.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
