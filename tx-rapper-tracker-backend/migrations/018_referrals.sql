-- migrations/018_referrals.sql
-- Phase 3d.3 — referral program. Three new tables + one new column on
-- the existing users table. Schema-only commit; nothing reads these
-- yet. The service module + routes + webhook hook (3d.3 follow-on
-- commits) implement against this.
--
-- Design (locked in PHASE_3D_DESIGN.md):
--
--   * referrals (user_id PK + token UNIQUE) — one row per user with
--     a stable per-user token. Backfilled lazily on first GET
--     /api/referrals/me; never auto-rotates so shared URLs stay
--     stable forever.
--
--   * referral_clicks (id BIGSERIAL) — one row per anonymous click
--     of a /?ref=<token> URL. Idempotent within 24h-same-IP via
--     the route layer (we DON'T enforce this in SQL because a 24h
--     check is awkward as a constraint; route uses a SELECT WHERE
--     ip = ... AND ts > now() - interval '24 hours' guard).
--     ip is INET so Postgres handles v4 + v6 + CIDR comparisons
--     correctly.
--
--   * referral_coupons (referred_user_id PK) — one row per user
--     who was referred AND converted to paid. PK is referred_user_id,
--     NOT (referrer, referred), so the existing checkout webhook
--     can do INSERT ... ON CONFLICT (referred_user_id) DO NOTHING
--     to handle Stripe re-deliveries cleanly. metadata copies the
--     locked design's coupon shape (1-month-Pro fixed amount_off
--     in cents, redeem-once, 30-day expiry).
--
--   * users.referrer_token TEXT — set at signup if the visitor had
--     a tx_ref cookie. Foreign-key into referrals(token) so an
--     archived referrer cascades the link cleanly. ON DELETE SET
--     NULL because the referred user keeps existing even if the
--     referrer deletes their account.
--
-- All four tables are additive. Roll back = DROP TABLE + ALTER
-- TABLE DROP COLUMN.

BEGIN;

CREATE TABLE IF NOT EXISTS referrals (
  user_id     UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT         NOT NULL UNIQUE,
  -- created_at is informational only — the token never auto-rotates,
  -- so this is just "when was the share link first generated."
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referrer_token TEXT;

-- The fk has to be added separately because referrals doesn't exist
-- before this migration. Use NOT VALID + VALIDATE in case there are
-- already users rows with a stale token from a prior partial migration
-- run; on a fresh DB the VALIDATE pass is a no-op.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_referrer_token_fkey;

ALTER TABLE users
  ADD CONSTRAINT users_referrer_token_fkey
  FOREIGN KEY (referrer_token) REFERENCES referrals(token) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE users
  VALIDATE CONSTRAINT users_referrer_token_fkey;

CREATE TABLE IF NOT EXISTS referral_clicks (
  id          BIGSERIAL    PRIMARY KEY,
  -- Cascading delete: a referrer who removes their account drops
  -- the click history with them.
  token       TEXT         NOT NULL REFERENCES referrals(token) ON DELETE CASCADE,
  ip          INET,
  user_agent  TEXT,
  ts          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Per-token recent-click query — "show me clicks in the last 24h
-- for this token" is the dedupe gate. Sort DESC so the route's
-- WHERE ts > now() - interval '24 hours' uses an index range scan.
CREATE INDEX IF NOT EXISTS referral_clicks_token_ts_idx
  ON referral_clicks (token, ts DESC);

CREATE TABLE IF NOT EXISTS referral_coupons (
  -- One row per converted referred user, NOT one per (referrer,
  -- referred) — the PK shape is what makes ON CONFLICT DO NOTHING
  -- the right idempotency key for the webhook.
  referred_user_id   UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  referrer_user_id   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stripe coupon id. We don't dedupe on this from our side — Stripe
  -- itself enforces max_redemptions, so a coupon row here means the
  -- user CAN redeem; whether they HAVE redeemed is "did the
  -- coupon-redeemed webhook arrive."
  stripe_coupon_id   TEXT         NOT NULL,
  -- Locked shape from PHASE_3D_DESIGN.md. amount_off fixed (vs
  -- percent_off) so pricing changes don't drift the payout.
  amount_off_cents   INTEGER      NOT NULL,
  currency           TEXT         NOT NULL DEFAULT 'usd',
  expires_at         TIMESTAMPTZ  NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- redeemed_at lands when Stripe fires the coupon.redeemed (or the
  -- equivalent invoice.line_item) webhook. Until then it's NULL —
  -- caller can compute "outstanding coupons" as redeemed_at IS NULL.
  redeemed_at        TIMESTAMPTZ
);

-- Stat-page hot path: "show me my N most-recent issued coupons,
-- with redemption status" — keyed by referrer.
CREATE INDEX IF NOT EXISTS referral_coupons_referrer_idx
  ON referral_coupons (referrer_user_id, created_at DESC);

COMMENT ON TABLE referrals IS
  'Per-user share token for the referral program. Stable forever; never auto-rotates.';
COMMENT ON TABLE referral_clicks IS
  'Anonymous click telemetry for /?ref=<token> URLs. Dedupe within 24h-same-IP enforced at the route layer.';
COMMENT ON TABLE referral_coupons IS
  'One row per converted referred user. PK is referred_user_id so the checkout webhook can ON CONFLICT DO NOTHING for safe re-delivery handling.';
COMMENT ON COLUMN users.referrer_token IS
  'Set at signup from the tx_ref cookie. NULL when the user did not arrive via a referral link.';

COMMIT;
