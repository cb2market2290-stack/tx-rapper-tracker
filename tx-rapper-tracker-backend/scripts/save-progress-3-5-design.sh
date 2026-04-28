#!/usr/bin/env bash
# Stage + commit PHASE_3_5_HARDENING.md — the design doc for the
# hardening + self-healing pass that slots between Phase 3c and
# Phase 3d. No code changes; 3.5.1 through 3.5.4 implement against
# the spec in this commit.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/PHASE_3_5_HARDENING.md \
  tx-rapper-tracker-backend/scripts/save-progress-3-5-design.sh

git commit -m "Phase 3.5 design — hardening + self-healing pass between 3c and 3d

Locks the design for a 3-4 day pass that slots between Phase 3c
(public profile pages) and Phase 3d (digest + referral). No
customer-visible features; material gains on every one of the four
product factors the user flagged: security, simplicity, upgrade-
friendliness, self-healing.

Four items, ranked by impact-to-effort:

* 3.5.1 — launchd plist for the BACKEND itself (mirrors the existing
  audio-extract worker plist pattern). Today node src/index.js runs
  in a terminal session; if it crashes nothing brings it back. Adds
  ~/Library/LaunchAgents/com.txrappertracker.backend.plist with
  KeepAlive:true + RunAtLoad:true + ThrottleInterval:30 (no hot-loop
  on instant-crash) + scripts/install-launchd-backend.sh +
  scripts/restart-backend.sh. Single biggest self-healing win.

* 3.5.2 — CSP nonce migration. Closes the TODO in
  src/middleware/security.js line 9 ('migrating to nonces is a
  follow-up'). New cspNonce() middleware generates 16 bytes of
  crypto-random per request → res.locals.cspNonce →
  securityHeaders() emits 'nonce-\${nonce}' instead of
  'unsafe-inline' on script-src + style-src. The static-html
  routes become tiny render fns that substitute __CSP_NONCE__
  tokens in app.html / admin.html. Material XSS hardening — closes
  the only 'unsafe-inline' grant in the helmet config.

* 3.5.3 — snapshot + cron failure alerting via the Phase 2b mailer.
  Wraps scripts/snapshot-stats.js + the audio-extract worker + the
  Phase 3a saved-search evaluator in try/catch; on permanent
  failure (or stale-data detection: MAX(captured_on) > 36h old after
  a successful run) sends an admin email. Distinguishes 'snapshot
  couldn't run' from 'snapshot ran but the API returned nothing.'

* 3.5.4 — GET /api/health/deep — composite freshness check. DB
  reachable (SELECT 1 < 1s) + last snapshot < 26h + last audio
  extract < 7d + briefs configured (when enabled). Returns 200 on
  green, 503 on any red with which-check-failed in body. Wires to
  two consumers: an external uptime monitor and a 5-minute
  launchd-side cron that mails on non-200 (= cron-of-last-resort
  catching anything 3.5.3's own wrappers miss).

Migration / rollback: every item is a single revert commit. 3.5.1
launchctl bootout + 3.5.2 re-add 'unsafe-inline' + 3.5.3 try/catch
removal + 3.5.4 endpoint deletion all clean.

Out of scope for 3.5: migration rollback plan, staging environment,
GitHub Actions CI, friendlier error copy + onboarding empty-state
(folded into 3d).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
