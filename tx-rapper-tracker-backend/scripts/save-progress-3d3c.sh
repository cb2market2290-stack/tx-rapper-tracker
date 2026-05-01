#!/usr/bin/env bash
# Phase 3d.3c — frontend bundle for digest + referral. Email-prefs
# modal, refer-a-friend modal, onboarding empty-state, ?ref capture
# on page load. 3d.3d closes Phase 3d with the smoke + the live verify.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
cd "$REPO_ROOT"

git add \
  tx-rapper-tracker/app.html \
  tx-rapper-tracker-backend/scripts/save-progress-3d3c.sh

git commit -m "Phase 3d.3c: frontend — email-prefs + refer + onboarding + ref-capture

The user-facing surface for digest + referral. After this commit the
auth widget exposes Email + Refer buttons, the dashboard greets
brand-new users with an onboarding card, and a /?ref=<token> URL
sets the tx_ref cookie + records the click before signup.

Auth widget header — 2 new buttons next to Alerts:
  btnEmail (data-action=email-prefs-open)    Phase 3d.2
  btnReferral (data-action=referrals-open)   Phase 3d.3
Both mirror btnSecurity / btnAlerts signed-in/out lifecycle in
renderAuthWidget. Hidden until /api/auth/me resolves so we do not
flash a button that disappears the moment the 401 lands.

Three new modal HTML blocks before the reset-view:

  emailPrefsOverlay — single switch for digest_opted_in. Loads
    via GET /api/digest/preferences; saves via PATCH. Shows the
    last-sent-at line so the user knows what to expect. Reuses
    .auth-overlay / .auth-modal / .sec-modal scaffold.

  referralsOverlay — readonly text input with the share link +
    Copy button + 4 stats (clicks, signups, coupons issued,
    redeemed). Loads via GET /api/referrals/me which
    auto-creates the row on first call. Copy reuses the Phase
    3c.4 copyToClipboard + showShareToast helpers when present;
    falls back to inline OK/ERR otherwise.

  onboardingCard — gradient-tinted card placed inline ABOVE the
    movers strip in the dashboard. Three numbered steps + a
    bottom line about the weekly digest with a link that opens
    the email-prefs modal. Got-it button dismisses + sets
    localStorage tx_onboarded=1. maybeShowOnboarding() also
    short-circuits when the user already has any saved-search
    activity (= they figured this out on their own).

Dispatcher cases (body-level [data-action] switch):
  email-prefs-open / -close / -overlay-bg / -save
  referrals-open / -close / -overlay-bg / -copy
  onboarding-dismiss

JS module — ~330 new lines:
  setEmailPrefsErr / setEmailPrefsOk / openEmailPrefs /
    closeEmailPrefs / saveEmailPrefs
  setReferralsErr / setReferralsOk / openReferrals /
    closeReferrals / copyReferralLink (uses 3c.4
    copyToClipboard + showShareToast when available)
  maybeShowOnboarding / dismissOnboarding (localStorage
    ONBOARDING_KEY = tx_onboarded)
  captureReferralFromUrl — runs FIRST in window.onload.
    Validates the token shape (regex 6-32 chars), sets tx_ref
    cookie (30d, SameSite=Lax, path=/), strips the ?ref=
    param via history.replaceState (refresh stays clean),
    fires POST /api/referrals/click best-effort (soft-fail).
    All inside a try/catch so it never throws out of onload.

CSS additions:
  .onboarding-card — gradient-tint background using the existing
    accent color, dashed-border-style padding, hidden by default.
    .hidden override.

Inline JS still parses cleanly (148KB single block). 80/80 unit
tests still pass (front-end changes don't touch the test path).

Live verify (deferred to 3d.3d / user):
  npm run migrate                     # 017 + 018
  bash scripts/restart-backend.sh
  Sign in with the test user
    -> Email + Refer buttons appear in the header
    -> Click Email -> see digest opt-in switch
    -> Click Refer -> see share link + 0 stats
  Open /?ref=<some valid token> in incognito
    -> tx_ref cookie set, ?ref= stripped from URL
    -> POST /api/referrals/click fired
  Sign up via the incognito tab
    -> users.referrer_token persisted (verify in admin audit log)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git rev-parse HEAD
