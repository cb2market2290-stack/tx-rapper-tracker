#!/usr/bin/env bash
# Phase 3d.3d — close-out for Phase 3d. Two new smoke scripts:
# test-digest.sh covers the digest preferences + preview + unsubscribe
# routes; test-referrals.sh covers /me + /click + dedup + stats. After
# this commit Phase 3d is closed end-to-end.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/scripts/test-digest.sh \
  tx-rapper-tracker-backend/scripts/test-referrals.sh \
  tx-rapper-tracker-backend/scripts/save-progress-3d3d.sh

git commit -m "Phase 3d.3d: smoke + close-out for Phase 3d (digest + referral)

Closes Phase 3d end-to-end. Two curl smokes covering the parts of
both features that are testable without an email account or a real
Stripe conversion. Manual-verify hooks are documented inline at the
top of each script.

* scripts/test-digest.sh

  9 subtests covering /api/digest/preferences + /preview +
  /unsubscribe routes:
    1. anonymous GET /preferences -> 401
    2. anonymous PATCH /preferences -> 401
    3. signup -> session
    4. signed-in GET /preferences -> 200 + opted_in=true (default
       per locked design)
    5. signed-in PATCH opt-out -> 200 + persisted on read-back
    6. signed-in GET /preview -> 200 (payload may be null when
       breakout_signals is empty; both 200s)
    7. unsubscribe with bogus token -> 400 + HTML response
    8. unsubscribe with no params -> 400
    9. send-weekly-digest.js parses cleanly via node --check

  What this CANNOT do without manual setup:
    - real-mailer send (needs RESEND_API_KEY + verified domain).
      Manual: with RESEND_API_KEY set, run send-weekly-digest.js
      on a Monday 09:00 local; expect Resend dashboard to show
      a send.

* scripts/test-referrals.sh

  9 subtests covering /api/referrals/me + /click + dedup + stats:
    1. anonymous /me -> 401
    2. signup -> session
    3. signed-in /me -> 200 + token + link with ?ref=token + zero stats
    4. /me returns the SAME token on second call (stable per user)
    5. /click with malformed token -> 200 + click_deduped (no leak)
    6. /click with shape-OK but non-existent token -> 200 deduped
    7. /click with the real token -> 200 + click_recorded
    8. /click again same-IP within 24h -> 200 + click_deduped
    9. /me reflects the recorded click in stats.clicks

  What this CANNOT do without manual setup:
    - End-to-end Stripe coupon issuance. Manual path: with
      STRIPE_SECRET_KEY set, run scripts/test-payments.sh through
      a real conversion for a referred user, then check
      SELECT * FROM referral_coupons WHERE referred_user_id = ...;
      should show one row + a Stripe-side coupon id that resolves
      via stripe.coupons.retrieve(...).

Phase 3d closes 7 commits in:
  3d.1   — design + decisions doc                       8de0536
  3d.2   — digest backend (migration + service +
           routes + cron + 22 unit tests)               a21f49a
  3d.3a  — referral migration + service + 11 unit tests ed37860
  3d.3b  — referral routes + signup + webhook hook      1158038
  3d.3c  — frontend bundle (modals + onboarding +
           ?ref capture)                                871c16c
  3d.3d  — smoke close-out                              this commit

Live verify steps for the user:
  npm run migrate                                  # 017 + 018
  bash scripts/restart-backend.sh
  bash scripts/test-digest.sh                      # 9/9 PASS expected
  bash scripts/test-referrals.sh                   # 9/9 PASS expected
  open the app, sign in, click Email + Refer
  open /?ref=<your token> in incognito + sign up
    -> users.referrer_token persisted in audit log

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
