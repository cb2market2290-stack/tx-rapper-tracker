#!/usr/bin/env bash
# Phase 3d.3b — referral routes + signup wiring + checkout webhook
# hook. After this commit the referral feature is reachable end-to-end
# from curl: GET /me, POST /click, signup persists referrer_token,
# checkout.session.completed issues the coupon. 3d.3c adds the
# frontend modal + onboarding bundle.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/src/routes/referrals.js \
  tx-rapper-tracker-backend/src/routes/auth.js \
  tx-rapper-tracker-backend/src/routes/payments.js \
  tx-rapper-tracker-backend/src/index.js \
  tx-rapper-tracker-backend/scripts/save-progress-3d3b.sh

git commit -m "Phase 3d.3b: referral routes + signup wiring + webhook hook

End-to-end backend reachability for the referral feature. After this
commit, hitting POST /api/referrals/click with a valid token records
a click; signing up while a tx_ref cookie is set persists
users.referrer_token; converting via Stripe Checkout fires
createReferralCoupon and writes the referral_coupons row. 80/80
unit tests pass across slugs / briefs / digest / health-deep / referrals.

* src/routes/referrals.js (new, ~110 lines)
  Mounted at /api/referrals in src/index.js.

  GET  /api/referrals/me     requireUser(); auto-creates the
                              referrals row on first call (lazy
                              backfill via ensureToken). Returns
                              token + shareable link + stats. The
                              link uses config.appBaseUrl when set,
                              falls back to the request origin
                              otherwise — matches the
                              public-routes pattern from 3c.

  POST /api/referrals/click  anonymous, body {token}. Idempotent
                              within 24h-same-(token, ip). Returns
                              200 + kind:referrals.click_recorded
                              OR kind:referrals.click_deduped — both
                              200 by design (no leak between
                              dedupe-hit + bad-token shape;
                              defense in depth against fishing
                              probes).

* src/routes/auth.js — signup wiring

  Added a small block before the INSERT INTO users that pulls the
  tx_ref cookie (req.cookies.tx_ref — cookie-parser is already
  mounted globally), calls getReferrerByToken to validate, and
  persists the resolved token on users.referrer_token. Self-referral
  is impossible at this point because the user row is being created
  RIGHT NOW; the referrer was someone else by definition.

  Failure modes:
  - bogus token shape -> isValidToken rejects -> referrerToken null
  - lookup blip       -> try/catch swallows  -> referrerToken null
  - resolved          -> persist + clearCookie tx_ref + audit detail
                          carries the token

  audit() now includes referrer_token in the signup event details
  so the audit log tells us who-referred-whom without joining.

  Imports getReferrerByToken from services/referrals.js.

* src/routes/payments.js — checkout.session.completed coupon hook

  After the existing linkCustomer + audit work in the
  checkout.session.completed branch, added a referral-coupon path:

    1. Gate on shaped.paymentStatus in (paid, no_payment_required) —
       only converted sessions issue a coupon. Abandoned cart skips.
    2. SELECT users.referrer_token + the corresponding
       referrals.user_id via LEFT JOIN. Skip if no referrer.
    3. Call createReferralCoupon — service module handles
       isDifferentUser self-referral guard + already-issued short-
       circuit (skips the Stripe call when an existing coupon row
       is found via PK referred_user_id). Stripe re-deliveries are
       no-ops because INSERT ... ON CONFLICT DO NOTHING.

  Best-effort: try/catch swallows so the coupon path can never tank
  the rest of the webhook flow. Logs success + failure with enough
  context for an admin to reconstruct.

  Anti-fraud IP guard (ipIsSignupAbusing) is NOT wired here — the
  webhook context only has Stripe-s IP, not the user-s. The TODO is
  noted inline for the follow-up (wire the gate at signup time
  instead, where req.ip is the real client IP).

  Imports query from db/pool + createReferralCoupon from services/referrals.

* src/index.js — mount

  app.use(/api/referrals, referralsRoutes) — sits next to the
  /api/digest mount. /me requires session, /click is anonymous;
  the per-route requireUser() handles the gate so the mount
  itself is bare.

Verification:
  * Three modules import cleanly (routes/referrals, routes/auth,
    routes/payments).
  * 80/80 tests across slugs + briefs + digest + health-deep +
    referrals PASS.

Live verify (deferred to user / 3d.3d smoke):
  npm run migrate                                       # apply 018
  bash scripts/restart-backend.sh
  curl -b cookies.txt /api/referrals/me                # 200 + token
  curl -X POST -d {token:...} /api/referrals/click     # 200
  visit /?ref=<token> in incognito + sign up           # users.referrer_token set
  + run scripts/test-payments.sh through a real conversion
    -> referral_coupons row written + Stripe coupon created

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
