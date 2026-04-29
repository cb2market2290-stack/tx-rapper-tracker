# Phase 3d — design + decisions: weekly digest + referral

Status: locked design, NOT a brainstorm. Same posture as
PHASE_3B_DESIGN.md and PHASE_3C_DESIGN.md — pin the user-facing
contracts (cadence, opt-in mechanics, coupon shape) before writing
code, because email schedules and referral payouts are awkward to
change after they ship.

This is what 3d.1 produces. 3d.2 (digest) and 3d.3 (referral)
implement against it. Onboarding empty-state + friendlier error copy
are folded in along the way (recommendation items 5 + 7 from the
hardening discussion).

## Goal

Two adjacent revenue + retention levers, each ~1 week of focused
work:

* **Weekly digest email** — every Monday, signed-in users with the
  digest opted-in get an email with the top 5 movers from the past
  7 days plus 1 "emerging artist we noticed." Free-tier opt-in by
  default, so the digest IS the funnel back into the app. Closes
  open question 4 from PHASE_3_BRAINSTORM.md (mailer cap policy).

* **Referral program** — every paid user gets a per-account share
  link `/?ref=<token>`. When someone signs up via that link AND
  later converts to paid, the referrer gets a 1-month-free-Pro
  Stripe coupon. Closes open question 5 from the brainstorm
  (coupon shape — fixed-amount-discount, redeemable once).

## Surface area

### Digest

```
GET   /api/digest/preferences           → {opted_in, last_sent_at, last_clicked_at}
PATCH /api/digest/preferences           body: {opted_in: bool}
                                        → {opted_in, ...}
                                        Audit: digest.optin_changed
GET   /api/digest/preview               → returns the digest payload
                                          that would be sent now
                                          (admin/dev only)
```

Plus the cron job:

```
scripts/send-weekly-digest.js           Runs Mondays 09:00 local.
                                        Walks all users where
                                        opted_in=TRUE, builds the
                                        per-user payload, calls the
                                        mailer.
```

### Referral

```
GET    /api/referrals/me                → { token, link, stats }
                                          token = stable per-user;
                                          link = APP_BASE_URL/?ref=<token>;
                                          stats = {clicks, signups,
                                                   conversions, coupons_issued}
POST   /api/referrals/click             body: {token}
                                        Anonymous; called from app.html
                                        when ?ref=<token> hits the page
                                        before signup. Records (token, ip,
                                        user_agent, ts) for click stats.
                                        No PII beyond what every other
                                        request logs.
```

Plus the Stripe webhook hook + a tiny piece of signup wiring:

```
src/auth/signup.js  reads the ref cookie set by /?ref=<token> and
                    persists referrer_user_id on the new users row.
                    No frontend behavior change beyond the cookie set.

src/routes/payments.js#webhook handler — when a referred user
                    converts to paid (checkout.session.completed AND
                    plan != 'free'), fire createReferralCoupon():
                    creates a Stripe one-shot coupon (1-month-free-Pro,
                    redeemable once, expires in 30d), emails the
                    referrer with the redemption code via the
                    pluggable mailer.
```

## Digest — locked decisions

### Cadence

**Weekly, Monday 09:00 in the user's local timezone.** Not "Monday
04:00 UTC" — sending at a sane local hour is the difference between
"I open this every week" and "this becomes spam in my Promotions
folder." We already collect timezone implicitly via signup
metadata; if we don't have one we default to America/Chicago (the
roster is Texas-based, so the user is statistically likely to be on
that clock too).

Cron runs hourly between 06:00 and 14:00 UTC; per user we check
"is it currently between 09:00 and 09:59 in their local TZ AND
did we already send this Monday?"

### Content layout

```
Subject: Top movers this week — 6 artists tracked

Hey,

Here is what moved most among the artists you are tracking this
past week (Apr 21 – Apr 28):

  1. Megan Thee Stallion   +1.4M views   8.6% growth
  2. GloRilla              +280K views   5.2% growth
  3. Asian Doll            +96K views    3.1% growth
  4. KenTheMan             +62K views    2.3% growth
  5. Tay Money             +12K views    0.8% growth

One emerging artist we noticed: BigXthaPlug, +1.1M views in 7
days from a smaller base — worth a watch.

[ See the full dashboard ]   [ Manage alerts ]

— TX Rapper Tracker
You opted into this digest. Stop receiving these.
```

* Plain-text only for v1. HTML email is a follow-up if conversion
  data justifies it (HTML emails 2x the deliverability work — DKIM/
  DMARC alignment, image hosting, dark-mode CSS).
* The "emerging artist" is the artist with the highest 7-day
  percentage growth from a base under 5M lifetime views (= not
  Megan-class, but moving). NULL when no one qualifies; we just
  drop the line.
* The unsubscribe link is a one-click GET to `/api/digest/unsubscribe?token=<HMAC>`
  that flips opted_in=FALSE without requiring a re-login. HMAC
  prevents anyone-with-the-URL from unsubscribing other users.

### Opt-in default

**Default opt-in (true).** Bundled into signup; the digest is what
makes the product feel alive for free-tier users who otherwise
might never come back. Opt-out is one click and surfaces three
places: the unsubscribe link in every digest, the account-settings
modal, and a "manage your preferences" link on the dashboard
empty-state when the user has zero saved searches.

This is opt-in-by-default, NOT opt-out under the GDPR/CAN-SPAM
sense — we're sending transactional + product-update emails to
users who explicitly created an account, not unsolicited
marketing. The digest is contextually adjacent to "track artists
on this site," which is what they signed up for.

### Mailer cap

Phase 2b pluggable mailer (`services/mailer.js`) is reused. Cap
policy:

* In dev (`config.mail.resendApiKey === null`): ConsoleMailer
  writes to `/tmp/last-digest-email-<email>.txt`. No cap.
* In prod (Resend or whatever): one digest per user per Monday.
  The `last_sent_at` row column is the gate; we set it inside a
  `SELECT FOR UPDATE` so a re-run of the cron mid-Monday doesn't
  double-send.
* Per-user max 4 emails per week across all our channels (digest
  + saved-search alerts + password reset). Saved-search alerts
  already have a 24h cooling-off; the digest counts toward the
  weekly cap. Beyond cap: skip + log; the next week's digest
  starts fresh.

## Referral — locked decisions

### Token shape

Per-user, stable, opaque. `referrals.token TEXT NOT NULL UNIQUE`,
generated at signup (or backfilled lazily on first GET
/api/referrals/me) as `crypto.randomBytes(8).toString('base64url')` —
12 chars, URL-safe, no leak of the user-id sequence.

Tokens NEVER rotate automatically. Manual rotate is a future admin
button; the current flow keeps shareable URLs stable forever.

### Click capture

Anonymous endpoint `POST /api/referrals/click` records `(token, ip,
user_agent, ts)` into `referral_clicks`. Idempotent: if the same
(token, ip) hit within the last 24h, skip the insert. Counters in
`/api/referrals/me` come from this table.

The `?ref=<token>` query param triggers a session cookie
`tx_ref=<token>` that lasts 30 days. On signup, the cookie's token
becomes `users.referrer_token` (FK to `referrals.token`). After
signup the cookie is cleared.

### Coupon shape

**Stripe one-shot coupon, 1 month of Pro free, redeemable once,
expires 30 days after issue.**

Concretely:

```
stripe.coupons.create({
  duration: 'once',
  amount_off: <price-of-pro-in-cents>,
  currency: 'usd',
  redeem_by: <unix-30d-from-now>,
  max_redemptions: 1,
  metadata: { referrer_user_id, referred_user_id, source: 'phase-3d' },
})
```

Fixed-amount-off is preferred over percentage:
* Pricing might change later; an amount_off coupon doesn't drift.
* Easier accounting — every issued coupon is a known-dollar
  liability.

Issued via the existing webhook on `checkout.session.completed` AND
`subscription.metadata.plan_slug != 'free'`. Race-safe: we INSERT
INTO `referral_coupons` with `ON CONFLICT (referred_user_id) DO
NOTHING`, so if Stripe re-delivers the webhook we don't double-issue.

### Self-referral guard

`if referrer_user_id === referred_user_id: skip`. Plus a separate
guard against same-IP-different-account (`COUNT(*) FROM users
WHERE last_signup_ip = $ip AND created_at > now() - 24h`) — three
signups from one IP in 24h disables the coupon path for that IP
for 7 days. Conservative; adjustable in `services/referrals.js`
constants.

### Anti-fraud, deferred

Email-domain reputation, signup-velocity per IP block, manual
admin review for unusual referral counts — all out of scope for
v1. The redemption-once + 30-day expiry naturally caps damage; if
fraud becomes a real problem we add a `referrals.frozen_until`
column and a small admin UI.

## Migration (3d.2 + 3d.3)

```
migrations/017_digest_prefs.sql

ALTER TABLE users
  ADD COLUMN digest_opted_in BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN digest_last_sent_at  TIMESTAMPTZ,
  ADD COLUMN digest_last_clicked_at TIMESTAMPTZ,
  ADD COLUMN digest_unsub_token   TEXT;  -- HMAC payload, lazy-set on first send

CREATE INDEX users_digest_due_idx
  ON users (digest_opted_in, digest_last_sent_at)
  WHERE digest_opted_in;
```

```
migrations/018_referrals.sql

CREATE TABLE referrals (
  user_id   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token     TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN referrer_token TEXT;

CREATE TABLE referral_clicks (
  id          BIGSERIAL PRIMARY KEY,
  token       TEXT NOT NULL REFERENCES referrals(token) ON DELETE CASCADE,
  ip          INET,
  user_agent  TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX referral_clicks_token_idx
  ON referral_clicks (token, ts DESC);

CREATE TABLE referral_coupons (
  referred_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_coupon_id TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at      TIMESTAMPTZ
);
```

## Frontend additions (3d.2 + 3d.3)

### Digest preferences modal

Reuse the auth-modal pattern. New row in the auth widget header:
"Email preferences." Click → modal with one switch ("Send me the
weekly digest, default on") + the unsubscribe link copy + a
"manage alerts" button that closes this modal and opens the
existing alerts modal.

### Referral panel

New tab inside the same Email-preferences modal, OR a separate
"Refer a friend" button on the dashboard header. v1 picks the
button (more discoverable; the digest preferences modal stays
single-purpose).

```
[Refer a friend]   →  modal with:
   "Share this link, get 1 free month of Pro for every friend
    who upgrades:"
   [https://tx-rapper-tracker.com/?ref=A1bC2dEf]   [Copy]
   "You've shared 0 times · 0 signups · 0 paid · 0 coupons earned"
```

### Onboarding empty-state (item 5 from the hardening discussion)

When a signed-in user has zero saved searches AND no recent
activity:

```
┌────────────────────────────────────────────────────┐
│  Welcome — here's how this works                    │
│                                                    │
│  1. Click an artist to see their stats              │
│  2. Click "Add to compare" to compare side-by-side  │
│  3. Click "Alerts" to email yourself when an artist │
│     crosses a threshold                             │
│                                                    │
│  We send a weekly digest of top movers — first one  │
│  arrives Monday. [Manage preferences]              │
│                                                    │
│  [Got it, dismiss]                                  │
└────────────────────────────────────────────────────┘
```

Dismissible — sets a `localStorage` flag `tx_onboarded` so it
doesn't reappear. (One of the few legitimate localStorage uses;
not security-sensitive.)

### Friendlier error copy (item 7)

A pass through every `'Couldn\'t load X'` string in app.html that
adds (a) the thing's name, (b) a Retry button, (c) a "report an
issue" link to a static page. ~5-minute wins per surface; the
cumulative effect is significant on first-impression. Bundled into
3d.2's frontend pass; not a separate phase.

## Tests + smoke

`test/digest.test.js` — 8 tests covering:
1. Pure: `buildDigestForUser({user, snapshots})` returns the right
   plain-text payload + the "emerging artist" line when applicable.
2. Pure: timezone gate function `isDigestHourFor(user, now)`
   returns true exactly between 09:00 and 09:59 in the user's TZ.
3. Pure: HMAC unsubscribe-token round-trip.

`test/referrals.test.js` — 8 tests covering:
1. Pure: `generateToken()` is 12 chars, base64url, unique across
   N=1000 generations.
2. Pure: `selfReferralCheck(referrer, referred)` rejects identity.
3. Pure: `couponPayload(opts)` produces the right Stripe shape.
4. Pure: idempotency key `referred_user_id` so re-deliveries don't
   double-issue.

`scripts/test-digest.sh` — anonymous + signed-in subtests:
1. PATCH /api/digest/preferences anonymous → 401.
2. PATCH signed-in → 200, audit row written.
3. GET /api/digest/preview admin → 200, contains the user's
   tracked artists.
4. Cron-side: invoke `send-weekly-digest.js --dry-run` against a
   seeded user, assert the mailer file in /tmp.

`scripts/test-referrals.sh`:
1. GET /api/referrals/me anonymous → 401.
2. GET signed-in for a brand-new user → 200, fresh token, zero
   stats.
3. POST /api/referrals/click with the token → 200; second call
   within 24h same IP → 200 but no new row.
4. Sign up referred user → users.referrer_token set.
5. Convert via webhook in dev mode (Stripe CLI listen) → assert
   referral_coupons row written, referrer email file in /tmp.

## What's deferred

* HTML email — plain text first; HTML when the click-through data
  warrants the deliverability work.
* Per-user customizable digest content — fixed top-5-movers shape
  for v1.
* Referral leaderboard / public stats — out of scope.
* Multi-tier referral payouts (different coupon for Pro→Pro vs
  Pro→Premium upgrade) — single shape covers v1.
* Email-domain anti-fraud — see "Anti-fraud, deferred" above.

## Open questions explicitly closed by this doc

| # | Question (from PHASE_3_BRAINSTORM.md) | Answer |
|---|----------------------------------------|--------|
| 4 | What's the digest's mailer cap?       | One per user per Monday + a 4-emails-per-week per-user max across all channels. |
| 5 | Coupon shape — fixed vs percentage?   | Fixed amount_off in cents (= 1-month Pro), redeem-once, 30-day expiry. |

Plus the new questions this doc closes:

| # | Question | Answer |
|---|----------|--------|
| 6 | Cadence + send hour? | Weekly Monday 09:00 in the user's local timezone. |
| 7 | Default opt-in or opt-out? | Opt-in (= digest_opted_in DEFAULT TRUE). One-click unsubscribe via HMAC token in every email. |
| 8 | Token length / entropy? | 8 random bytes → 12 chars base64url. Stable per user. |
| 9 | Self-referral + same-IP guard? | Reject identity; rate-limit signups-per-IP to 3-per-24h. |
