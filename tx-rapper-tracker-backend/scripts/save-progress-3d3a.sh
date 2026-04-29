#!/usr/bin/env bash
# Phase 3d.3a — first chunk of the referral program. Migration 018
# adds the three new tables + users.referrer_token; services/referrals.js
# implements the pure helpers + DB getters + the Stripe coupon
# orchestrator. 11/11 unit tests pass.
#
# Follow-on commits in this phase:
#   3d.3b — routes/referrals.js + signup wiring + webhook hook
#   3d.3c — frontend (refer-a-friend modal + email-prefs modal +
#           onboarding empty-state + friendlier error copy)
#   3d.3d — smoke + close-out for Phase 3d

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/migrations/018_referrals.sql \
  tx-rapper-tracker-backend/src/services/referrals.js \
  tx-rapper-tracker-backend/test/referrals.test.js \
  tx-rapper-tracker-backend/scripts/save-progress-3d3a.sh

git commit -m "Phase 3d.3a: referral program — migration 018 + services/referrals.js

First chunk of the referral feature locked in PHASE_3D_DESIGN.md.
Schema + service module + 11 unit tests; nothing reads these yet.
3d.3b wires routes + signup + the webhook hook; 3d.3c adds the
frontend modal + onboarding bundle; 3d.3d adds the smoke + closes
Phase 3d.

* migrations/018_referrals.sql

  Three new tables + one new column:

  - referrals (user_id PK, token UNIQUE) — stable per-user token
    backfilled lazily on first GET /api/referrals/me. Token never
    auto-rotates (locked design).
  - users.referrer_token TEXT — set at signup from the tx_ref
    cookie; FK to referrals(token) ON DELETE SET NULL so an
    archived referrer does not cascade-delete the referred user.
    FK added with NOT VALID + VALIDATE for a fresh-DB no-op +
    populated-DB strict check.
  - referral_clicks (BIGSERIAL PK, token, ip INET, user_agent, ts)
    + index on (token, ts DESC) for the route-s 24h dedupe gate.
  - referral_coupons (referred_user_id PK, referrer_user_id,
    stripe_coupon_id, amount_off_cents, currency, expires_at,
    redeemed_at) + index (referrer_user_id, created_at DESC) for
    the stat-page hot path. PK = referred_user_id is what makes
    INSERT ... ON CONFLICT DO NOTHING the right idempotency key
    for the Stripe webhook; re-deliveries are no-ops.

* src/services/referrals.js (~340 lines)

  Pure surface (exported for tests):
  - generateToken() — 8 bytes -> 12 chars base64url, locked at v1.
  - isValidToken(s) — alphanumeric + _- only, length 6-32.
  - isDifferentUser(referrer, referred) — self-referral check.
    Returns true (= no referral to fight with) when either id
    is missing.
  - buildCouponPayload({...}) — composes the locked Stripe coupon
    shape: duration:once, amount_off:cents (FIXED, not pct, so
    pricing changes do not drift the payout), max_redemptions:1,
    redeem_by 30d out, metadata with both user IDs + source.
    Pure — no Stripe call, no DB.

  Locked constants:
    TOKEN_BYTES = 8
    CLICK_DEDUPE_HOURS = 24
    ANTI_FRAUD_SIGNUP_LIMIT = 3 (per-IP signups within window)
    ANTI_FRAUD_WINDOW_HOURS = 24
    ANTI_FRAUD_PAUSE_DAYS = 7  (coupon path disabled for the IP
                                after the limit trips)
    COUPON_AMOUNT_OFF_CENTS_DEFAULT = 1900 (USD 19/mo Pro reference;
                                            override per-call if
                                            pricing changes)
    COUPON_EXPIRY_DAYS = 30

  I/O surface:
  - ensureToken(userId) — race-safe insert + select, idempotent.
  - getReferrerByToken(token) — null on miss (used by signup
    wiring + click endpoint).
  - recordClick({token, ip, userAgent}) — idempotent within
    CLICK_DEDUPE_HOURS for same (token, ip). Returns null when
    deduped, row id otherwise.
  - getStats(userId) — { clicks, signups, conversions,
    couponsIssued } via a single 4-subquery SELECT.
  - ipIsSignupAbusing(ip) — counts via audit_log (event=signup)
    rather than a new users.last_signup_ip column. Reuses the
    existing audit infrastructure that already captures IP at
    signup; avoids a schema migration just for an anti-fraud
    counter.
  - recordCoupon({...}) — INSERT ... ON CONFLICT (referred_user_id)
    DO NOTHING. Returns { issued, row } so the orchestrator can
    distinguish first-write from a Stripe re-delivery.

  Orchestrator:
  - createReferralCoupon({...}) — top-level path called from the
    webhook handler. Self-referral guard, already-issued short-
    circuit (skip the Stripe call), buildCouponPayload, lazy-
    import of services/stripe.js#getStripe (so this module is
    importable without the SDK), Stripe-side coupons.create,
    persist via recordCoupon. Returns { issued, reason?, row? }.

* test/referrals.test.js (11 tests, all passing)
  - generateToken: base64url shape + length + uniqueness across
    1000 generations.
  - isValidToken: accept well-formed; reject empty / null /
    too-short / too-long / spaces / SQL-injection-ish / =-padding.
  - isDifferentUser: rejects identity, allows real referrals,
    returns true when either id is missing.
  - buildCouponPayload: locked Stripe shape (duration:once,
    amount_off, currency, max_redemptions:1, name, metadata),
    redeem_by COUPON_EXPIRY_DAYS in the future as unix-seconds,
    accepts amountOffCents + currency overrides.
  - TOKEN_BYTES = 8 contract.

Verification:
  * 11/11 referrals tests PASS.
  * services/referrals.js imports cleanly.
  * No regressions in the existing slugs / briefs / digest /
    health-deep suites (spot-checked).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
