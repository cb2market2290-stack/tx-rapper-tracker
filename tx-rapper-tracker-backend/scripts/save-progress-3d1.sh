#!/usr/bin/env bash
# Stage + commit Phase 3d.1 — design + decisions for the weekly digest
# email + the referral program. No code changes; 3d.2 (digest) and
# 3d.3 (referral) implement against this spec.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker-backend/PHASE_3D_DESIGN.md \
  tx-rapper-tracker-backend/scripts/save-progress-3d1.sh

git commit -m "Phase 3d.1: design + decisions for weekly digest + referral program

Locks the user-facing contracts before writing code. Email schedules
and referral payouts are awkward to change after they ship; getting
the cadence + opt-in mechanics + coupon shape right matters more
than the implementation details.

Decisions captured in PHASE_3D_DESIGN.md:

* Surface — digest:
  GET    /api/digest/preferences
  PATCH  /api/digest/preferences         body: opted_in
  GET    /api/digest/preview             admin/dev only
  GET    /api/digest/unsubscribe?token   one-click HMAC unsub
  scripts/send-weekly-digest.js          Mondays 09:00 local TZ

* Surface — referral:
  GET    /api/referrals/me               token + link + stats
  POST   /api/referrals/click            anon, idempotent within 24h
  signup wiring                          ?ref=token cookie -> users.referrer_token
  webhook hook                           on checkout.session.completed
                                         + plan!=free -> create coupon

* Cadence (digest): Weekly Mondays 09:00 in the user local timezone.
  Cron runs hourly 06:00-14:00 UTC and per-user checks
  is-it-09:00-locally + did-we-already-send-this-Monday. Default
  TZ America/Chicago for users without one set (roster is Texas).

* Content (digest): Plain-text only for v1. Top-5 movers from
  past 7 days + 1 emerging artist (highest pct growth from a
  base under 5M lifetime views). Subject explicit, links to
  dashboard + alerts manager. One-click unsubscribe via HMAC
  token (no re-login needed; doesn-t allow unsubscribing other
  users). HTML email deferred until click-through data justifies
  the DKIM/DMARC/dark-mode work.

* Default opt-in (digest_opted_in DEFAULT TRUE). The digest is
  what makes the product feel alive for free-tier users who
  otherwise might never come back. Opt-out surfaces in three
  places: every email, account settings, dashboard empty-state.

* Mailer cap: Phase 2b pluggable mailer reused. One digest per
  user per Monday (gated by users.digest_last_sent_at via
  SELECT FOR UPDATE so re-runs do not double-send). Per-user
  max 4 emails per week across all channels (digest + saved-
  search alerts + reset). Saved-search alerts already have a
  24h cooling-off; the digest counts toward the weekly cap.

* Referral token: 8 random bytes -> 12 chars base64url, stable
  per user, never auto-rotated. Backfilled lazily on first GET
  /api/referrals/me. crypto.randomBytes so no leak of the
  user-id sequence.

* Coupon shape: Stripe one-shot coupon, FIXED amount_off in
  cents (= 1-month Pro), max_redemptions=1, redeem_by 30 days
  out, metadata carries referrer_user_id + referred_user_id.
  Fixed-amount preferred over percentage so pricing changes do
  not drift the payout.

* Issued via the existing checkout.session.completed webhook.
  Race-safe: INSERT INTO referral_coupons WITH ON CONFLICT
  (referred_user_id) DO NOTHING. Stripe re-deliveries are no-ops.

* Self-referral: rejected (referrer === referred). Same-IP
  guard: 3 signups from one IP in 24h disables coupons for
  that IP for 7 days. More aggressive anti-fraud (email-domain
  reputation, manual admin review) deferred to Phase 4.

* Migration shapes locked:
  017_digest_prefs.sql ALTER users + partial index for cron
  018_referrals.sql   referrals + referral_clicks +
                       referral_coupons tables + users.referrer_token

* Frontend additions (3d.2/3d.3):
  Email-preferences modal (one switch + unsubscribe copy)
  Refer-a-friend button + modal (token URL + Copy + stats)
  Onboarding empty-state on signed-in dashboard with zero
    saved searches (recommendation item 5)
  Friendlier error copy pass through app.html (item 7) -
    bundled here, not a separate phase

* Tests + smoke spec:
  test/digest.test.js + test/referrals.test.js (~16 unit
    tests covering buildDigestForUser, isDigestHourFor, HMAC
    round-trip, generateToken uniqueness, selfReferralCheck,
    coupon payload shape, idempotency-key behavior)
  scripts/test-digest.sh + scripts/test-referrals.sh
    (anonymous + signed-in + cron-dry-run + Stripe-CLI-listen
    end-to-end)

Out of scope for v1:
  HTML email, custom digest content, referral leaderboard,
  multi-tier coupon shapes, email-domain anti-fraud.

Closes Phase 3 brainstorm open questions 4 + 5 (mailer cap,
coupon shape) and adds 4 new locked questions (cadence + send
hour, default opt-in posture, token entropy, self-referral guard).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
